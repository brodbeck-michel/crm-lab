/**
 * InsuranceService — SERVICES.md §15 (Onda 7, D-081/D-082).
 *
 * Dono da tabela `insurances`. **Nao tem metodo de preco** —
 * `listPrices`/`upsertPrices` (dono de `exam_prices`) e a resolucao de preco
 * por convenio vivem no `ExamCatalogService` (§5), porque preco e dado do
 * catalogo, nao do convenio.
 *
 * "Particular" NUNCA e uma linha desta tabela (D-082): e a AUSENCIA de
 * convenio (`insuranceId: null` em `POST /proposals`).
 */
import type {
  CreateInsuranceRequest,
  Insurance,
  ListInsurancesQuery,
  ListInsurancesResponse,
  UpdateInsuranceRequest,
} from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError, notFound } from '../http/errors.js';
import {
  InsuranceRepository,
  isInsuranceSortBy,
  isUniqueViolation,
  type InsuranceListCriteria,
  type InsuranceSortBy,
  type SortOrder,
} from '../repositories/insurance.repository.js';
import type { AuditService } from './audit.service.js';

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const DEFAULT_SORT_BY: InsuranceSortBy = 'name';
export const DEFAULT_ORDER: SortOrder = 'asc';

/**
 * Teto de `page` (mesmo padrao de `/patients` e `/proposals`). Pagina acima do
 * teto devolve lista vazia, nao erro — o clamp deixa o OFFSET absurdo cair
 * naturalmente fora do que existe.
 */
export const MAX_PAGE = 10_000;

export interface InsuranceService {
  list(ctx: TenantContext, query: ListInsurancesQuery): Promise<ListInsurancesResponse>;
  getById(ctx: TenantContext, id: string): Promise<Insurance>;
  create(ctx: TenantContext, dto: CreateInsuranceRequest): Promise<Insurance>;
  update(ctx: TenantContext, id: string, dto: UpdateInsuranceRequest): Promise<Insurance>;
}

export interface InsuranceServiceDeps {
  db: DbClient;
  audit: AuditService;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

const MANAGER_ROLES = ['manager', 'admin'] as const;

/** "A UI esconde, o servidor recusa" — a rota ja barra, o service confere de novo. */
function assertCanWrite(ctx: TenantContext): void {
  if (ctx.role !== 'manager' && ctx.role !== 'admin') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: [...MANAGER_ROLES] });
  }
}

function toCriteria(query: ListInsurancesQuery): InsuranceListCriteria {
  const sortBy =
    query.sortBy !== undefined && isInsuranceSortBy(query.sortBy)
      ? (query.sortBy as InsuranceSortBy)
      : DEFAULT_SORT_BY;
  const search = query.search?.trim();
  return {
    active: query.active,
    search: search !== undefined && search.length > 0 ? search : undefined,
    page: clampInt(query.page, DEFAULT_PAGE, 1, MAX_PAGE),
    limit: clampInt(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
    sortBy,
    order: query.order === 'desc' ? 'desc' : DEFAULT_ORDER,
  };
}

function conflictOnName(name: string): BusinessError {
  return new BusinessError('CONFLICT', { field: 'name', name });
}

export function createInsuranceService(deps: InsuranceServiceDeps): InsuranceService {
  const repository = new InsuranceRepository(deps.db);
  const audit = deps.audit;

  return {
    async list(ctx: TenantContext, query: ListInsurancesQuery): Promise<ListInsurancesResponse> {
      const criteria = toCriteria(query);
      const page = await repository.list(ctx.tenantId, criteria);
      return {
        insurances: page.rows,
        pagination: {
          page: criteria.page,
          limit: criteria.limit,
          total: page.total,
          totalPages: page.total === 0 ? 0 : Math.ceil(page.total / criteria.limit),
        },
      };
    },

    /** Inexistente ou de outro tenant -> `NOT_FOUND` (nunca `FORBIDDEN`). */
    async getById(ctx: TenantContext, id: string): Promise<Insurance> {
      const insurance = await repository.findById(ctx.tenantId, id);
      if (!insurance) throw notFound({ resource: 'insurance', id });
      return insurance;
    },

    /** manager/admin. `name` duplicado no tenant -> CONFLICT. */
    async create(ctx: TenantContext, dto: CreateInsuranceRequest): Promise<Insurance> {
      assertCanWrite(ctx);
      const name = dto.name.trim();

      if (await repository.nameExists(ctx.tenantId, name)) {
        throw conflictOnName(name);
      }

      let created: Insurance;
      try {
        created = await repository.insert(ctx.tenantId, {
          name,
          officialName: dto.officialName?.trim() ?? null,
          ansCode: dto.ansCode?.trim() ?? null,
          type: dto.type,
        });
      } catch (err) {
        // Corrida entre o SELECT acima e o INSERT: o indice unico decide.
        if (isUniqueViolation(err)) throw conflictOnName(name);
        throw err;
      }

      await audit.record(ctx, {
        action: 'create_insurance',
        entityType: 'insurance',
        entityId: created.id,
        newValues: {
          name: created.name,
          officialName: created.officialName,
          ansCode: created.ansCode,
          type: created.type,
        },
      });

      return created;
    },

    /**
     * manager/admin. Id de outro tenant -> `NOT_FOUND` (o RLS ja escondeu a
     * linha; vazar `FORBIDDEN` confirmaria a existencia — CLAUDE.md regra 8).
     *
     * `isActive:false` e o unico "delete" do convenio.
     */
    async update(
      ctx: TenantContext,
      id: string,
      dto: UpdateInsuranceRequest,
    ): Promise<Insurance> {
      assertCanWrite(ctx);

      const current = await repository.findById(ctx.tenantId, id);
      if (!current) throw notFound({ resource: 'insurance', id });

      const name = dto.name !== undefined ? dto.name.trim() : undefined;
      if (name !== undefined && name !== current.name && (await repository.nameExists(ctx.tenantId, name))) {
        throw conflictOnName(name);
      }

      const oldValues: Record<string, unknown> = {};
      const newValues: Record<string, unknown> = {};
      for (const [key, value] of Object.entries({
        name,
        officialName: dto.officialName,
        ansCode: dto.ansCode,
        type: dto.type,
        isActive: dto.isActive,
      })) {
        if (value === undefined) continue;
        const previous = (current as unknown as Record<string, unknown>)[key];
        if (previous !== value) {
          oldValues[key] = previous;
          newValues[key] = value;
        }
      }

      let updated: Insurance | null;
      try {
        updated = await repository.update(ctx.tenantId, id, {
          ...(name !== undefined ? { name } : {}),
          ...(dto.officialName !== undefined ? { officialName: dto.officialName } : {}),
          ...(dto.ansCode !== undefined ? { ansCode: dto.ansCode } : {}),
          ...(dto.type !== undefined ? { type: dto.type } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        });
      } catch (err) {
        // Corrida de renomeio: o indice unico decide.
        if (isUniqueViolation(err)) throw conflictOnName(name ?? current.name);
        throw err;
      }

      if (!updated) throw notFound({ resource: 'insurance', id });

      if (Object.keys(newValues).length > 0) {
        await audit.record(ctx, {
          action: 'update_insurance',
          entityType: 'insurance',
          entityId: id,
          oldValues,
          newValues,
        });
      }

      return updated;
    },
  };
}
