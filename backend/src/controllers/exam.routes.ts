/**
 * Rotas do catalogo de exames — API_CONTRACTS.md §4.
 *
 *   GET   /api/v1/exams              qualquer papel autenticado do laboratorio
 *   POST  /api/v1/exams              manager/admin
 *   PATCH /api/v1/exams/:id          manager/admin
 *   GET   /api/v1/exams/:id/prices   qualquer papel autenticado (Onda 7)
 *   PUT   /api/v1/exams/:id/prices   manager/admin (Onda 7)
 *
 * NAO existe DELETE: o catalogo se desativa com `PATCH { isActive: false }`,
 * porque propostas historicas referenciam o exame (D-004, SERVICES.md §5).
 *
 * Controller fino (CONVENTIONS.md): valida o DTO, chama o service, responde.
 * `tenantId` vem SEMPRE de `getContext(req)` — nunca de query/body/header.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type {
  Exam,
  ExamPrice,
  ListExamPricesResponse,
  ListExamsResponse,
  UpdateExamPricesRequest,
} from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { ExamRepository } from '../repositories/exam.repository.js';
import { createAuditService } from '../services/audit.service.js';
import { ExamCatalogService, MAX_LIMIT, type ExamFilters } from '../services/exam-catalog.service.js';

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

/** NUMERIC(12,2): dinheiro decimal no fio, nunca string formatada (regra 9). */
const money = z.number().finite().nonnegative().max(9_999_999_999);

/**
 * String opcional que vira `null` quando vazia — formulario HTML manda `''`
 * para campo esvaziado (Task 7 constroi a tela de TUSS/AMB/material sobre
 * este contrato), e `''` != "nao informado" no dominio: os dois significam a
 * mesma coisa e o cliente nao deveria ter que saber disso. `undefined`
 * continua distinto (chave ausente no PATCH = preserva o valor atual).
 */
function emptyStringToNull(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => {
      if (value === undefined) return undefined;
      if (value === null || value.length === 0) return null;
      return value;
    });
}

/** Codigo TUSS/AMB nao confirmado e `null`, nunca inventado (D-081). */
const codeField = emptyStringToNull(20);
const materialField = emptyStringToNull(255);
/** `synonyms` substitui o conjunto inteiro (semantica de PUT sobre a colecao filha). */
const synonymsField = z.array(z.string().trim().min(1).max(255)).max(20).optional();

export const listExamsQuerySchema = z.object({
  active: booleanish.optional(),
  category: optionalText(100),
  search: optionalText(120),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  sortBy: z
    .enum(['name', 'code', 'category', 'pricePrivate', 'priceInsurance', 'createdAt', 'updatedAt'])
    .optional(),
  order: z.enum(['asc', 'desc']).optional(),
  // Onda 7: acrescenta effectivePrice/priceSource a cada item do resultado.
  insuranceId: z.string().uuid().optional(),
});

export const createExamSchema = z.object({
  name: z.string().trim().min(1).max(255),
  code: z.string().trim().min(1).max(50),
  description: z.string().max(4000).nullish(),
  preparation: z.string().max(4000).nullish(),
  turnaroundHours: z.number().int().positive().max(100_000).nullish(),
  pricePrivate: money,
  priceInsurance: money,
  category: z.string().trim().max(100).nullish(),
  tussCode: codeField,
  ambCode: codeField,
  material: materialField,
  synonyms: synonymsField,
});

export const updateExamSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    description: z.string().max(4000).nullable(),
    preparation: z.string().max(4000).nullable(),
    turnaroundHours: z.number().int().positive().max(100_000).nullable(),
    pricePrivate: money,
    priceInsurance: money,
    category: z.string().trim().max(100).nullable(),
    isActive: z.boolean(),
    tussCode: codeField,
    ambCode: codeField,
    material: materialField,
    synonyms: synonymsField,
  })
  .partial();

export const examIdParamSchema = z.object({ id: z.string().uuid() });

/** Corpo de `PUT /exams/:id/prices` — upsert em lote, estado completo (Onda 7). */
export const examPricesBodySchema = z.object({
  prices: z.array(
    z.object({
      insuranceId: z.string().uuid(),
      price: money,
    }),
  ),
});

type CreateExamBody = z.infer<typeof createExamSchema>;
type UpdateExamBody = z.infer<typeof updateExamSchema>;

/** Monta service + repository + auditoria a partir das dependencias do kernel. */
export function createExamCatalogService(deps: ApiModuleDeps): ExamCatalogService {
  return new ExamCatalogService(
    new ExamRepository(deps.db),
    deps.cache,
    createAuditService(deps.db),
  );
}

/** `Promise` rejeitada em handler async precisa chegar no error-handler. */
function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function listExams(service: ExamCatalogService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const filters = validated<ExamFilters>(req, 'query');
    const page = await service.list(ctx.tenantId, filters);
    // D-009: envelope com chave nomeada (`exams`), nao `data`.
    const body: ListExamsResponse = { exams: page.data, pagination: page.pagination };
    res.status(200).json(body);
  });
}

export function createExam(service: ExamCatalogService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const dto = validated<CreateExamBody>(req, 'body');
    const exam: Exam = await service.create(ctx, {
      name: dto.name,
      code: dto.code,
      description: dto.description ?? null,
      preparation: dto.preparation ?? null,
      turnaroundHours: dto.turnaroundHours ?? null,
      pricePrivate: dto.pricePrivate,
      priceInsurance: dto.priceInsurance,
      category: dto.category ?? null,
      tussCode: dto.tussCode ?? null,
      ambCode: dto.ambCode ?? null,
      material: dto.material ?? null,
      synonyms: dto.synonyms,
    });
    res.status(201).json(exam);
  });
}

export function updateExam(service: ExamCatalogService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<UpdateExamBody>(req, 'body');
    const exam: Exam = await service.update(ctx, id, dto);
    res.status(200).json(exam);
  });
}

/** Onda 7. Qualquer papel autenticado do tenant. */
export function listExamPrices(service: ExamCatalogService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const prices: ExamPrice[] = await service.listPrices(ctx, id);
    const body: ListExamPricesResponse = { prices };
    res.status(200).json(body);
  });
}

/** Onda 7. manager/admin. Estado completo — linha ausente do corpo e removida. */
export function upsertExamPrices(service: ExamCatalogService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<UpdateExamPricesRequest>(req, 'body');
    const prices: ExamPrice[] = await service.upsertPrices(ctx, id, dto);
    const body: ListExamPricesResponse = { prices };
    res.status(200).json(body);
  });
}

export function examModule(deps: ApiModuleDeps): ApiModule {
  const service = createExamCatalogService(deps);
  const router = Router();

  router.get(
    '/',
    requireAuth(),
    denyPlatformOperator(),
    validate(listExamsQuerySchema, 'query'),
    listExams(service),
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
    validate(createExamSchema, 'body'),
    createExam(service),
  );

  router.patch(
    '/:id',
    requireAuth(),
    denyPlatformOperator(),
    requireRoles('manager', 'admin'),
    validate(examIdParamSchema, 'params'),
    validate(updateExamSchema, 'body'),
    updateExam(service),
  );

  // Onda 7 — preco por convenio (`exam_prices`, SCHEMA.md §19).
  router.get(
    '/:id/prices',
    requireAuth(),
    denyPlatformOperator(),
    validate(examIdParamSchema, 'params'),
    listExamPrices(service),
  );

  router.put(
    '/:id/prices',
    requireAuth(),
    denyPlatformOperator(),
    requireRoles('manager', 'admin'),
    validate(examIdParamSchema, 'params'),
    validate(examPricesBodySchema, 'body'),
    upsertExamPrices(service),
  );

  return { basePath: '/exams', router, requiresAuth: true };
}
