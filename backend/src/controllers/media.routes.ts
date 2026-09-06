/**
 * Rota de mídia — Onda 8 §4.1.
 *
 *   GET /api/v1/media/:id   autenticado, filtrado por tenant (RLS)
 *
 * NUNCA servido como arquivo estatico publico (`express.static`): e exame e
 * áudio de paciente — UUID adivinhado sobre uma pasta estatica seria
 * vazamento de dado de saude sem passar por autenticacao nem por RLS. Mídia
 * de outro tenant é `NOT_FOUND` (CLAUDE.md regra 8), nunca `FORBIDDEN`.
 *
 * `denyPlatformOperator()`: mídia é dado de laboratório (PAGES.md §11).
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { MediaRepository } from '../repositories/media.repository.js';
import { MediaService } from '../services/media.service.js';

export const mediaIdParamSchema = z.object({ id: z.string().uuid() });

function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function getMedia(service: MediaService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const media = await service.readOrThrow(ctx.tenantId, id);

    res.setHeader('Content-Type', media.mimeType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(media.fileName)}"`,
    );
    res.status(200).send(media.buffer);
  });
}

export function createMediaServiceFromDeps(deps: ApiModuleDeps): MediaService {
  return new MediaService(new MediaRepository(deps.db));
}

export function mediaModule(deps: ApiModuleDeps): ApiModule {
  const service = createMediaServiceFromDeps(deps);
  const router = Router();

  router.get(
    '/:id',
    requireAuth(),
    denyPlatformOperator(),
    validate(mediaIdParamSchema, 'params'),
    getMedia(service),
  );

  return { basePath: '/media', router, requiresAuth: true };
}
