/**
 * Rotas de pacotes de exames — CRMLAB-10, API_CONTRACTS.md §4b.
 *
 *   GET   /api/v1/exam-packages              qualquer papel autenticado do laboratorio
 *   POST  /api/v1/exam-packages              manager/admin
 *   PATCH /api/v1/exam-packages/:id          manager/admin
 *   GET   /api/v1/exam-packages/:id/prices   qualquer papel autenticado
 *   PUT   /api/v1/exam-packages/:id/prices   manager/admin
 *
 * NAO existe DELETE: o pacote se desativa com `PATCH { isActive: false }`,
 * mesmo padrao do catalogo de exames (D-004).
 *
 * Controller fino (CONVENTIONS.md): valida o DTO, chama o service, responde.
 * `tenantId` vem SEMPRE de `getContext(req)` — nunca de query/body/header.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type {
  ExamPackage,
  ExamPackagePrice,
  ListExamPackagePricesResponse,
  ListExamPackagesResponse,
  UpdateExamPackagePricesRequest,
} from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { ExamPackageRepository } from '../repositories/exam-package.repository.js';
import { createAuditService } from '../services/audit.service.js';
import {
  ExamPackageService,
  MAX_LIMIT,
  type ExamPackageFilters,
} from '../services/exam-package.service.js';

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

/** NUMERIC(5,2): percentual, 0 a 100. */
const discountPercent = z.number().finite().min(0).max(100);
/** NUMERIC(12,2): dinheiro decimal no fio, nunca string formatada (regra 9). */
const money = z.number().finite().nonnegative().max(9_999_999_999);

export const listExamPackagesQuerySchema = z.object({
  active: booleanish.optional(),
  search: optionalText(120),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  sortBy: z.enum(['name', 'discountPercent', 'createdAt', 'updatedAt']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  insuranceId: z.string().uuid().optional(),
});

export const createExamPackageSchema = z.object({
  name: z.string().trim().min(1).max(255),
  examIds: z.array(z.string().uuid()).min(1).max(100),
  discountPercent,
});

export const updateExamPackageSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    examIds: z.array(z.string().uuid()).min(1).max(100),
    discountPercent,
    isActive: z.boolean(),
  })
  .partial();

export const examPackageIdParamSchema = z.object({ id: z.string().uuid() });

export const examPackagePricesBodySchema = z.object({
  prices: z.array(
    z.object({
      insuranceId: z.string().uuid(),
      price: money,
    }),
  ),
});

type CreateExamPackageBody = z.infer<typeof createExamPackageSchema>;
type UpdateExamPackageBody = z.infer<typeof updateExamPackageSchema>;

export function createExamPackageService(deps: ApiModuleDeps): ExamPackageService {
  return new ExamPackageService(
    new ExamPackageRepository(deps.db),
    deps.cache,
    createAuditService(deps.db),
  );
}

function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function listExamPackages(service: ExamPackageService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const filters = validated<ExamPackageFilters>(req, 'query');
    const page = await service.list(ctx.tenantId, filters);
    // D-009: envelope com chave nomeada (`packages`), nao `data`.
    const body: ListExamPackagesResponse = { packages: page.data, pagination: page.pagination };
    res.status(200).json(body);
  });
}

export function createExamPackage(service: ExamPackageService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const dto = validated<CreateExamPackageBody>(req, 'body');
    const pkg: ExamPackage = await service.create(ctx, {
      name: dto.name,
      examIds: dto.examIds,
      discountPercent: dto.discountPercent,
    });
    res.status(201).json(pkg);
  });
}

export function updateExamPackage(service: ExamPackageService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<UpdateExamPackageBody>(req, 'body');
    const pkg: ExamPackage = await service.update(ctx, id, dto);
    res.status(200).json(pkg);
  });
}

export function listExamPackagePrices(service: ExamPackageService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const prices: ExamPackagePrice[] = await service.listPrices(ctx, id);
    const body: ListExamPackagePricesResponse = { prices };
    res.status(200).json(body);
  });
}

export function upsertExamPackagePrices(service: ExamPackageService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<UpdateExamPackagePricesRequest>(req, 'body');
    const prices: ExamPackagePrice[] = await service.upsertPrices(ctx, id, dto);
    const body: ListExamPackagePricesResponse = { prices };
    res.status(200).json(body);
  });
}

export function examPackageModule(deps: ApiModuleDeps): ApiModule {
  const service = createExamPackageService(deps);
  const router = Router();

  router.get(
    '/',
    requireAuth(),
    denyPlatformOperator(),
    validate(listExamPackagesQuerySchema, 'query'),
    listExamPackages(service),
  );

  router.post(
    '/',
    requireAuth(),
    denyPlatformOperator(),
    requireRoles('manager', 'admin'),
    validate(createExamPackageSchema, 'body'),
    createExamPackage(service),
  );

  router.patch(
    '/:id',
    requireAuth(),
    denyPlatformOperator(),
    requireRoles('manager', 'admin'),
    validate(examPackageIdParamSchema, 'params'),
    validate(updateExamPackageSchema, 'body'),
    updateExamPackage(service),
  );

  router.get(
    '/:id/prices',
    requireAuth(),
    denyPlatformOperator(),
    validate(examPackageIdParamSchema, 'params'),
    listExamPackagePrices(service),
  );

  router.put(
    '/:id/prices',
    requireAuth(),
    denyPlatformOperator(),
    requireRoles('manager', 'admin'),
    validate(examPackageIdParamSchema, 'params'),
    validate(examPackagePricesBodySchema, 'body'),
    upsertExamPackagePrices(service),
  );

  return { basePath: '/exam-packages', router, requiresAuth: true };
}
