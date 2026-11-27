/**
 * DoctorAbcService — curva ABC automatica dos medicos (SERVICES.md §30,
 * CRMLAB-188, D-328 item 9).
 *
 *  - base = VALOR DA REQUISICAO no LIS nos ultimos 12 meses (D-338; era o recebido), das requisicoes casadas ao
 *    medico por CRM + UF (D-336 item 7; antes eram as propostas `ganho`);
 *  - Pareto por tenant (`classifyAbc`): A ate 80% do acumulado, B ate 95%,
 *    C o resto e quem nao vendeu;
 *  - grava classe, base e instante no medico (o trigger de `updated_at` ignora);
 *  - `runScheduledTick`: agendador do `main.ts` (boot + 24 h). Lista os
 *    tenants com `withoutTenant()` (so ids) e calcula cada um com
 *    `withTenant()`; nunca lanca, ignora o tique se o anterior ainda roda;
 *  - `recalculate`: rota de gestor/admin, com audit.
 */
import {
  DOCTOR_ABC_CLASSES,
  DOCTOR_ABC_WINDOW_MONTHS,
  classifyAbc,
  type DoctorAbcClass,
  type DoctorAbcRecalculation,
} from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { logger } from '../lib/logger.js';
import { computeBases, listTenantsWithDoctors, saveClasses } from '../repositories/doctor-abc.repository.js';
import type { AuditService } from './audit.service.js';

export interface DoctorAbcService {
  recalculateTenant(tenantId: string, now?: Date): Promise<DoctorAbcRecalculation>;
  recalculate(ctx: TenantContext): Promise<DoctorAbcRecalculation>;
  runScheduledTick(now?: Date): Promise<void>;
}

export interface DoctorAbcServiceDeps {
  db: DbClient;
  audit: AuditService;
}

/** Inicio da janela: `now` menos 12 meses (mesmo dia do mes, em UTC). */
export function abcWindowStart(now: Date): Date {
  const start = new Date(now.getTime());
  start.setUTCMonth(start.getUTCMonth() - DOCTOR_ABC_WINDOW_MONTHS);
  return start;
}

export function createDoctorAbcService(deps: DoctorAbcServiceDeps): DoctorAbcService {
  const { db, audit } = deps;
  let tickInProgress = false;

  async function recalculateTenant(tenantId: string, now: Date = new Date()): Promise<DoctorAbcRecalculation> {
    const windowStart = abcWindowStart(now);
    const counts: Record<DoctorAbcClass, number> = { A: 0, B: 0, C: 0 };
    const total = await db.withTenant(tenantId, async (tx) => {
      const bases = await computeBases(tx, tenantId, windowStart);
      const classes = classifyAbc(bases);
      const rows = [...classes.entries()].map(([id, abcClass]) => {
        counts[abcClass] += 1;
        return { id, abcClass, base: bases.get(id) ?? 0 };
      });
      await saveClasses(tx, rows, now);
      return rows.length;
    });
    return {
      calculatedAt: now.toISOString(),
      windowStart: windowStart.toISOString(),
      doctors: total,
      counts,
    };
  }

  return {
    recalculateTenant,

    async recalculate(ctx) {
      const result = await recalculateTenant(ctx.tenantId);
      await audit.record(ctx, {
        action: 'recalculate_doctor_abc',
        entityType: 'doctor_abc',
        entityId: ctx.tenantId,
        newValues: { ...result },
      });
      return result;
    },

    async runScheduledTick(now = new Date()) {
      if (tickInProgress) return;
      tickInProgress = true;
      try {
        let tenantIds: string[];
        try {
          tenantIds = await db.withoutTenant((tx) => listTenantsWithDoctors(tx));
        } catch (err) {
          logger.warn('doctor_abc.tick_failed', {
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        for (const tenantId of tenantIds) {
          try {
            const result = await recalculateTenant(tenantId, now);
            logger.info('doctor_abc.recalculated', {
              tenantId,
              doctors: result.doctors,
              ...Object.fromEntries(DOCTOR_ABC_CLASSES.map((cls) => [cls, result.counts[cls]])),
            });
          } catch (err) {
            logger.warn('doctor_abc.tenant_failed', {
              tenantId,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } finally {
        tickInProgress = false;
      }
    },
  };
}
