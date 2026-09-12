/**
 * Rotas de KPIs do domínio LIS — `/api/v1/lis-budgets/*` (API_CONTRACTS.md
 * §10.2, Onda 9). Todas manager/admin.
 *
 *   GET /lis-budgets                 Conferência (listagem paginada)
 *   GET /lis-budgets/summary         Resultados
 *   GET /lis-budgets/pending         Busca Ativa
 *   GET /lis-budgets/pending/summary Busca Ativa (cartões)
 *   GET /lis-budgets/filters         seletores das 3 telas
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type {
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
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import {
  createLisAnalyticsService,
  MAX_LIMIT,
  type LisAnalyticsService,
} from '../services/lis-analytics.service.js';

const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
const dateParam = z.string().regex(DATE_FORMAT, 'Data deve estar no formato YYYY-MM-DD');

const listBudgetsQuerySchema = z.object({
  startDate: dateParam.optional(),
  endDate: dateParam.optional(),
  attendantId: z.string().uuid().optional(),
  insuranceId: z.string().uuid().optional(),
  search: z.string().max(255).optional(),
  sortBy: z.enum(['issuedOn', 'number', 'totalValue']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

const summaryQuerySchema = z.object({
  startDate: dateParam.optional(),
  endDate: dateParam.optional(),
  attendantId: z.string().uuid().optional(),
  insuranceId: z.string().uuid().optional(),
});

const pendingQuerySchema = z.object({
  attendantId: z.string().uuid().optional(),
  ageBand: z.enum(LIS_BUDGET_AGE_BANDS as [string, ...string[]]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

const pendingSummaryQuerySchema = z.object({
  attendantId: z.string().uuid().optional(),
});

function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function lisAnalyticsModule(deps: ApiModuleDeps): ApiModule {
  const service: LisAnalyticsService = createLisAnalyticsService({
    db: deps.db,
    cache: deps.cache,
  });

  const router = Router();
  router.use(requireAuth(), denyPlatformOperator(), requireRoles('manager', 'admin'));

  router.get(
    '/',
    validate(listBudgetsQuerySchema, 'query'),
    handle(async (req, res) => {
      const query = validated<ListLisBudgetsQuery>(req, 'query');
      const body: ListLisBudgetsResponse = await service.list(getContext(req), query);
      res.status(200).json(body);
    }),
  );

  router.get(
    '/summary',
    validate(summaryQuerySchema, 'query'),
    handle(async (req, res) => {
      const query = validated<LisBudgetsSummaryQuery>(req, 'query');
      const body: LisBudgetsSummary = await service.getSummary(getContext(req), query);
      res.status(200).json(body);
    }),
  );

  router.get(
    '/pending/summary',
    validate(pendingSummaryQuerySchema, 'query'),
    handle(async (req, res) => {
      const query = validated<PendingLisBudgetsSummaryQuery>(req, 'query');
      const body: PendingLisBudgetsSummary = await service.getPendingSummary(
        getContext(req),
        query,
      );
      res.status(200).json(body);
    }),
  );

  router.get(
    '/pending',
    validate(pendingQuerySchema, 'query'),
    handle(async (req, res) => {
      const query = validated<ListPendingLisBudgetsQuery>(req, 'query');
      const body: ListPendingLisBudgetsResponse = await service.listPending(
        getContext(req),
        query,
      );
      res.status(200).json(body);
    }),
  );

  router.get(
    '/filters',
    handle(async (req, res) => {
      const body: LisBudgetsFilters = await service.getFilters(getContext(req));
      res.status(200).json(body);
    }),
  );

  return { basePath: '/lis-budgets', router, requiresAuth: true };
}
