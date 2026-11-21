/**
 * Fila "Digitalizacoes" — API_CONTRACTS.md §15.3 (CRMLAB-184, D-327).
 *
 *   GET    /api/v1/scans               fila do laboratorio (sem vencidas)
 *   GET    /api/v1/scans/:id/content   o arquivo (como GET /media/:id)
 *   DELETE /api/v1/scans/:id           descarta (204, audit `discard_scan`)
 *
 * A fila e do laboratorio: attendant, manager e admin veem tudo.
 * `denyPlatformOperator()` em todas. Vencida, usada ou de outro tenant:
 * `NOT_FOUND`.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { createAuditService } from '../services/audit.service.js';
import { MAX_SCAN_PAGE_LIMIT, ScanService, type ListScansResult } from '../services/scan.service.js';

export const scanIdParamSchema = z.object({ id: z.uuid() });

export const listScansQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_SCAN_PAGE_LIMIT).optional(),
});

function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function createScanServiceFromDeps(deps: ApiModuleDeps): ScanService {
  return new ScanService({ db: deps.db, audit: createAuditService(deps.db) });
}

export function scanModule(deps: ApiModuleDeps): ApiModule {
  const service = createScanServiceFromDeps(deps);
  const router = Router();
  router.use(requireAuth(), denyPlatformOperator());

  router.get(
    '/',
    validate(listScansQuerySchema, 'query'),
    handle(async (req, res) => {
      const query = validated<{ page?: number; limit?: number }>(req, 'query');
      const body: ListScansResult = await service.list(getContext(req), query);
      res.status(200).json(body);
    }),
  );

  router.get(
    '/:id/content',
    validate(scanIdParamSchema, 'params'),
    handle(async (req, res) => {
      const { id } = validated<{ id: string }>(req, 'params');
      const content = await service.readContent(getContext(req), id);
      res.setHeader('Content-Type', content.mimeType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${encodeURIComponent(content.fileName)}"`,
      );
      res.status(200).send(content.buffer);
    }),
  );

  router.delete(
    '/:id',
    validate(scanIdParamSchema, 'params'),
    handle(async (req, res) => {
      const { id } = validated<{ id: string }>(req, 'params');
      await service.discard(getContext(req), id);
      res.status(204).end();
    }),
  );

  return { basePath: '/scans', router, requiresAuth: true };
}
