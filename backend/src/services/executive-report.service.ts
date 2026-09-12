/**
 * ExecutiveReportService — SERVICES.md §23 (Onda 9 — D-116). Só leitura: o
 * JSON que alimenta `GET /reports/executive` e os PDFs gerados no cliente.
 */
import type { ExecutiveReport } from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError } from '../http/errors.js';
import { findById as findTenant } from '../repositories/tenant.repository.js';
import * as lisAnalyticsRepo from '../repositories/lis-analytics.repository.js';
import { average, percent, resolvePeriod, toMoney, type DateRange } from './analytics.service.js';
import { MIN_ORC_RANKING } from './lis-analytics.service.js';
import type { ThemeService } from './theme.service.js';

const MANAGER_ROLES = ['manager', 'admin'] as const;

export interface ExecutiveReportService {
  getExecutiveReport(ctx: TenantContext, period: DateRange): Promise<ExecutiveReport>;
}

export interface ExecutiveReportServiceDeps {
  db: DbClient;
  theme: ThemeService;
  now?: () => Date;
}

function assertManagerOrAdmin(ctx: TenantContext): void {
  if (ctx.role !== 'manager' && ctx.role !== 'admin') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: [...MANAGER_ROLES] });
  }
}

export function createExecutiveReportService(
  deps: ExecutiveReportServiceDeps,
): ExecutiveReportService {
  const { db, theme } = deps;
  const now = deps.now ?? ((): Date => new Date());

  return {
    async getExecutiveReport(ctx: TenantContext, range: DateRange): Promise<ExecutiveReport> {
      assertManagerOrAdmin(ctx);
      const period = resolvePeriod(range, now());
      const filters: lisAnalyticsRepo.SummaryFilters = {
        startDate: period.startDate,
        endDate: period.endDate,
      };

      const [data, currentTheme, tenant] = await Promise.all([
        db.withTenant(ctx.tenantId, async (tx) => {
          const [issued, paid, byAttendant, byInsurance, monthlySeries] = await Promise.all([
            lisAnalyticsRepo.getIssuedTotals(tx, ctx.tenantId, filters),
            lisAnalyticsRepo.getPaidTotals(tx, ctx.tenantId, filters),
            lisAnalyticsRepo.getAttendantAgg(tx, ctx.tenantId, filters),
            lisAnalyticsRepo.getInsuranceAgg(tx, ctx.tenantId, filters),
            lisAnalyticsRepo.getMonthlySeries(tx, ctx.tenantId, period.endDate),
          ]);
          return { issued, paid, byAttendant, byInsurance, monthlySeries };
        }),
        theme.getCurrent(ctx.tenantId),
        db.withTenant(ctx.tenantId, (tx) => findTenant(tx, ctx.tenantId)),
      ]);

      const qualifies = data.issued.count >= MIN_ORC_RANKING;

      return {
        period: { startDate: period.startDate, endDate: period.endDate },
        issued: {
          count: data.issued.count,
          totalValue: toMoney(data.issued.totalValue),
          averageTicket: average(data.issued.totalValue, data.issued.count),
        },
        paid: {
          count: data.paid.count,
          totalValue: toMoney(data.paid.totalValue),
          averageTicket: average(data.paid.totalValue, data.paid.count),
          // Capado em 100% (BUSINESS_RULES.md §11.5) — mesma regra de LisAnalyticsService.
          conversionQty: Math.min(100, percent(data.paid.count, data.issued.count)),
        },
        monthlySeries: data.monthlySeries,
        byAttendant: qualifies
          ? [...data.byAttendant].sort((a, b) => b.paidValue - a.paidValue).slice(0, 6)
          : [],
        byInsurance: qualifies ? data.byInsurance : [],
        // D-116: nunca "Santé" fixo — cai no nome/logo do proprio tenant quando
        // o tema nao foi personalizado.
        brandName: currentTheme.brandName ?? tenant?.name ?? 'Laboratorio',
        logoUrl: currentTheme.logoUrl ?? tenant?.logoUrl ?? null,
      };
    },
  };
}
