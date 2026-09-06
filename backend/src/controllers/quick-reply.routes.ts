/**
 * Rotas de respostas rapidas ("macros") — API_CONTRACTS.md §9.
 *
 *   GET    /api/v1/quick-replies        qualquer papel de tenant
 *   POST   /api/v1/quick-replies        qualquer papel de tenant
 *   PATCH  /api/v1/quick-replies/:id    qualquer papel de tenant
 *   DELETE /api/v1/quick-replies/:id    qualquer papel de tenant
 *
 * Escrita aberta a TODOS os papeis de tenant de proposito (Onda 8 §3.3):
 * restringir a exclusao a gestor foi considerado e descartado — sao textos de
 * trabalho, versionados no audit log, e travar a exclusao so produziria uma
 * lista suja que ninguem limpa.
 *
 * `denyPlatformOperator()` em todas: macro e dado de laboratorio (PAGES.md §11).
 *
 * Controller fino (CONVENTIONS.md): valida o DTO, chama o service, responde.
 * `tenantId` vem SEMPRE de `getContext(req)` — nunca de query/body/header.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { ListQuickRepliesResponse, QuickReply } from '@crm-lab/shared';
import { QUICK_REPLY_CONTENT_MAX, QUICK_REPLY_TITLE_MAX } from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { createAuditService } from '../services/audit.service.js';
import { createQuickReplyService, type QuickReplyService } from '../services/quick-reply.service.js';

/**
 * O formato do atalho NAO e validado aqui: quem normaliza (`trim` + caixa
 * baixa) e o service, e recusar `Coleta` no zod antes da normalizacao
 * rejeitaria o que o service aceitaria. O zod so garante que ha uma string de
 * tamanho plausivel; a regra de formato tem um dono so.
 */
const shortcutField = z.string().trim().min(1).max(64);

export const createQuickReplySchema = z.object({
  shortcut: shortcutField,
  title: z.string().trim().min(1).max(QUICK_REPLY_TITLE_MAX),
  content: z.string().trim().min(1).max(QUICK_REPLY_CONTENT_MAX),
});

export const updateQuickReplySchema = z
  .object({
    shortcut: shortcutField,
    title: z.string().trim().min(1).max(QUICK_REPLY_TITLE_MAX),
    content: z.string().trim().min(1).max(QUICK_REPLY_CONTENT_MAX),
  })
  .partial();

export const quickReplyIdParamSchema = z.object({ id: z.string().uuid() });

type CreateQuickReplyBody = z.infer<typeof createQuickReplySchema>;
type UpdateQuickReplyBody = z.infer<typeof updateQuickReplySchema>;

export function createQuickReplyServiceFromDeps(deps: ApiModuleDeps): QuickReplyService {
  return createQuickReplyService({ db: deps.db, audit: createAuditService(deps.db) });
}

/** `Promise` rejeitada em handler async precisa chegar no error-handler. */
function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function listQuickReplies(service: QuickReplyService): RequestHandler {
  return handle(async (req, res) => {
    const body: ListQuickRepliesResponse = await service.list(getContext(req));
    res.status(200).json(body);
  });
}

export function createQuickReply(service: QuickReplyService): RequestHandler {
  return handle(async (req, res) => {
    const dto = validated<CreateQuickReplyBody>(req, 'body');
    const created: QuickReply = await service.create(getContext(req), dto);
    res.status(201).json(created);
  });
}

export function updateQuickReply(service: QuickReplyService): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<UpdateQuickReplyBody>(req, 'body');
    const updated: QuickReply = await service.update(getContext(req), id, dto);
    res.status(200).json(updated);
  });
}

export function deleteQuickReply(service: QuickReplyService): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    await service.remove(getContext(req), id);
    res.status(204).end();
  });
}

export function quickReplyModule(deps: ApiModuleDeps): ApiModule {
  const service = createQuickReplyServiceFromDeps(deps);
  const router = Router();

  router.get('/', requireAuth(), denyPlatformOperator(), listQuickReplies(service));

  router.post(
    '/',
    requireAuth(),
    denyPlatformOperator(),
    validate(createQuickReplySchema, 'body'),
    createQuickReply(service),
  );

  router.patch(
    '/:id',
    requireAuth(),
    denyPlatformOperator(),
    validate(quickReplyIdParamSchema, 'params'),
    validate(updateQuickReplySchema, 'body'),
    updateQuickReply(service),
  );

  router.delete(
    '/:id',
    requireAuth(),
    denyPlatformOperator(),
    validate(quickReplyIdParamSchema, 'params'),
    deleteQuickReply(service),
  );

  return { basePath: '/quick-replies', router, requiresAuth: true };
}
