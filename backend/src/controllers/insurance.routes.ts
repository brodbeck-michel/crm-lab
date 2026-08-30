/**
 * Rotas de convenios — API_CONTRACTS.md §8.
 *
 *   GET   /api/v1/insurances        qualquer papel autenticado do laboratorio
 *   POST  /api/v1/insurances        manager/admin
 *   PATCH /api/v1/insurances/:id    manager/admin
 *
 * NAO existe DELETE: desativar e `PATCH { isActive: false }`, porque propostas
 * historicas podem referenciar o convenio usado (D-004, SERVICES.md §15).
 *
 * Controller fino (CONVENTIONS.md): valida o DTO, chama o service, responde.
 * `tenantId` vem SEMPRE de `getContext(req)` — nunca de query/body/header.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { Insurance, ListInsurancesQuery, ListInsurancesResponse } from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { createAuditService } from '../services/audit.service.js';
import { createInsuranceService, MAX_LIMIT, type InsuranceService } from '../services/insurance.service.js';

/** `?active=true` chega como string; no JSON de teste pode chegar como boolean. */
const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => (typeof value === 'boolean' ? value : value === 'true' || value === '1'));

/** String de filtro: vazia (`?search=`) vale como ausente, nao como erro. */
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
    });

const INSURANCE_TYPES = ['cooperativa', 'medicina_grupo', 'seguradora', 'autogestao', 'especial'] as const;

export const listInsurancesQuerySchema = z.object({
  active: booleanish.optional(),
  search: optionalText(120),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  sortBy: z.enum(['name', 'type', 'createdAt', 'updatedAt']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

export const createInsuranceSchema = z.object({
  name: z.string().trim().min(1).max(255),
  officialName: z.string().trim().max(255).optional(),
  ansCode: z.string().trim().max(20).optional(),
  type: z.enum(INSURANCE_TYPES),
});

export const updateInsuranceSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    officialName: z.string().max(255).nullable(),
    ansCode: z.string().max(20).nullable(),
    type: z.enum(INSURANCE_TYPES),
    isActive: z.boolean(),
  })
  .partial();

export const insuranceIdParamSchema = z.object({ id: z.string().uuid() });

type CreateInsuranceBody = z.infer<typeof createInsuranceSchema>;
type UpdateInsuranceBody = z.infer<typeof updateInsuranceSchema>;

/** Monta service a partir das dependencias do kernel. */
export function createInsuranceServiceFromDeps(deps: ApiModuleDeps): InsuranceService {
  return createInsuranceService({ db: deps.db, audit: createAuditService(deps.db) });
}

/** `Promise` rejeitada em handler async precisa chegar no error-handler. */
function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function listInsurances(service: InsuranceService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const query = validated<ListInsurancesQuery>(req, 'query');
    const body: ListInsurancesResponse = await service.list(ctx, query);
    res.status(200).json(body);
  });
}

export function createInsurance(service: InsuranceService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const dto = validated<CreateInsuranceBody>(req, 'body');
    const insurance: Insurance = await service.create(ctx, {
      name: dto.name,
      ...(dto.officialName !== undefined ? { officialName: dto.officialName } : {}),
      ...(dto.ansCode !== undefined ? { ansCode: dto.ansCode } : {}),
      type: dto.type,
    });
    res.status(201).json(insurance);
  });
}

export function updateInsurance(service: InsuranceService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<UpdateInsuranceBody>(req, 'body');
    const insurance: Insurance = await service.update(ctx, id, dto);
    res.status(200).json(insurance);
  });
}

export function insuranceModule(deps: ApiModuleDeps): ApiModule {
  const service = createInsuranceServiceFromDeps(deps);
  const router = Router();

  router.get(
    '/',
    requireAuth(),
    denyPlatformOperator(),
    validate(listInsurancesQuerySchema, 'query'),
    listInsurances(service),
  );

  // `denyPlatformOperator()` ANTES de `requireRoles`: a recusa ao operador da
  // plataforma e explicita (PAGES.md §11), nao um efeito colateral da lista de
  // papeis — que pode mudar.
  // `requireRoles` ANTES do `validate`: atendente recebe FORBIDDEN com
  // `details.requiredRoles`, e nao um VALIDATION_ERROR que vazaria o shape.
  router.post(
    '/',
    requireAuth(),
    denyPlatformOperator(),
    requireRoles('manager', 'admin'),
    validate(createInsuranceSchema, 'body'),
    createInsurance(service),
  );

  router.patch(
    '/:id',
    requireAuth(),
    denyPlatformOperator(),
    requireRoles('manager', 'admin'),
    validate(insuranceIdParamSchema, 'params'),
    validate(updateInsuranceSchema, 'body'),
    updateInsurance(service),
  );

  return { basePath: '/insurances', router, requiresAuth: true };
}
