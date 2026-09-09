/**
 * Rotas do chat interno — WORKFLOWS.md §6, SERVICES.md §7.
 *
 *   GET  /api/v1/internal-chat/channels
 *   POST /api/v1/internal-chat/channels/:id/read      marca lido (204, D-068)
 *   GET  /api/v1/internal-chat/channels/:id/messages
 *   POST /api/v1/internal-chat/channels/:id/messages
 *   GET  /api/v1/internal-chat/users                  diretorio de DM (D-101)
 *   POST /api/v1/internal-chat/dms                     get-or-create DM (200, D-101)
 *
 * `denyPlatformOperator()` em todas: o console de plataforma tem chat PROPRIO e
 * nao acessa canais de laboratorio (PAGES.md §11). O service recusa de novo.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type {
  Channel,
  InternalMessage,
  ListChannelsResponse,
  ListChatDirectoryResponse,
  ListInternalMessagesResponse,
} from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import {
  MAX_CONTENT_LENGTH,
  MAX_LIMIT,
  createInternalChatService,
} from '../services/internal-chat.service.js';
import type { InternalChatService } from '../services/internal-chat.service.js';

export const channelIdParamSchema = z.object({ id: z.string().uuid() });

export const listMessagesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

export const sendMessageSchema = z
  .object({
    content: z.string().min(1).max(MAX_CONTENT_LENGTH),
    attachedProposalId: z.string().uuid().nullish(),
  })
  .strict();

type SendMessageBody = z.infer<typeof sendMessageSchema>;

export const createDirectChannelSchema = z.object({ userId: z.string().uuid() }).strict();

type CreateDirectChannelBody = z.infer<typeof createDirectChannelSchema>;

function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function listChannels(service: InternalChatService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const channels = await service.listChannels(ctx);
    const body: ListChannelsResponse = { channels };
    res.status(200).json(body);
  });
}

export function listMessages(service: InternalChatService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const page = validated<{ page?: number; limit?: number }>(req, 'query');
    const body: ListInternalMessagesResponse = await service.listMessages(ctx, id, page);
    res.status(200).json(body);
  });
}

/** `204 No Content` — sem corpo, idempotente (D-068 / regra de envelope D-070). */
export function markChannelRead(service: InternalChatService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    await service.markChannelRead(ctx, id);
    res.status(204).end();
  });
}

export function sendMessage(service: InternalChatService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<SendMessageBody>(req, 'body');
    const message: InternalMessage = await service.send(ctx, id, {
      content: dto.content,
      attachedProposalId: dto.attachedProposalId ?? null,
    });
    res.status(201).json(message);
  });
}

export function listDirectory(service: InternalChatService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const users = await service.listDirectory(ctx);
    const body: ListChatDirectoryResponse = { users };
    res.status(200).json(body);
  });
}

/** `200`, nao `201`: get-or-create idempotente (D-101), mesmo padrao do connect do WhatsApp. */
export function createDirectChannel(service: InternalChatService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const dto = validated<CreateDirectChannelBody>(req, 'body');
    const channel: Channel = await service.getOrCreateDirectChannel(ctx, dto.userId);
    res.status(200).json(channel);
  });
}

export function internalChatModule(deps: ApiModuleDeps): ApiModule {
  const service = createInternalChatService(deps.db, deps.wsHub);
  const router = Router();

  router.get('/channels', requireAuth(), denyPlatformOperator(), listChannels(service));

  router.post(
    '/channels/:id/read',
    requireAuth(),
    denyPlatformOperator(),
    validate(channelIdParamSchema, 'params'),
    markChannelRead(service),
  );

  router.get(
    '/channels/:id/messages',
    requireAuth(),
    denyPlatformOperator(),
    validate(channelIdParamSchema, 'params'),
    validate(listMessagesQuerySchema, 'query'),
    listMessages(service),
  );

  router.post(
    '/channels/:id/messages',
    requireAuth(),
    denyPlatformOperator(),
    validate(channelIdParamSchema, 'params'),
    validate(sendMessageSchema, 'body'),
    sendMessage(service),
  );

  router.get('/users', requireAuth(), denyPlatformOperator(), listDirectory(service));

  router.post(
    '/dms',
    requireAuth(),
    denyPlatformOperator(),
    validate(createDirectChannelSchema, 'body'),
    createDirectChannel(service),
  );

  return { basePath: '/internal-chat', router, requiresAuth: true };
}
