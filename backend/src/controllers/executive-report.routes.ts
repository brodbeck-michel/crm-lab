/**
 * Rota do Relatório Executivo do LIS — `/api/v1/reports/executive`
 * (API_CONTRACTS.md §5c, Onda 9 — D-116). manager/admin.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { DateRange } from '../services/analytics.service.js';
import type { ExecutiveReport } from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { createAuditService } from '../services/audit.service.js';
import { createExecutiveReportService } from '../services/executive-report.service.js';
import { createThemeService } from '../services/theme.service.js';

const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
const dateParam = z.string().regex(DATE_FORMAT, 'Data deve estar no formato YYYY-MM-DD');

const executiveReportQuerySchema = z.object({
  startDate: dateParam.optional(),
  endDate: dateParam.optional(),
});

function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function executiveReportModule(deps: ApiModuleDeps): ApiModule {
  const service = createExecutiveReportService({
    db: deps.db,
    theme: createThemeService({ db: deps.db, audit: createAuditService(deps.db) }),
  });

  const router = Router();
  router.use(requireAuth(), denyPlatformOperator(), requireRoles('manager', 'admin'));

  router.get(
    '/executive',
    validate(executiveReportQuerySchema, 'query'),
    handle(async (req, res) => {
      const query = validated<DateRange>(req, 'query');
      const body: ExecutiveReport = await service.getExecutiveReport(getContext(req), query);
      res.status(200).json(body);
    }),
  );

  return { basePath: '/reports', router, requiresAuth: true };
}
