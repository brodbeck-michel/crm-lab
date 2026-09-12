/**
 * CommissionSettingsService — SERVICES.md §18 (Onda 9 — D-113). Dono das
 * colunas de comissão de `tenant_settings` (SCHEMA.md §16).
 */
import type { CommissionSettings, UpdateCommissionSettingsRequest } from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError } from '../http/errors.js';
import {
  findCommissionSettings,
  upsertCommissionSettings,
} from '../repositories/commission-settings.repository.js';
import type { AuditService } from './audit.service.js';

const MANAGER_ROLES = ['manager', 'admin'] as const;

/** Defaults validados em produção pelo FluxoLab (API_CONTRACTS.md §6b). */
export const DEFAULT_COMMISSION_SETTINGS: CommissionSettings = {
  commissionBudgetPct: 2.0,
  commissionExamsPct: 1.5,
  commissionCheckupPct: 1.5,
};

const FIELDS = ['commissionBudgetPct', 'commissionExamsPct', 'commissionCheckupPct'] as const;

export interface CommissionSettingsService {
  /** manager/admin. Defaults quando não há linha em tenant_settings. */
  get(ctx: TenantContext): Promise<CommissionSettings>;
  /** admin. Patch parcial; upsert por tenant_id. */
  update(
    ctx: TenantContext,
    dto: UpdateCommissionSettingsRequest,
  ): Promise<CommissionSettings>;
}

export interface CommissionSettingsServiceDeps {
  db: DbClient;
  audit: AuditService;
}

function assertReadRole(ctx: TenantContext): void {
  if (ctx.role !== 'manager' && ctx.role !== 'admin') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: [...MANAGER_ROLES] });
  }
}

function assertWriteRole(ctx: TenantContext): void {
  if (ctx.role !== 'admin') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: ['admin'] });
  }
}

/** `0` a `100`, até 2 casas decimais (mesma faixa de `discountPercent`, §3). */
function checkPct(raw: unknown, path: string, errors: Record<string, string>): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 100) {
    errors[path] = 'Deve ser um numero entre 0 e 100';
    return undefined;
  }
  return Math.round(raw * 100) / 100;
}

export function createCommissionSettingsService(
  deps: CommissionSettingsServiceDeps,
): CommissionSettingsService {
  const { db, audit } = deps;

  const get = async (ctx: TenantContext): Promise<CommissionSettings> => {
    assertReadRole(ctx);
    const row = await db.withTenant(ctx.tenantId, (tx) => findCommissionSettings(tx, ctx.tenantId));
    return row ?? { ...DEFAULT_COMMISSION_SETTINGS };
  };

  const update = async (
    ctx: TenantContext,
    dto: UpdateCommissionSettingsRequest,
  ): Promise<CommissionSettings> => {
    assertWriteRole(ctx);

    const raw = dto as Record<string, unknown>;
    const errors: Record<string, string> = {};

    for (const key of Object.keys(raw)) {
      if (!(FIELDS as readonly string[]).includes(key)) errors[key] = 'Campo desconhecido';
    }
    if (FIELDS.every((key) => !(key in raw))) {
      errors._root = 'Envie ao menos um campo para atualizar';
    }

    const patch: Partial<CommissionSettings> = {};
    for (const key of FIELDS) {
      if (key in raw) {
        const value = checkPct(raw[key], key, errors);
        if (value !== undefined) patch[key] = value;
      }
    }
    if (Object.keys(errors).length > 0) {
      throw new BusinessError('VALIDATION_ERROR', { fields: errors });
    }

    const saved = await db.withTenant(ctx.tenantId, async (tx) => {
      const previous =
        (await findCommissionSettings(tx, ctx.tenantId)) ?? { ...DEFAULT_COMMISSION_SETTINGS };
      const next: CommissionSettings = { ...previous, ...patch };
      await upsertCommissionSettings(tx, ctx.tenantId, next);
      return { previous, next };
    });

    const changed = FIELDS.some((key) => saved.previous[key] !== saved.next[key]);
    if (changed) {
      await audit.record(ctx, {
        action: 'update_commission_settings',
        entityType: 'tenant_settings',
        entityId: ctx.tenantId,
        oldValues: { ...saved.previous },
        newValues: { ...saved.next },
      });
    }

    return saved.next;
  };

  return { get, update };
}
