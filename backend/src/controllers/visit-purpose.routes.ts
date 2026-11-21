/**
 * Rotas das finalidades da visita — `/api/v1/settings/visit-purposes`
 * (API_CONTRACTS.md §14 "Finalidades da visita", CRMLAB-190 — D-330).
 *
 *   GET   /settings/visit-purposes        todo papel do laboratorio
 *   POST  /settings/visit-purposes        manager/admin
 *   PATCH /settings/visit-purposes/:id    manager/admin
 *
 * Sem DELETE: finalidade se inativa (a visita a referencia).
 * `denyPlatformOperator()` em todas: e dado de laboratorio.
 * Controller fino (CONVENTIONS.md): valida o DTO, chama o service, responde.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  VISIT_PURPOSE_COLORS,
  VISIT_PURPOSE_NAME_MAX_LENGTH,
  type CreateVisitPurposeRequest,
  type UpdateVisitPurposeRequest,
} from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { createAuditService } from '../services/audit.service.js';
import { createVisitPurposeService } from '../services/visit-purpose.service.js';

/** O tamanho fino (depois de juntar espacos) e conferido no service. */
const nameField = z.string().trim().min(1).max(VISIT_PURPOSE_NAME_MAX_LENGTH * 2);

export const createVisitPurposeSchema = z
  .object({ name: nameField, color: z.enum(VISIT_PURPOSE_COLORS) })
  .strict();

export const updateVisitPurposeSchema = z
  .object({
    name: nameField.optional(),
    color: z.enum(VISIT_PURPOSE_COLORS).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

const purposeIdParamSchema = z.object({ id: z.uuid() });

function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function visitPurposeModule(deps: ApiModuleDeps): ApiModule {
  const service = createVisitPurposeService({ db: deps.db, audit: createAuditService(deps.db) });
  const router = Router();
  router.use(requireAuth(), denyPlatformOperator());

  router.get(
    '/',
    handle(async (req, res) => {
      res.status(200).json(await service.list(getContext(req)));
    }),
  );

  router.post(
    '/',
    requireRoles('manager', 'admin'),
    validate(createVisitPurposeSchema, 'body'),
    handle(async (req, res) => {
      const dto = validated<CreateVisitPurposeRequest>(req, 'body');
      res.status(201).json(await service.create(getContext(req), dto));
    }),
  );

  router.patch(
    '/:id',
    requireRoles('manager', 'admin'),
    validate(purposeIdParamSchema, 'params'),
    validate(updateVisitPurposeSchema, 'body'),
    handle(async (req, res) => {
      const { id } = validated<{ id: string }>(req, 'params');
      const dto = validated<UpdateVisitPurposeRequest>(req, 'body');
      res.status(200).json(await service.update(getContext(req), id, dto));
    }),
  );

  return { basePath: '/settings/visit-purposes', router, requiresAuth: true };
}
