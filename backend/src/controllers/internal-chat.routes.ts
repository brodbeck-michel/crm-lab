/**
 * Rotas do chat interno — WORKFLOWS.md §6, SERVICES.md §7.
 *
 *   GET  /api/v1/internal-chat/channels
 *   GET  /api/v1/internal-chat/channels/:id/messages
 *   POST /api/v1/internal-chat/channels/:id/messages
 *
 * `denyPlatformOperator()` em todas: o console de plataforma tem chat PROPRIO e
 * nao acessa canais de laboratorio (PAGES.md §11). O service recusa de novo.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type {
  InternalMessage,
  ListChannelsResponse,
  ListInternalMessagesResponse,
} from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import {
  InternalChatService,
  MAX_CONTENT_LENGTH,
  MAX_LIMIT,
  createInternalChatService,
} from '../services/internal-chat.service.js';

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

export function internalChatModule(deps: ApiModuleDeps): ApiModule {
  const service = createInternalChatService(deps.db, deps.wsHub);
  const router = Router();

  router.get('/channels', requireAuth(), denyPlatformOperator(), listChannels(service));

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

  return { basePath: '/internal-chat', router, requiresAuth: true };
}
