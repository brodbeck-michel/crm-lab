/**
 * Dispositivos de captura — API_CONTRACTS.md §15.1 (CRMLAB-184, D-326).
 *
 *   GET    /api/v1/settings/capture-devices                   manager/admin
 *   POST   /api/v1/settings/capture-devices                   admin (201 + codigo)
 *   POST   /api/v1/settings/capture-devices/:id/pairing-code  admin (novo codigo)
 *   DELETE /api/v1/settings/capture-devices/:id               admin (revoga, 204)
 *
 * `denyPlatformOperator()` em todas. Cadastro, novo codigo e revogacao sao
 * auditados (equivalem a dar e tirar permissao).
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  CAPTURE_DEVICE_NAME_MAX,
  type CapturePairingCode,
  type CreateCaptureDeviceResponse,
} from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { createAuditService } from '../services/audit.service.js';
import {
  CaptureDeviceService,
  MAX_DEVICE_PAGE_LIMIT,
  type ListCaptureDevicesResult,
} from '../services/capture-device.service.js';

export const captureDeviceIdParamSchema = z.object({ id: z.uuid() });

export const listCaptureDevicesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_DEVICE_PAGE_LIMIT).optional(),
});

export const createCaptureDeviceSchema = z.object({
  name: z.string().trim().min(1).max(CAPTURE_DEVICE_NAME_MAX),
});

function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function captureDeviceModule(deps: ApiModuleDeps): ApiModule {
  const service = new CaptureDeviceService({ db: deps.db, audit: createAuditService(deps.db) });
  const router = Router();
  router.use(requireAuth(), denyPlatformOperator());

  router.get(
    '/',
    requireRoles('manager', 'admin'),
    validate(listCaptureDevicesQuerySchema, 'query'),
    handle(async (req, res) => {
      const query = validated<{ page?: number; limit?: number }>(req, 'query');
      const body: ListCaptureDevicesResult = await service.list(getContext(req), query);
      res.status(200).json(body);
    }),
  );

  router.post(
    '/',
    requireRoles('admin'),
    validate(createCaptureDeviceSchema, 'body'),
    handle(async (req, res) => {
      const { name } = validated<{ name: string }>(req, 'body');
      const body: CreateCaptureDeviceResponse = await service.create(getContext(req), name);
      res.status(201).json(body);
    }),
  );

  router.post(
    '/:id/pairing-code',
    requireRoles('admin'),
    validate(captureDeviceIdParamSchema, 'params'),
    handle(async (req, res) => {
      const { id } = validated<{ id: string }>(req, 'params');
      const body: CapturePairingCode = await service.renewPairingCode(getContext(req), id);
      res.status(200).json(body);
    }),
  );

  router.delete(
    '/:id',
    requireRoles('admin'),
    validate(captureDeviceIdParamSchema, 'params'),
    handle(async (req, res) => {
      const { id } = validated<{ id: string }>(req, 'params');
      await service.revoke(getContext(req), id);
      res.status(204).end();
    }),
  );

  return { basePath: '/settings/capture-devices', router, requiresAuth: true };
}
