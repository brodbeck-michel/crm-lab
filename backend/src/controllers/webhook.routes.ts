/**
 * Webhooks do canal externo — PUBLICOS, sem JWT.
 *
 *   POST /api/v1/webhooks/whatsapp/:tenant          mensagem recebida
 *   POST /api/v1/webhooks/whatsapp/:tenant/status   callback de status
 *   POST /api/v1/webhooks/whatsapp                  idem, tenant no corpo
 *
 * ============================================================================
 * O que substitui o JWT aqui
 * ============================================================================
 * A assinatura HMAC. Ela e verificada ANTES de qualquer leitura util do payload
 * e ANTES de qualquer toque no banco (SECURITY.md "Webhooks"). Assinatura
 * ausente/errada: log e ponto final — nenhuma conversa criada, nenhuma mensagem
 * gravada.
 *
 * A comparacao usa `crypto.timingSafeEqual` (ver `whatsapp.service.ts`), nao
 * `===`: comparacao de string para no primeiro byte diferente, e essa diferenca
 * de tempo permite descobrir a assinatura byte a byte.
 *
 * ============================================================================
 * Por que a resposta e SEMPRE 200 `{ received: true }`
 * ============================================================================
 * SECURITY.md: "Payload invalido -> 200 vazio (nao dar oraculo a atacante)".
 * Se a resposta variasse entre assinatura boa e ruim, entre tenant existente e
 * inexistente, ou entre payload conhecido e lixo, ela viraria um oraculo de
 * enumeracao. Entao nao varia. O que aconteceu de verdade fica no log
 * estruturado, com `correlationId`.
 *
 * ============================================================================
 * Tenant sem sessao
 * ============================================================================
 * O webhook chega sem usuario logado, entao o tenant e resolvido pela
 * IDENTIDADE do canal (o slug/uuid na URL ou no corpo) via
 * `WhatsAppService.resolveWebhookTenant`. So DEPOIS de resolvido, toda escrita
 * acontece dentro de `db.withTenant(tenantId, ...)`, com o RLS ligado. Nenhum
 * caminho deste arquivo grava com `withoutTenant()`.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { logger } from '../lib/logger.js';
import { ConversationRepository } from '../repositories/conversation.repository.js';
import { MessageRepository } from '../repositories/message.repository.js';
import { createAuditService } from '../services/audit.service.js';
import { ConversationService } from '../services/conversation.service.js';
import { MessageService } from '../services/message.service.js';
import {
  createWhatsAppService,
  verifyWebhookSignature,
  type WhatsAppService,
} from '../services/whatsapp.service.js';

/** Cabecalhos que carregam a assinatura, em ordem de preferencia. */
const SIGNATURE_HEADERS = ['x-hub-signature-256', 'x-signature-256', 'x-webhook-signature'];

export function signatureOf(req: Request): string | undefined {
  for (const name of SIGNATURE_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Corpo cru sobre o qual o HMAC foi calculado.
 *
 * O kernel aplica `express.json()` globalmente, entao o stream ja foi
 * consumido quando a requisicao chega aqui: reserializamos o objeto ja
 * parseado. Se o kernel um dia guardar os bytes originais em `req.rawBody`
 * (pedido registrado em STATUS.md), este ponto passa a preferi-los sem que
 * mais nada mude.
 */
export function rawBodyOf(req: Request): string {
  const candidate = (req as Request & { rawBody?: unknown }).rawBody;
  if (typeof candidate === 'string') return candidate;
  if (Buffer.isBuffer(candidate)) return candidate.toString('utf8');
  return JSON.stringify(req.body ?? {});
}

/** Identidade do tenant: `/:tenant` na URL ou `tenantSlug`/`tenantId` no corpo. */
export function tenantIdentityOf(req: Request): string {
  const fromPath = req.params.tenant;
  if (typeof fromPath === 'string' && fromPath.length > 0) return fromPath;
  const body: unknown = req.body;
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;
    for (const key of ['tenantSlug', 'tenantId', 'tenant']) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  return '';
}

/** Resposta unica de todos os caminhos — nao e oraculo de nada. */
function acknowledge(res: Response): void {
  res.status(200).json({ received: true });
}

export interface WebhookServices {
  whatsapp: WhatsAppService;
  conversations: ConversationService;
  messages: MessageService;
}

export function createWebhookServices(
  deps: ApiModuleDeps,
  overrides: { whatsapp?: WhatsAppService } = {},
): WebhookServices {
  const whatsapp = overrides.whatsapp ?? createWhatsAppService(deps.db);
  const conversationRepository = new ConversationRepository(deps.db);
  const messages = new MessageService({
    messages: new MessageRepository(deps.db),
    conversations: conversationRepository,
    wsHub: deps.wsHub,
    whatsapp,
  });
  const conversations = new ConversationService({
    db: deps.db,
    conversations: conversationRepository,
    messages,
    audit: createAuditService(deps.db),
  });
  return { whatsapp, conversations, messages };
}

/**
 * Autentica o webhook: resolve o tenant e confere o HMAC.
 * `null` = requisicao recusada; o chamador responde 200 e para.
 */
async function authenticate(
  req: Request,
  services: WebhookServices,
): Promise<{ tenantId: string } | null> {
  const identity = tenantIdentityOf(req);
  const credentials = await services.whatsapp.resolveWebhookTenant(identity);
  if (!credentials) {
    logger.warn('whatsapp.webhook_unknown_tenant', { path: req.originalUrl });
    return null;
  }

  // HMAC ANTES de olhar o conteudo. Nada foi escrito ate aqui.
  const valid = verifyWebhookSignature(
    rawBodyOf(req),
    signatureOf(req),
    credentials.webhookSecret,
  );
  if (!valid) {
    logger.warn('whatsapp.webhook_invalid_signature', { tenantId: credentials.tenantId });
    return null;
  }
  return { tenantId: credentials.tenantId };
}

/** Handler async cujo erro nunca pode virar 500 vazado para o canal. */
function safeHandle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res) => {
    fn(req, res).catch((err: unknown) => {
      // Payload malformado nao pode derrubar o servidor nem virar 500 no canal:
      // o canal reentregaria em loop. Loga e reconhece.
      logger.error('whatsapp.webhook_failed', {
        path: req.originalUrl,
        message: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) acknowledge(res);
    });
  };
}

export function whatsappInbound(services: WebhookServices): RequestHandler {
  return safeHandle(async (req, res) => {
    const authenticated = await authenticate(req, services);
    if (!authenticated) {
      acknowledge(res);
      return;
    }
    const { tenantId } = authenticated;

    const inbound = await services.whatsapp.handleWebhook(req.body);
    for (const dto of inbound) {
      // WORKFLOWS §1: acha/cria a conversa, grava a mensagem, emite o WS.
      const conversation = await services.conversations.findOrCreateByPhone(
        tenantId,
        dto.phone,
        dto.patientName,
      );
      await services.messages.createFromPatient(tenantId, conversation.id, {
        content: dto.content,
        messageType: dto.messageType,
        attachmentUrl: dto.attachmentUrl,
        externalId: dto.externalId,
      });
    }

    logger.info('whatsapp.webhook_processed', { tenantId, messages: inbound.length });
    acknowledge(res);
  });
}

export function whatsappStatus(services: WebhookServices): RequestHandler {
  return safeHandle(async (req, res) => {
    const authenticated = await authenticate(req, services);
    if (!authenticated) {
      acknowledge(res);
      return;
    }
    const { tenantId } = authenticated;

    const updates = await services.whatsapp.handleStatusCallback(req.body);
    for (const update of updates) {
      await services.messages.applyExternalStatus(tenantId, update.externalId, update.status);
    }

    logger.info('whatsapp.status_processed', { tenantId, updates: updates.length });
    acknowledge(res);
  });
}

/**
 * Rotas publicas: NAO usam `requireAuth`. Quem autentica e o HMAC.
 * `requiresAuth: false` deixa isso explicito no registro de modulos.
 */
export function makeWebhookModule(
  overrides: { whatsapp?: WhatsAppService } = {},
): (deps: ApiModuleDeps) => ApiModule {
  return (deps) => buildWebhookModule(deps, overrides);
}

export function webhookModule(deps: ApiModuleDeps): ApiModule {
  return buildWebhookModule(deps, {});
}

function buildWebhookModule(
  deps: ApiModuleDeps,
  overrides: { whatsapp?: WhatsAppService },
): ApiModule {
  const services = createWebhookServices(deps, overrides);
  const router = Router();

  router.post('/whatsapp', whatsappInbound(services));
  router.post('/whatsapp/status', whatsappStatus(services));
  router.post('/whatsapp/:tenant', whatsappInbound(services));
  router.post('/whatsapp/:tenant/status', whatsappStatus(services));

  return { basePath: '/webhooks', router, requiresAuth: false };
}
