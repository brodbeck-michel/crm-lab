/**
 * Rotas de importação do LIS — API_CONTRACTS.md §10.1 (Onda 9, D-109).
 *
 *   POST /api/v1/lis-imports          manager/admin
 *   GET  /api/v1/lis-imports          manager/admin
 *   GET  /api/v1/lis-imports/latest   manager/admin
 *   POST /api/v1/lis-imports/purge    admin apenas
 *
 * `/lis-budgets` (§10.2, leitura de `LisAnalyticsService`) NAO é deste módulo —
 * outro agente da Onda 9 cuida dele.
 *
 * Controller fino (CONVENTIONS.md): valida o DTO, chama o service, responde.
 * `tenantId` vem SEMPRE de `getContext(req)`.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type {
  ImportLisSpreadsheetRequest,
  LisImport,
  ListLisImportsQuery,
  ListLisImportsResponse,
  PurgeLisBudgetsRequest,
} from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { createAuditService } from '../services/audit.service.js';
import { createLisImportService, MAX_LIMIT, type LisImportService } from '../services/lis-import.service.js';

export const importLisSpreadsheetSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentBase64: z.string().min(1),
});

export const purgeLisBudgetsSchema = z.object({
  confirm: z.string().min(1).max(50),
});

export const listLisImportsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

type ImportBody = z.infer<typeof importLisSpreadsheetSchema>;
type PurgeBody = z.infer<typeof purgeLisBudgetsSchema>;

export function createLisImportServiceFromDeps(deps: ApiModuleDeps): LisImportService {
  return createLisImportService({
    db: deps.db,
    cache: deps.cache,
    audit: createAuditService(deps.db),
    wsHub: deps.wsHub,
  });
}

function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function importLisSpreadsheet(service: LisImportService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const dto = validated<ImportBody>(req, 'body');
    const input: ImportLisSpreadsheetRequest = { fileName: dto.fileName, contentBase64: dto.contentBase64 };
    const result: LisImport = await service.import(ctx, input);
    res.status(201).json(result);
  });
}

export function purgeLisBudgets(service: LisImportService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const dto = validated<PurgeBody>(req, 'body');
    const input: PurgeLisBudgetsRequest = { confirm: dto.confirm };
    const result: LisImport = await service.purge(ctx, input);
    res.status(201).json(result);
  });
}

export function listLisImports(service: LisImportService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const query = validated<ListLisImportsQuery>(req, 'query');
    const body: ListLisImportsResponse = await service.list(ctx, query);
    res.status(200).json(body);
  });
}

export function getLatestLisImport(service: LisImportService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const result: LisImport | null = await service.getLatest(ctx);
    res.status(200).json(result);
  });
}

export function lisImportModule(deps: ApiModuleDeps): ApiModule {
  const service = createLisImportServiceFromDeps(deps);
  const router = Router();

  // `/latest` ANTES de nenhum `:id` nesta rota (nao ha `:id` aqui, mas a ordem
  // e explicita por clareza: rota literal antes de qualquer coisa parametrica).
  router.get(
    '/latest',
    requireAuth(),
    denyPlatformOperator(),
    requireRoles('manager', 'admin'),
    getLatestLisImport(service),
  );

  router.get(
    '/',
    requireAuth(),
    denyPlatformOperator(),
    requireRoles('manager', 'admin'),
    validate(listLisImportsQuerySchema, 'query'),
    listLisImports(service),
  );

  router.post(
    '/',
    requireAuth(),
    denyPlatformOperator(),
    requireRoles('manager', 'admin'),
    validate(importLisSpreadsheetSchema, 'body'),
    importLisSpreadsheet(service),
  );

  router.post(
    '/purge',
    requireAuth(),
    denyPlatformOperator(),
    requireRoles('admin'),
    validate(purgeLisBudgetsSchema, 'body'),
    purgeLisBudgets(service),
  );

  return { basePath: '/lis-imports', router, requiresAuth: true };
}
