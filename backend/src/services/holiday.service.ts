/**
 * HolidayService — feriados do laboratorio. SERVICES.md §29 (CRMLAB-62,
 * D-213). Dono de `tenant_holidays` (SCHEMA.md §34).
 *
 * O `GET` devolve os nacionais do ano (calculados em `shared/`, so leitura)
 * junto com os cadastrados. Incluir e remover: gestor e admin, com audit.
 */
import {
  HOLIDAY_DESCRIPTION_MAX,
  nationalHolidays,
  type CreateHolidayRequest,
  type Holiday,
  type HolidaysResponse,
} from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError, notFound } from '../http/errors.js';
import * as repo from '../repositories/holiday.repository.js';
import type { AuditService } from './audit.service.js';

const TENANT_ROLES = ['attendant', 'manager', 'admin'] as const;
const WRITE_ROLES = ['manager', 'admin'] as const;

const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function assertRole(ctx: TenantContext, roles: readonly string[]): void {
  if (!roles.includes(ctx.role)) {
    throw new BusinessError('FORBIDDEN', { requiredRoles: [...roles] });
  }
}

/** `YYYY-MM-DD` de um dia que existe no calendario, entre 2000 e 2100. */
function isValidDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Ano do filtro: ausente = ano corrente; fora de 2000..2100 = erro. */
export function parseYear(raw: unknown, now: Date = new Date()): number {
  if (raw === undefined || raw === '') return now.getUTCFullYear();
  const year = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof year !== 'number' || !Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    throw new BusinessError('VALIDATION_ERROR', {
      fields: { year: `Informe um ano de ${MIN_YEAR} a ${MAX_YEAR}` },
    });
  }
  return year;
}

function validateCreate(raw: unknown): CreateHolidayRequest {
  const body = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const fields: Record<string, string> = {};
  const date = typeof body.date === 'string' ? body.date.trim() : '';
  if (!isValidDate(date)) fields.date = 'Informe uma data válida (AAAA-MM-DD)';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (description.length === 0 || description.length > HOLIDAY_DESCRIPTION_MAX) {
    fields.description = `A descrição deve ter de 1 a ${HOLIDAY_DESCRIPTION_MAX} caracteres`;
  }
  if (Object.keys(fields).length > 0) throw new BusinessError('VALIDATION_ERROR', { fields });
  return { date, description };
}

export interface HolidayService {
  list(ctx: TenantContext, year: number): Promise<HolidaysResponse>;
  create(ctx: TenantContext, dto: unknown): Promise<Holiday>;
  remove(ctx: TenantContext, id: string): Promise<void>;
}

export interface HolidayServiceDeps {
  db: DbClient;
  audit: AuditService;
}

export function createHolidayService(deps: HolidayServiceDeps): HolidayService {
  const { db, audit } = deps;

  return {
    async list(ctx, year) {
      assertRole(ctx, TENANT_ROLES);
      const custom = await db.withTenant(ctx.tenantId, (tx) => repo.listByYear(tx, ctx.tenantId, year));
      return { year, national: nationalHolidays(year), custom };
    },

    async create(ctx, dto) {
      assertRole(ctx, WRITE_ROLES);
      const input = validateCreate(dto);
      const created = await db.withTenant(ctx.tenantId, (tx) =>
        repo.insert(tx, { tenantId: ctx.tenantId, ...input, createdBy: ctx.userId }),
      );
      if (created === null) {
        throw new BusinessError('CONFLICT', { fields: { date: 'Já existe um feriado nesta data' } });
      }
      await audit.record(ctx, {
        action: 'create_holiday',
        entityType: 'holiday',
        entityId: created.id ?? '',
        newValues: { date: created.date, description: created.description },
      });
      return created;
    },

    async remove(ctx, id) {
      assertRole(ctx, WRITE_ROLES);
      const removed = await db.withTenant(ctx.tenantId, (tx) => repo.remove(tx, ctx.tenantId, id));
      if (removed === null) throw notFound({ resource: 'holiday', id });
      await audit.record(ctx, {
        action: 'delete_holiday',
        entityType: 'holiday',
        entityId: id,
        oldValues: { date: removed.date, description: removed.description },
      });
    },
  };
}
