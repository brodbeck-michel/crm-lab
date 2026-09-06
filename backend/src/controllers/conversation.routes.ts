/**
 * Rotas de conversas — API_CONTRACTS.md §2.
 *
 *   GET   /api/v1/conversations             lista + counts dos chips
 *   GET   /api/v1/conversations/assignees   quem pode receber conversa (menu Transferir)
 *   POST  /api/v1/conversations             atendimento manual (201)
 *   GET   /api/v1/conversations/:id         conversa + mensagens (marca como lida)
 *   POST  /api/v1/conversations/:id/messages  envia mensagem (201)
 *   PATCH /api/v1/conversations/:id         status / assignedTo / tags
 *   POST  /api/v1/conversations/:id/read    zera o contador de nao lidas (204)
 *   POST  /api/v1/conversations/:id/pin     fixa a conversa para o usuario (204)
 *   DELETE /api/v1/conversations/:id/pin    desafixa (204)
 *
 * `denyPlatformOperator()` em TODAS elas. PAGES.md §11 e explicito: o console
 * da plataforma nao acessa conversas nem pacientes — "requisito, nao
 * configuracao". Por isso a barreira e da rota, e nao uma opcao de perfil.
 *
 * Controller fino (CONVENTIONS.md): valida o DTO, chama o service, responde.
 * `tenantId` vem SEMPRE de `getContext(req)` — nunca de query/body/header.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type {
  CreateConversationRequest,
  CreateConversationResponse,
  GetConversationResponse,
  ListAssigneesResponse,
  ListConversationsQuery,
  ListConversationsResponse,
  Message,
  UpdateConversationRequest,
  UpdateConversationResponse,
} from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { ConversationRepository, phoneDigits } from '../repositories/conversation.repository.js';
import { MessageRepository } from '../repositories/message.repository.js';
import { createAuditService } from '../services/audit.service.js';
import { ConversationService, MAX_LIMIT } from '../services/conversation.service.js';
import { MAX_MESSAGE_LIMIT, MessageService } from '../services/message.service.js';
import { createWhatsAppService, type WhatsAppService } from '../services/whatsapp.service.js';

export const listConversationsQuerySchema = z.object({
  status: z.enum(['active', 'archived', 'closed']).optional(),
  scope: z.enum(['mine', 'unassigned', 'all']).optional(),
  search: z
    .string()
    .max(120)
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
    }),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  sortBy: z.enum(['lastMessageAt', 'createdAt', 'unreadCount', 'patientName']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

/** `?messageLimit=50&page=1` — o nome vem do contrato (API_CONTRACTS.md §2). */
export const getConversationQuerySchema = z.object({
  messageLimit: z.coerce.number().int().min(1).max(MAX_MESSAGE_LIMIT).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_MESSAGE_LIMIT).optional(),
  page: z.coerce.number().int().min(1).optional(),
});

/**
 * `POST /conversations` — atendimento que nao veio do WhatsApp.
 *
 * `channel` NAO aceita `whatsapp`: aquela conversa nasce so pelo webhook, que
 * dedupe por `externalId`. Telefone e a chave de deduplicacao, entao vale a
 * mesma normalizacao por digitos da busca (`phoneDigits`) — 10 a 13 digitos
 * cobre fixo com DDD ate celular com codigo do pais.
 */
export const createConversationSchema = z.object({
  patientPhone: z
    .string()
    .trim()
    .max(20)
    .refine((value) => {
      const digits = phoneDigits(value).length;
      return digits >= 10 && digits <= 13;
    }, 'Telefone invalido'),
  patientName: z.string().trim().min(1).max(255),
  patientEmail: z.string().trim().email().max(255).nullish(),
  channel: z.enum(['sms', 'web', 'direct']),
});

export const createMessageSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  messageType: z.enum(['text', 'image', 'audio', 'pdf', 'doc']).optional(),
  attachmentUrl: z.string().max(500).nullish(),
});

export const updateConversationSchema = z
  .object({
    status: z.enum(['active', 'archived', 'closed']),
    assignedTo: z.string().uuid().nullable(),
    tags: z.array(z.string().trim().min(1).max(50)).max(20),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Informe ao menos um campo para atualizar',
  });

export const conversationIdParamSchema = z.object({ id: z.string().uuid() });

type CreateMessageBody = z.infer<typeof createMessageSchema>;
type GetConversationQuery = z.infer<typeof getConversationQuerySchema>;

export interface ConversationModuleOverrides {
  /** Injetado nos testes de retry/falha do canal externo. */
  whatsapp?: WhatsAppService;
}

export interface ConversationServices {
  conversations: ConversationService;
  messages: MessageService;
}

/** Monta services + repositorios a partir das dependencias do kernel. */
export function createConversationServices(
  deps: ApiModuleDeps,
  overrides: ConversationModuleOverrides = {},
): ConversationServices {
  const conversationRepository = new ConversationRepository(deps.db);
  const messageRepository = new MessageRepository(deps.db);
  const audit = createAuditService(deps.db);
  const messages = new MessageService({
    messages: messageRepository,
    conversations: conversationRepository,
    wsHub: deps.wsHub,
    whatsapp: overrides.whatsapp ?? createWhatsAppService(deps.db),
  });
  const conversations = new ConversationService({
    db: deps.db,
    conversations: conversationRepository,
    messages,
    audit,
  });
  return { conversations, messages };
}

/** `Promise` rejeitada em handler async precisa chegar no error-handler. */
function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function listConversations(service: ConversationService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const filters = validated<ListConversationsQuery>(req, 'query');
    const body: ListConversationsResponse = await service.list(ctx, filters);
    res.status(200).json(body);
  });
}

export function listAssignees(service: ConversationService): RequestHandler {
  return handle(async (req, res) => {
    const body: ListAssigneesResponse = {
      assignees: await service.listAssignees(getContext(req)),
    };
    res.status(200).json(body);
  });
}

export function getConversation(services: ConversationServices): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const query = validated<GetConversationQuery>(req, 'query');

    // ABRIR A CONVERSA E MARCA-LA COMO LIDA (PAGES.md §2 "Ao abrir: markAsRead").
    // O exemplo de API_CONTRACTS.md §2 mostra o detalhe com `unreadCount: 0` e
    // as mensagens do paciente ja em `status: "read"` — enquanto a MESMA
    // conversa aparece na listagem com `unreadCount: 3`. Ou seja: quem zera o
    // contador e este GET. `markAsRead` aplica o recorte por papel e lanca 404
    // para conversa que o usuario nao pode ver, entao vem antes de tudo.
    await services.conversations.markAsRead(ctx, id);
    const conversation = await services.conversations.getById(ctx, id);
    // `messageLimit` e o nome do contrato; `limit` fica como alias tolerante.
    const messageLimit = query.messageLimit ?? query.limit;
    const page = await services.messages.listByConversation(ctx.tenantId, id, {
      ...(query.page !== undefined ? { page: query.page } : {}),
      ...(messageLimit !== undefined ? { limit: messageLimit } : {}),
    });

    const body: GetConversationResponse = {
      conversation,
      messages: page.messages,
      pagination: page.pagination,
    };
    res.status(200).json(body);
  });
}

export function createConversation(service: ConversationService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const dto = validated<CreateConversationRequest>(req, 'body');
    const body: CreateConversationResponse = await service.createManual(ctx, dto);
    res.status(201).json(body);
  });
}

export function createMessage(services: ConversationServices): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<CreateMessageBody>(req, 'body');

    // Recorte por papel antes de escrever: 404 para conversa que nao e visivel.
    await services.conversations.getById(ctx, id);

    const message: Message = await services.messages.createFromAgent(ctx.tenantId, id, ctx.userId, {
      content: dto.content,
      ...(dto.messageType !== undefined ? { messageType: dto.messageType } : {}),
      ...(dto.attachmentUrl !== undefined ? { attachmentUrl: dto.attachmentUrl } : {}),
    });
    res.status(201).json(message);
  });
}

export function updateConversation(service: ConversationService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const patch = validated<UpdateConversationRequest>(req, 'body');
    const updated = await service.update(ctx, id, patch);

    const body: UpdateConversationResponse = {
      id: updated.id,
      status: updated.status,
      assignedTo: updated.assignedTo,
      assignedToName: updated.assignedToName,
      tags: updated.tags,
    };
    res.status(200).json(body);
  });
}

/** `POST /:id/pin` e `DELETE /:id/pin` — o mesmo handler, dois verbos. */
export function setConversationPinned(
  service: ConversationService,
  pinned: boolean,
): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    await service.setPinned(getContext(req), id, pinned);
    res.status(204).end();
  });
}

export function markConversationAsRead(service: ConversationService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    await service.markAsRead(ctx, id);
    res.status(204).end();
  });
}

/**
 * Factory parametrizavel — os testes injetam o adapter do canal externo
 * (driver que falha, fila com relogio falso) sem tocar no modulo default.
 */
export function makeConversationModule(
  overrides: ConversationModuleOverrides = {},
): (deps: ApiModuleDeps) => ApiModule {
  return (deps) => buildConversationModule(deps, overrides);
}

export function conversationModule(deps: ApiModuleDeps): ApiModule {
  return buildConversationModule(deps, {});
}

function buildConversationModule(
  deps: ApiModuleDeps,
  overrides: ConversationModuleOverrides,
): ApiModule {
  const services = createConversationServices(deps, overrides);
  const router = Router();

  const guards = [requireAuth(), denyPlatformOperator()];

  router.get(
    '/',
    ...guards,
    validate(listConversationsQuerySchema, 'query'),
    listConversations(services.conversations),
  );

  router.post(
    '/',
    ...guards,
    validate(createConversationSchema, 'body'),
    createConversation(services.conversations),
  );

  // ANTES de `/:id`: registrada depois, o validador de uuid rejeitaria
  // "assignees" com 400 antes de este handler existir para o Express.
  router.get('/assignees', ...guards, listAssignees(services.conversations));

  router.get(
    '/:id',
    ...guards,
    validate(conversationIdParamSchema, 'params'),
    validate(getConversationQuerySchema, 'query'),
    getConversation(services),
  );

  router.post(
    '/:id/messages',
    ...guards,
    validate(conversationIdParamSchema, 'params'),
    validate(createMessageSchema, 'body'),
    createMessage(services),
  );

  router.patch(
    '/:id',
    ...guards,
    validate(conversationIdParamSchema, 'params'),
    validate(updateConversationSchema, 'body'),
    updateConversation(services.conversations),
  );

  router.post(
    '/:id/pin',
    ...guards,
    validate(conversationIdParamSchema, 'params'),
    setConversationPinned(services.conversations, true),
  );

  router.delete(
    '/:id/pin',
    ...guards,
    validate(conversationIdParamSchema, 'params'),
    setConversationPinned(services.conversations, false),
  );

  router.post(
    '/:id/read',
    ...guards,
    validate(conversationIdParamSchema, 'params'),
    markConversationAsRead(services.conversations),
  );

  return { basePath: '/conversations', router, requiresAuth: true };
}
