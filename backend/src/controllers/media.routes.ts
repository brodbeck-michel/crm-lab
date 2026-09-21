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
import {
  FALLBACK_MEDIA_MIME_TYPE,
  isAllowedMediaMimeType,
  mediaCategoryOf,
  normalizeMediaMimeType,
} from '@crm-lab/shared';
import { MediaRepository } from '../repositories/media.repository.js';
import { MediaService } from '../services/media.service.js';

export const mediaIdParamSchema = z.object({ id: z.string().uuid() });

function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/**
 * `inline` só para o que o navegador sabe exibir com segurança dentro da
 * conversa (foto, áudio) — qualquer outra coisa (PDF, doc, e sobretudo o
 * `application/octet-stream` que o allow-list/sniff de CRMLAB-31 aplica a
 * MIME não reconhecido) força `attachment`: o navegador baixa, nunca tenta
 * renderizar no mesmo origin da SPA.
 */
function dispositionFor(mimeType: string): 'inline' | 'attachment' {
  const category = mediaCategoryOf(mimeType);
  return category === 'image' || category === 'audio' ? 'inline' : 'attachment';
}

/**
 * A allow-list vale tambem na LEITURA (revisao do PR #43). `media.types.ts`
 * prometia ser "fonte unica para `MediaService` (grava) e `media.routes.ts`
 * (serve)", mas esta rota nunca a consultava: uma linha de `message_media`
 * gravada ANTES do CRMLAB-31 com `image/svg+xml` continuava saindo com esse
 * Content-Type e `inline` — o proprio vetor de XSS do card, aberto para todo
 * o dado legado. Fora da lista: `application/octet-stream` + `attachment`.
 */
export function servedMimeType(storedMimeType: string): string {
  return isAllowedMediaMimeType(storedMimeType)
    ? normalizeMediaMimeType(storedMimeType)
    : FALLBACK_MEDIA_MIME_TYPE;
}

export function getMedia(service: MediaService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const media = await service.readOrThrow(ctx.tenantId, id);
    const mimeType = servedMimeType(media.mimeType);

    res.setHeader('Content-Type', mimeType);
    // Redundante com o `helmet()` global de `app.ts`, e proposital: esta e a
    // unica rota que serve bytes que o USUARIO mandou. Se um dia o helmet sair
    // ou for reconfigurado, ela continua protegida sozinha.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `${dispositionFor(mimeType)}; filename="${encodeURIComponent(media.fileName)}"`,
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
