/**
 * LisAnalyticsService — SERVICES.md §20 (Onda 9). Só leitura, como
 * `AnalyticsService` (§9) e `OperationService` (§14). Repositório
 * `lis-analytics.repository.ts` concentra o SQL.
 */
import type {
  LisBudgetAgeBand,
  LisBudgetsFilters,
  LisBudgetsSummary,
  LisBudgetsSummaryQuery,
  ListLisBudgetsQuery,
  ListLisBudgetsResponse,
  ListPendingLisBudgetsQuery,
  ListPendingLisBudgetsResponse,
  PendingLisBudgetsSummary,
  PendingLisBudgetsSummaryQuery,
} from '@crm-lab/shared';
import { LIS_BUDGET_AGE_BANDS } from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError } from '../http/errors.js';
import type { CacheService } from '../lib/cache.js';
import { average, percent, resolvePeriod, toMoney } from './analytics.service.js';
import * as lisAnalyticsRepo from '../repositories/lis-analytics.repository.js';

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const MAX_PAGE = 10_000;

/** Amostra mínima para rankings qualitativos (BUSINESS_RULES.md §11.5). */
export const MIN_ORC_RANKING = 20;

/** TTL do cache de KPIs do LIS — mesmo valor de `AnalyticsService` (§9/§20). */
export const LIS_ANALYTICS_CACHE_TTL_SECONDS = 300;

export const cachePrefix = (tenantId: string): string => `lis:${tenantId}:`;

const MANAGER_ROLES = ['manager', 'admin'] as const;

export interface LisAnalyticsService {
  list(ctx: TenantContext, query: ListLisBudgetsQuery): Promise<ListLisBudgetsResponse>;
  getSummary(ctx: TenantContext, query: LisBudgetsSummaryQuery): Promise<LisBudgetsSummary>;
  listPending(
    ctx: TenantContext,
    query: ListPendingLisBudgetsQuery,
  ): Promise<ListPendingLisBudgetsResponse>;
  getPendingSummary(
    ctx: TenantContext,
    query: PendingLisBudgetsSummaryQuery,
  ): Promise<PendingLisBudgetsSummary>;
  getFilters(ctx: TenantContext): Promise<LisBudgetsFilters>;
}

export interface LisAnalyticsServiceDeps {
  db: DbClient;
  cache: CacheService;
  now?: () => Date;
}

function assertManagerOrAdmin(ctx: TenantContext): void {
  if (ctx.role !== 'manager' && ctx.role !== 'admin') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: [...MANAGER_ROLES] });
  }
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function isAgeBand(value: string | undefined): value is LisBudgetAgeBand {
  return value !== undefined && (LIS_BUDGET_AGE_BANDS as readonly string[]).includes(value);
}

export function createLisAnalyticsService(deps: LisAnalyticsServiceDeps): LisAnalyticsService {
  const { db, cache } = deps;
  const now = deps.now ?? ((): Date => new Date());

  const cached = async <T>(key: string, compute: () => Promise<T>): Promise<T> => {
    const hit = await cache.get<T>(key);
    if (hit) return hit;
    const value = await compute();
    await cache.set(key, value, LIS_ANALYTICS_CACHE_TTL_SECONDS);
    return value;
  };

  return {
    async list(ctx: TenantContext, query: ListLisBudgetsQuery): Promise<ListLisBudgetsResponse> {
      assertManagerOrAdmin(ctx);
      const period = resolvePeriod(
        { startDate: query.startDate, endDate: query.endDate },
        now(),
      );
      const criteria: lisAnalyticsRepo.BudgetListCriteria = {
        startDate: period.startDate,
        endDate: period.endDate,
        ...(query.attendantId !== undefined ? { attendantId: query.attendantId } : {}),
        ...(query.insuranceId !== undefined ? { insuranceId: query.insuranceId } : {}),
        ...(query.search !== undefined && query.search.trim().length > 0
          ? { search: query.search.trim() }
          : {}),
        sortBy: query.sortBy ?? 'issuedOn',
        order: query.order ?? 'desc',
        page: clampInt(query.page, DEFAULT_PAGE, 1, MAX_PAGE),
        limit: clampInt(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
      };
      const page = await db.withTenant(ctx.tenantId, (tx) =>
        lisAnalyticsRepo.listBudgets(tx, ctx.tenantId, criteria),
      );
      return {
        budgets: page.rows,
        pagination: {
          page: criteria.page,
          limit: criteria.limit,
          total: page.total,
          totalPages: page.total === 0 ? 0 : Math.ceil(page.total / criteria.limit),
        },
      };
    },

    async getSummary(
      ctx: TenantContext,
      query: LisBudgetsSummaryQuery,
    ): Promise<LisBudgetsSummary> {
      assertManagerOrAdmin(ctx);
      const period = resolvePeriod(
        { startDate: query.startDate, endDate: query.endDate },
        now(),
      );
      const filters: lisAnalyticsRepo.SummaryFilters = {
        startDate: period.startDate,
        endDate: period.endDate,
        ...(query.attendantId !== undefined ? { attendantId: query.attendantId } : {}),
        ...(query.insuranceId !== undefined ? { insuranceId: query.insuranceId } : {}),
      };

      const key = `${cachePrefix(ctx.tenantId)}summary:${period.startDate}:${period.endDate}:${filters.attendantId ?? '-'}:${filters.insuranceId ?? '-'}`;
      return cached(key, async () => {
        const { issued, paid, byAttendant, byInsurance } = await db.withTenant(
          ctx.tenantId,
          async (tx) => {
            const [issuedTotals, paidTotals, attendantAgg, insuranceAgg] = await Promise.all([
              lisAnalyticsRepo.getIssuedTotals(tx, ctx.tenantId, filters),
              lisAnalyticsRepo.getPaidTotals(tx, ctx.tenantId, filters),
              lisAnalyticsRepo.getAttendantAgg(tx, ctx.tenantId, filters),
              lisAnalyticsRepo.getInsuranceAgg(tx, ctx.tenantId, filters),
            ]);
            return {
              issued: issuedTotals,
              paid: paidTotals,
              byAttendant: attendantAgg,
              byInsurance: insuranceAgg,
            };
          },
        );

        const qualifies = issued.count >= MIN_ORC_RANKING;
        return {
          period: { startDate: period.startDate, endDate: period.endDate },
          issued: {
            count: issued.count,
            totalValue: toMoney(issued.totalValue),
            averageTicket: average(issued.totalValue, issued.count),
          },
          paid: {
            count: paid.count,
            totalValue: toMoney(paid.totalValue),
            averageTicket: average(paid.totalValue, paid.count),
            // Capado em 100% (BUSINESS_RULES.md §11.5): duas requisicoes de
            // periodos de emissao diferentes podem ser pagas no mesmo mes.
            conversionQty: Math.min(100, percent(paid.count, issued.count)),
          },
          byAttendant: qualifies
            ? [...byAttendant].sort((a, b) => b.paidValue - a.paidValue).slice(0, 6)
            : [],
          byInsurance: qualifies ? byInsurance : [],
        };
      });
    },

    async listPending(
      ctx: TenantContext,
      query: ListPendingLisBudgetsQuery,
    ): Promise<ListPendingLisBudgetsResponse> {
      assertManagerOrAdmin(ctx);
      if (query.ageBand !== undefined && !isAgeBand(query.ageBand)) {
        throw new BusinessError('VALIDATION_ERROR', {
          fields: { ageBand: `Deve ser um de: ${LIS_BUDGET_AGE_BANDS.join(', ')}` },
        });
      }
      const criteria: lisAnalyticsRepo.PendingListCriteria = {
        ...(query.attendantId !== undefined ? { attendantId: query.attendantId } : {}),
        ...(query.ageBand !== undefined ? { ageBand: query.ageBand } : {}),
        page: clampInt(query.page, DEFAULT_PAGE, 1, MAX_PAGE),
        limit: clampInt(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
      };
      const page = await db.withTenant(ctx.tenantId, (tx) =>
        lisAnalyticsRepo.listPendingBudgets(tx, ctx.tenantId, criteria),
      );
      return {
        budgets: page.rows,
        pagination: {
          page: criteria.page,
          limit: criteria.limit,
          total: page.total,
          totalPages: page.total === 0 ? 0 : Math.ceil(page.total / criteria.limit),
        },
      };
    },

    async getPendingSummary(
      ctx: TenantContext,
      query: PendingLisBudgetsSummaryQuery,
    ): Promise<PendingLisBudgetsSummary> {
      assertManagerOrAdmin(ctx);
      return db.withTenant(ctx.tenantId, (tx) =>
        lisAnalyticsRepo.getPendingSummary(tx, ctx.tenantId, query.attendantId),
      );
    },

    async getFilters(ctx: TenantContext): Promise<LisBudgetsFilters> {
      assertManagerOrAdmin(ctx);
      return db.withTenant(ctx.tenantId, (tx) => lisAnalyticsRepo.getFilters(tx, ctx.tenantId));
    },
  };
}
