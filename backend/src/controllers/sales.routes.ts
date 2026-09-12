/**
 * Rotas de vendas — `/api/v1/sales` (API_CONTRACTS.md §11, Onda 9 — D-112).
 *
 *   GET    /sales            qualquer papel de tenant (recorte por atendente no service)
 *   POST   /sales            qualquer papel de tenant
 *   DELETE /sales/:id        qualquer papel de tenant (recorte por atendente no service)
 *   GET    /sales/summary    qualquer papel de tenant
 *
 * `platform_operator` -> 403 em todas (denyPlatformOperator no router).
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type {
  CreateSaleRequest,
  ListSalesQuery,
  ListSalesResponse,
  SalesSummary,
  SalesSummaryQuery,
} from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { createAuditService } from '../services/audit.service.js';
import { createSalesService, MAX_LIMIT, type SalesService } from '../services/sales.service.js';

const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
const dateParam = z.string().regex(DATE_FORMAT, 'Data deve estar no formato YYYY-MM-DD');

const listSalesQuerySchema = z.object({
  startDate: dateParam.optional(),
  endDate: dateParam.optional(),
  attendantId: z.string().uuid().optional(),
  kind: z.enum(['exams', 'checkup']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

const createSaleSchema = z.object({
  attendantId: z.string().uuid().optional(),
  soldOn: dateParam,
  code: z.string().trim().max(50).optional(),
  value: z.number().positive(),
  exams: z.string().trim().max(2000).optional(),
  kind: z.enum(['exams', 'checkup']),
});

const salesSummaryQuerySchema = z.object({
  startDate: dateParam.optional(),
  endDate: dateParam.optional(),
  attendantId: z.string().uuid().optional(),
});

const saleIdParamSchema = z.object({ id: z.string().uuid() });

function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function salesModule(deps: ApiModuleDeps): ApiModule {
  const service: SalesService = createSalesService({
    db: deps.db,
    audit: createAuditService(deps.db),
  });

  const router = Router();
  router.use(requireAuth(), denyPlatformOperator());

  router.get(
    '/',
    validate(listSalesQuerySchema, 'query'),
    handle(async (req, res) => {
      const query = validated<ListSalesQuery>(req, 'query');
      const body: ListSalesResponse = await service.list(getContext(req), query);
      res.status(200).json(body);
    }),
  );

  router.post(
    '/',
    validate(createSaleSchema, 'body'),
    handle(async (req, res) => {
      const dto = validated<CreateSaleRequest>(req, 'body');
      const sale = await service.create(getContext(req), dto);
      res.status(201).json(sale);
    }),
  );

  router.get(
    '/summary',
    validate(salesSummaryQuerySchema, 'query'),
    handle(async (req, res) => {
      const query = validated<SalesSummaryQuery>(req, 'query');
      const body: SalesSummary = await service.getSummary(getContext(req), query);
      res.status(200).json(body);
    }),
  );

  router.delete(
    '/:id',
    validate(saleIdParamSchema, 'params'),
    handle(async (req, res) => {
      const { id } = validated<{ id: string }>(req, 'params');
      await service.remove(getContext(req), id);
      res.status(204).send();
    }),
  );

  return { basePath: '/sales', router, requiresAuth: true };
}
