/**
 * Rotas de atendentes — API_CONTRACTS.md §12 (Onda 9, D-112).
 *
 *   GET   /api/v1/attendants        manager/admin
 *   POST  /api/v1/attendants        manager/admin
 *   PATCH /api/v1/attendants/:id    manager/admin
 *
 * NAO existe DELETE (D-004): `lis_budgets`/`sales` referenciam o atendente;
 * desativacao e `PATCH { isActive: false }`.
 *
 * Controller fino (CONVENTIONS.md): valida o DTO, chama o service, responde.
 * `tenantId` vem SEMPRE de `getContext(req)`.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { Attendant, ListAttendantsQuery, ListAttendantsResponse } from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { createAuditService } from '../services/audit.service.js';
import { createAttendantService, MAX_LIMIT, type AttendantService } from '../services/attendant.service.js';

/** `?active=true` chega como string; no JSON de teste pode chegar como boolean. */
const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => (typeof value === 'boolean' ? value : value === 'true' || value === '1'));

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
    });

export const listAttendantsQuerySchema = z.object({
  active: booleanish.optional(),
  search: optionalText(120),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

export const createAttendantSchema = z.object({
  name: z.string().trim().min(1).max(255),
  userId: z.string().uuid().nullable().optional(),
});

export const updateAttendantSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    userId: z.string().uuid().nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Informe ao menos um campo',
  });

export const attendantIdParamSchema = z.object({ id: z.string().uuid() });

type CreateAttendantBody = z.infer<typeof createAttendantSchema>;
type UpdateAttendantBody = z.infer<typeof updateAttendantSchema>;

export function createAttendantServiceFromDeps(deps: ApiModuleDeps): AttendantService {
  return createAttendantService({ db: deps.db, audit: createAuditService(deps.db) });
}

function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function listAttendants(service: AttendantService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const query = validated<ListAttendantsQuery>(req, 'query');
    const body: ListAttendantsResponse = await service.list(ctx, query);
    res.status(200).json(body);
  });
}

export function createAttendant(service: AttendantService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const dto = validated<CreateAttendantBody>(req, 'body');
    const attendant: Attendant = await service.create(ctx, {
      name: dto.name,
      ...(dto.userId !== undefined ? { userId: dto.userId } : {}),
    });
    res.status(201).json(attendant);
  });
}

export function updateAttendant(service: AttendantService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<UpdateAttendantBody>(req, 'body');
    const attendant: Attendant = await service.update(ctx, id, dto);
    res.status(200).json(attendant);
  });
}

export function attendantModule(deps: ApiModuleDeps): ApiModule {
  const service = createAttendantServiceFromDeps(deps);
  const router = Router();

  router.get(
    '/',
    requireAuth(),
    denyPlatformOperator(),
    requireRoles('manager', 'admin'),
    validate(listAttendantsQuerySchema, 'query'),
    listAttendants(service),
  );

  router.post(
    '/',
    requireAuth(),
    denyPlatformOperator(),
    requireRoles('manager', 'admin'),
    validate(createAttendantSchema, 'body'),
    createAttendant(service),
  );

  router.patch(
    '/:id',
    requireAuth(),
    denyPlatformOperator(),
    requireRoles('manager', 'admin'),
    validate(attendantIdParamSchema, 'params'),
    validate(updateAttendantSchema, 'body'),
    updateAttendant(service),
  );

  return { basePath: '/attendants', router, requiresAuth: true };
}
