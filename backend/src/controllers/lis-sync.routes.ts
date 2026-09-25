/**
 * Integracao LIS pela API do Bitlab — API_CONTRACTS.md §10.3 (CRMLAB-52, D-185).
 *
 *   GET   /api/v1/settings/lis-integration        manager/admin
 *   PATCH /api/v1/settings/lis-integration        admin
 *   POST  /api/v1/settings/lis-integration/sync   manager/admin
 *
 * Controller fino: valida o DTO, chama o service, responde. A chave nunca volta
 * na resposta (`apiKeyMasked`, D-064).
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { LisIntegrationSettings, LisSyncRunResult, UpdateLisIntegrationRequest } from '@crm-lab/shared';
import { env } from '../config/env.js';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { createBitlabClient, type BitlabClient } from '../lib/bitlab-client.js';
import { createAuditService } from '../services/audit.service.js';
import { createLisImportService } from '../services/lis-import.service.js';
import { createLisSyncService, type LisSyncService } from '../services/lis-sync.service.js';

export const updateLisIntegrationSchema = z
  .object({
    enabled: z.boolean().optional(),
    // `""` e VALIDATION_ERROR (semantica de segredo de §6); espaco nas pontas tambem.
    apiKey: z
      .string()
      .min(1)
      .max(512)
      .refine((v) => v.trim() === v, 'sem espaço nas pontas')
      .nullable()
      .optional(),
  })
  .strict();

type UpdateBody = z.infer<typeof updateLisIntegrationSchema>;

export interface LisSyncModuleOverrides {
  bitlab?: BitlabClient;
}

/** Monta o service com as mesmas deps do agendador do `main.ts`. */
export function createLisSyncServiceFromDeps(
  deps: Pick<ApiModuleDeps, 'db' | 'cache'>,
  overrides: LisSyncModuleOverrides = {},
): LisSyncService {
  const audit = createAuditService(deps.db);
  return createLisSyncService({
    db: deps.db,
    audit,
    lisImport: createLisImportService({ db: deps.db, cache: deps.cache, audit }),
    bitlab: overrides.bitlab ?? createBitlabClient({ baseUrl: env.BITLAB_API_BASE_URL }),
    intervalMs: env.LIS_SYNC_INTERVAL_MS,
    initialDays: env.LIS_SYNC_INITIAL_DAYS,
  });
}

function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

function buildLisSyncModule(deps: ApiModuleDeps, overrides: LisSyncModuleOverrides): ApiModule {
  const service = createLisSyncServiceFromDeps(deps, overrides);
  const router = Router();

  router.get(
    '/',
    requireAuth(),
    denyPlatformOperator(),
    requireRoles('manager', 'admin'),
    handle(async (req, res) => {
      const body: LisIntegrationSettings = await service.getSettings(getContext(req));
      res.status(200).json(body);
    }),
  );

  router.patch(
    '/',
    requireAuth(),
    denyPlatformOperator(),
    requireRoles('admin'),
    validate(updateLisIntegrationSchema, 'body'),
    handle(async (req, res) => {
      const dto = validated<UpdateBody>(req, 'body');
      const input: UpdateLisIntegrationRequest = {
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.apiKey !== undefined ? { apiKey: dto.apiKey } : {}),
      };
      const body: LisIntegrationSettings = await service.updateSettings(getContext(req), input);
      res.status(200).json(body);
    }),
  );

  router.post(
    '/sync',
    requireAuth(),
    denyPlatformOperator(),
    requireRoles('manager', 'admin'),
    handle(async (req, res) => {
      const body: LisSyncRunResult = await service.runNow(getContext(req));
      res.status(200).json(body);
    }),
  );

  return { basePath: '/settings/lis-integration', router, requiresAuth: true };
}

export function makeLisSyncModule(overrides: LisSyncModuleOverrides = {}): (deps: ApiModuleDeps) => ApiModule {
  return (deps) => buildLisSyncModule(deps, overrides);
}

export function lisSyncModule(deps: ApiModuleDeps): ApiModule {
  return buildLisSyncModule(deps, {});
}
