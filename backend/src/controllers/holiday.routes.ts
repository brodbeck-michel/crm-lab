/**
 * Rotas dos feriados — `/api/v1/settings/holidays`
 * (API_CONTRACTS.md §6d, CRMLAB-62 — D-213).
 *
 *   GET    /settings/holidays?year=AAAA   attendant/manager/admin
 *   POST   /settings/holidays             manager/admin
 *   DELETE /settings/holidays/:id         manager/admin
 *
 * A validacao do corpo mora no service, como em `funnel-rules.routes.ts`.
 *
 * `businessCalendarModule` (CRMLAB-84, D-254 — API_CONTRACTS.md §6e):
 *
 *   GET    /settings/business-calendar    attendant/manager/admin
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { createAuditService } from '../services/audit.service.js';
import { createHolidayService, parseYear } from '../services/holiday.service.js';

const holidayIdParamSchema = z.object({ id: z.string().uuid() });

function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function holidayModule(deps: ApiModuleDeps): ApiModule {
  const service = createHolidayService({ db: deps.db, audit: createAuditService(deps.db) });

  const router = Router();
  router.use(requireAuth(), denyPlatformOperator());

  router.get(
    '/',
    requireRoles('attendant', 'manager', 'admin'),
    handle(async (req, res) => {
      const year = parseYear(req.query.year);
      res.status(200).json(await service.list(getContext(req), year));
    }),
  );

  router.post(
    '/',
    requireRoles('manager', 'admin'),
    handle(async (req, res) => {
      res.status(201).json(await service.create(getContext(req), req.body ?? {}));
    }),
  );

  router.delete(
    '/:id',
    requireRoles('manager', 'admin'),
    validate(holidayIdParamSchema, 'params'),
    handle(async (req, res) => {
      const { id } = validated<{ id: string }>(req, 'params');
      await service.remove(getContext(req), id);
      res.status(204).end();
    }),
  );

  return { basePath: '/settings/holidays', router, requiresAuth: true };
}

export function businessCalendarModule(deps: ApiModuleDeps): ApiModule {
  const service = createHolidayService({ db: deps.db, audit: createAuditService(deps.db) });

  const router = Router();
  router.use(requireAuth(), denyPlatformOperator());

  router.get(
    '/',
    requireRoles('attendant', 'manager', 'admin'),
    handle(async (req, res) => {
      res.status(200).json(await service.calendar(getContext(req)));
    }),
  );

  return { basePath: '/settings/business-calendar', router, requiresAuth: true };
}
