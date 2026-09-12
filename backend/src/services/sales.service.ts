/**
 * SalesService — SERVICES.md §21 (Onda 9 — D-112). Dono de `sales` (SCHEMA.md
 * §27).
 */
import type {
  CreateSaleRequest,
  Sale,
  SaleKind,
  SalesAttendantSummary,
  SalesSummary,
  SalesSummaryQuery,
  ListSalesQuery,
  ListSalesResponse,
} from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError, notFound } from '../http/errors.js';
import { AttendantRepository, findAttendantIdByUserId } from '../repositories/attendant.repository.js';
import { findCommissionSettings } from '../repositories/commission-settings.repository.js';
import * as salesRepo from '../repositories/sales.repository.js';
import type { AuditService } from './audit.service.js';
import { DEFAULT_COMMISSION_SETTINGS } from './commission-settings.service.js';
import { resolvePeriod, toMoney } from './analytics.service.js';

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const MAX_PAGE = 10_000;

const SALE_KINDS: readonly SaleKind[] = ['exams', 'checkup'];

export interface SalesService {
  list(ctx: TenantContext, query: ListSalesQuery): Promise<ListSalesResponse>;
  create(ctx: TenantContext, dto: CreateSaleRequest): Promise<Sale>;
  remove(ctx: TenantContext, id: string): Promise<void>;
  getSummary(ctx: TenantContext, query: SalesSummaryQuery): Promise<SalesSummary>;
}

export interface SalesServiceDeps {
  db: DbClient;
  audit: AuditService;
  now?: () => Date;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function assertNotPlatformOperator(ctx: TenantContext): void {
  if (ctx.role === 'platform_operator') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: ['attendant', 'manager', 'admin'] });
  }
}

const SOLD_ON_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function createSalesService(deps: SalesServiceDeps): SalesService {
  const { db, audit } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const attendants = new AttendantRepository(db);

  /**
   * Atendente do escopo do request (D-112): `attendant` resolve pelo próprio
   * vínculo (`attendants.user_id = ctx.userId`) — `null` se não ligado; `manager`/
   * `admin` não têm um "próprio atendente" (retorna `undefined`, sem recorte).
   */
  async function ownAttendantId(ctx: TenantContext): Promise<string | null | undefined> {
    if (ctx.role !== 'attendant') return undefined;
    return db.withTenant(ctx.tenantId, (tx) => findAttendantIdByUserId(tx, ctx.tenantId, ctx.userId));
  }

  return {
    async list(ctx: TenantContext, query: ListSalesQuery): Promise<ListSalesResponse> {
      assertNotPlatformOperator(ctx);
      const own = await ownAttendantId(ctx);

      if (own !== undefined && own === null) {
        // Attendant sem vinculo: lista vazia, nunca erro (API_CONTRACTS.md §11).
        const limit = clampInt(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
        return {
          sales: [],
          pagination: { page: 1, limit, total: 0, totalPages: 0 },
        };
      }

      const criteria: salesRepo.SalesListCriteria = {
        ...(query.startDate !== undefined ? { startDate: query.startDate } : {}),
        ...(query.endDate !== undefined ? { endDate: query.endDate } : {}),
        // `attendantId` da query e ignorado para attendant (D-112): sempre a propria.
        ...(own !== undefined
          ? { attendantId: own }
          : query.attendantId !== undefined
            ? { attendantId: query.attendantId }
            : {}),
        ...(query.kind !== undefined ? { kind: query.kind } : {}),
        page: clampInt(query.page, DEFAULT_PAGE, 1, MAX_PAGE),
        limit: clampInt(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
      };

      const page = await db.withTenant(ctx.tenantId, (tx) =>
        salesRepo.list(tx, ctx.tenantId, criteria),
      );
      return {
        sales: page.rows,
        pagination: {
          page: criteria.page,
          limit: criteria.limit,
          total: page.total,
          totalPages: page.total === 0 ? 0 : Math.ceil(page.total / criteria.limit),
        },
      };
    },

    async create(ctx: TenantContext, dto: CreateSaleRequest): Promise<Sale> {
      assertNotPlatformOperator(ctx);

      const errors: Record<string, string> = {};
      if (typeof dto.soldOn !== 'string' || !SOLD_ON_PATTERN.test(dto.soldOn)) {
        errors.soldOn = 'Data deve estar no formato YYYY-MM-DD';
      } else if (dto.soldOn > now().toISOString().slice(0, 10)) {
        errors.soldOn = 'Nao pode ser uma data futura';
      }
      if (typeof dto.value !== 'number' || !Number.isFinite(dto.value) || dto.value <= 0) {
        errors.value = 'Deve ser um numero maior que zero';
      }
      if (dto.code !== undefined && dto.code.length > 50) {
        errors.code = 'Maximo de 50 caracteres';
      }
      if (dto.exams !== undefined && dto.exams.length > 2000) {
        errors.exams = 'Maximo de 2000 caracteres';
      }
      if (!(SALE_KINDS as readonly string[]).includes(dto.kind)) {
        errors.kind = `Deve ser um de: ${SALE_KINDS.join(', ')}`;
      }

      let attendantId: string;
      const own = await ownAttendantId(ctx);
      if (own !== undefined) {
        // attendant: attendantId enviado diferente do proprio nao e permitido.
        if (own === null) throw new BusinessError('SALE_ATTENDANT_NOT_LINKED');
        if (dto.attendantId !== undefined && dto.attendantId !== own) {
          errors.attendantId = 'Nao e permitido lancar venda em nome de outro atendente';
        }
        attendantId = own;
      } else {
        if (dto.attendantId === undefined) {
          errors.attendantId = 'Obrigatorio para manager/admin';
        }
        attendantId = dto.attendantId ?? '';
      }

      if (Object.keys(errors).length > 0) {
        throw new BusinessError('VALIDATION_ERROR', { fields: errors });
      }

      if (own === undefined) {
        const attendant = await attendants.findById(ctx.tenantId, attendantId);
        if (!attendant) throw notFound({ resource: 'attendant', id: attendantId });
      }

      const created = await db.withTenant(ctx.tenantId, (tx) =>
        salesRepo.insert(tx, ctx.tenantId, {
          attendantId,
          soldOn: dto.soldOn,
          code: dto.code ?? null,
          value: dto.value,
          exams: dto.exams ?? null,
          kind: dto.kind,
          createdBy: ctx.userId,
        }),
      );

      await audit.record(ctx, {
        action: 'create_sale',
        entityType: 'sale',
        entityId: created.id,
        newValues: {
          attendantId: created.attendantId,
          soldOn: created.soldOn,
          value: created.value,
          kind: created.kind,
        },
      });

      return created;
    },

    async remove(ctx: TenantContext, id: string): Promise<void> {
      assertNotPlatformOperator(ctx);
      const own = await ownAttendantId(ctx);
      if (own !== undefined && own === null) throw notFound({ resource: 'sale', id });

      const existing = await db.withTenant(ctx.tenantId, async (tx) => {
        // `existsForScope` filtra tenant + (se attendant) o proprio attendant_id
        // (D-112: venda de outro atendente e NOT_FOUND, nunca FORBIDDEN).
        const belongs = await salesRepo.existsForScope(tx, ctx.tenantId, id, own ?? undefined);
        if (!belongs) return null;
        const sale = await salesRepo.findById(tx, id);
        if (sale) await salesRepo.remove(tx, ctx.tenantId, id);
        return sale;
      });
      if (!existing) throw notFound({ resource: 'sale', id });

      await audit.record(ctx, {
        action: 'delete_sale',
        entityType: 'sale',
        entityId: id,
        oldValues: {
          attendantId: existing.attendantId,
          soldOn: existing.soldOn,
          value: existing.value,
          kind: existing.kind,
        },
      });
    },

    async getSummary(ctx: TenantContext, query: SalesSummaryQuery): Promise<SalesSummary> {
      assertNotPlatformOperator(ctx);
      const period = resolvePeriod(
        { startDate: query.startDate, endDate: query.endDate },
        now(),
      );

      const own = await ownAttendantId(ctx);
      const emptySummary = (): SalesSummary => ({
        period: { startDate: period.startDate, endDate: period.endDate },
        byKind: {
          exams: { count: 0, value: 0, commissionValue: 0 },
          checkup: { count: 0, value: 0, commissionValue: 0 },
        },
        totalValue: 0,
        commissionTotal: 0,
      });

      if (own !== undefined && own === null) return emptySummary();

      const attendantId = own ?? query.attendantId;
      // D-122: detalhe por atendente só faz sentido pra visão do tenant inteiro
      // (manager/admin) — attendant nunca vê a lista de outros atendentes.
      const wantsByAttendant = own === undefined;

      const { rows, byAttendantRows, commission } = await db.withTenant(ctx.tenantId, async (tx) => ({
        rows: await salesRepo.summarizeByKind(
          tx,
          ctx.tenantId,
          period.startDate,
          period.endDate,
          attendantId,
        ),
        byAttendantRows: wantsByAttendant
          ? await salesRepo.summarizeByAttendantAndKind(tx, ctx.tenantId, period.startDate, period.endDate)
          : [],
        commission: (await findCommissionSettings(tx, ctx.tenantId)) ?? DEFAULT_COMMISSION_SETTINGS,
      }));

      const summary = emptySummary();
      const pctByKind: Record<SaleKind, number> = {
        exams: commission.commissionExamsPct,
        checkup: commission.commissionCheckupPct,
      };

      for (const row of rows) {
        if (row.kind !== 'exams' && row.kind !== 'checkup') continue;
        const commissionValue = toMoney((row.value * pctByKind[row.kind]) / 100);
        summary.byKind[row.kind] = { count: row.count, value: row.value, commissionValue };
      }
      summary.totalValue = toMoney(summary.byKind.exams.value + summary.byKind.checkup.value);
      summary.commissionTotal = toMoney(
        summary.byKind.exams.commissionValue + summary.byKind.checkup.commissionValue,
      );

      if (wantsByAttendant) {
        const byAttendantMap = new Map<string, SalesAttendantSummary>();
        for (const row of byAttendantRows) {
          if (row.kind !== 'exams' && row.kind !== 'checkup') continue;
          const existing = byAttendantMap.get(row.attendantId) ?? {
            attendantId: row.attendantId,
            attendantName: row.attendantName,
            byKind: {
              exams: { count: 0, value: 0, commissionValue: 0 },
              checkup: { count: 0, value: 0, commissionValue: 0 },
            },
            totalValue: 0,
            commissionTotal: 0,
          };
          const commissionValue = toMoney((row.value * pctByKind[row.kind]) / 100);
          existing.byKind[row.kind] = { count: row.count, value: row.value, commissionValue };
          byAttendantMap.set(row.attendantId, existing);
        }
        summary.byAttendant = [...byAttendantMap.values()].map((entry) => ({
          ...entry,
          totalValue: toMoney(entry.byKind.exams.value + entry.byKind.checkup.value),
          commissionTotal: toMoney(
            entry.byKind.exams.commissionValue + entry.byKind.checkup.commissionValue,
          ),
        }));
      }

      return summary;
    },
  };
}
