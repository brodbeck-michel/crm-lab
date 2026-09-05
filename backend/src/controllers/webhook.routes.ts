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
import { env } from '../config/env.js';
import type { DbClient } from '../db/types.js';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { evolutionInstanceName } from '../lib/evolution-client.js';
import { logger } from '../lib/logger.js';
import * as channelSettingsRepo from '../repositories/channel-settings.repository.js';
import { ConversationRepository } from '../repositories/conversation.repository.js';
import { MessageRepository } from '../repositories/message.repository.js';
import { createAuditService } from '../services/audit.service.js';
import { ConversationService } from '../services/conversation.service.js';
import { MessageService } from '../services/message.service.js';
import {
  createWhatsAppService,
  safeEquals,
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

  // KILL SWITCH (D-074). `isActive: false` e o unico jeito de desligar um canal
  // pelo contrato (nao existe remocao em `PATCH /settings/channels`), entao ele
  // precisa desligar a ENTRADA tambem: um admin que descobre que o segredo
  // vazou desliga o canal e a partir dai assinatura valida nao entra mais.
  // Antes do HMAC de proposito — canal desligado nem chega a usar o segredo.
  if (!credentials.isActive) {
    logger.warn('whatsapp.webhook_channel_disabled', { tenantId: credentials.tenantId });
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
    let processed = 0;
    let rejected = 0;
    for (const dto of inbound) {
      // A Meta entrega LOTE. Uma mensagem ruim (telefone fora do formato,
      // por exemplo) nao pode derrubar o lote inteiro: sem este `try`, o erro
      // subiria ate `safeHandle` e as mensagens SEGUINTES — validas — seriam
      // descartadas junto, sem reentrega pelo canal.
      try {
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
        processed += 1;
      } catch (err) {
        rejected += 1;
        // Telefone/nome do paciente NUNCA vao para o log (SECURITY.md): so o
        // motivo e o id do canal, que ja e um identificador do proprio canal.
        logger.error('whatsapp.inbound_message_rejected', {
          tenantId,
          externalId: dto.externalId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('whatsapp.webhook_processed', {
      tenantId,
      messages: processed,
      rejected,
    });
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

// ---------------------------------------------------------------------------
// Evolution API — WhatsApp por QR (Onda 7, Bloco B)
//
//   POST /api/v1/webhooks/evolution/:tenant           mensagem/estado
//   POST /api/v1/webhooks/evolution/:tenant/status     variante so de estado
//
// Autentica por `EVOLUTION_WEBHOOK_TOKEN` (segredo UNICO da instalacao, header
// `apikey`, comparado em tempo constante — mesma logica de `safeEquals` do HMAC
// acima), NAO por assinatura HMAC do corpo: o gateway Evolution nao assina, ele
// manda a chave configurada. O kill switch (`isActive`) e a resolucao do
// tenant continuam vindo de `WhatsAppService.resolveWebhookTenant`, que ja le
// `tenant_channels` — reuso total do que a Meta ja usa (D-024).
//
// Eventos traduzidos para os MESMOS caminhos internos do webhook da Meta
// (`findOrCreateByPhone` -> `createFromPatient`, dedupe por `externalId`):
//   MESSAGES_UPSERT    -> mensagem do paciente
//   CONNECTION_UPDATE  -> estado do canal (conectado/desconectado), SEM mensagem
//   QRCODE_UPDATED     -> sem efeito (o QR e servido por polling em
//                         GET /settings/channels/whatsapp/qr, nao pelo webhook)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `"5548999998888@s.whatsapp.net"` -> `"5548999998888"`. `null` sem telefone. */
function phoneFromJid(jid: unknown): string | null {
  const raw = asNonEmptyString(jid);
  if (!raw) return null;
  const [phone] = raw.split('@');
  return phone && phone.length > 0 ? phone : null;
}

/**
 * Header que carrega o segredo do webhook Evolution.
 *
 * `x-evolution-webhook-token` e o header DOCUMENTADO (API_CONTRACTS.md:729-735
 * — Regra Zero, e o que a infra configura no gateway self-hosted). `apikey` e
 * TOLERADO como alternativa (ruling do coordenador na revisao da Task 5,
 * Critical 2): mesmo segredo, mesma comparacao em tempo constante, entao
 * aceitar os dois nao enfraquece nada — mas o header documentado tem que
 * funcionar, e antes so `apikey` funcionava.
 */
/**
 * O gateway v2.3.7 manda `messages.upsert`/`connection.update` — MINUSCULO e
 * separado por PONTO. A documentacao (API_CONTRACTS.md) e esta rota assumiam
 * `MESSAGES_UPSERT`/`CONNECTION_UPDATE`, entao a comparacao exata nunca batia
 * contra um gateway de verdade: mensagem recebida sumia em silencio, estado da
 * conexao nunca era gravado e a guarda de `instance` (substituicao de slug)
 * virava codigo morto. Normalizar num lugar so aceita as DUAS grafias.
 */
function normalizeEvolutionEvent(raw: string | null): string | null {
  return raw ? raw.toUpperCase().replace(/\./g, '_') : null;
}

function evolutionTokenOf(req: Request): string | undefined {
  const documented = req.headers['x-evolution-webhook-token'];
  if (typeof documented === 'string' && documented.length > 0) return documented;
  const tolerated = req.headers.apikey;
  return typeof tolerated === 'string' && tolerated.length > 0 ? tolerated : undefined;
}

function evolutionTokenValid(req: Request): boolean {
  // `process.env` primeiro, igual a `secret-box.ts`: le NO MOMENTO DA CHAMADA
  // (nao congelado no import), o que permite ao teste trocar o token no mesmo
  // processo sem recarregar `env`.
  const expected = process.env.EVOLUTION_WEBHOOK_TOKEN ?? env.EVOLUTION_WEBHOOK_TOKEN;
  if (!expected || expected.length === 0) return false;
  const token = evolutionTokenOf(req);
  if (!token) return false;
  return safeEquals(token, expected);
}

/**
 * Autentica o webhook Evolution: resolve o tenant (mesma identidade da URL do
 * webhook da Meta), confere o kill switch (D-074) e o token — nesta ordem, por
 * consistencia com `authenticate()` acima. `null` = recusado; o chamador
 * responde 200 e para (nunca vira oraculo).
 */
async function authenticateEvolution(
  req: Request,
  services: WebhookServices,
): Promise<{ tenantId: string } | null> {
  const identity = tenantIdentityOf(req);
  const credentials = await services.whatsapp.resolveWebhookTenant(identity);
  if (!credentials) {
    logger.warn('evolution.webhook_unknown_tenant', { path: req.originalUrl });
    return null;
  }
  if (!credentials.isActive) {
    logger.warn('evolution.webhook_channel_disabled', { tenantId: credentials.tenantId });
    return null;
  }
  if (!evolutionTokenValid(req)) {
    logger.warn('evolution.webhook_invalid_token', { tenantId: credentials.tenantId });
    return null;
  }
  return { tenantId: credentials.tenantId };
}

interface EvolutionInboundMessage {
  phone: string;
  text: string;
  name: string | null;
  externalId: string | null;
}

/** `data` de um evento `MESSAGES_UPSERT`. `null` quando faltar telefone ou texto. */
/**
 * Telefone do PACIENTE a partir do `key` da mensagem. Um unico ponto de decisao
 * — `remoteJid` nem sempre e um telefone, e tratar como se fosse cria paciente
 * fantasma que ninguem consegue responder:
 *
 * - `fromMe: true` -> `null`. E mensagem que o proprio numero do laboratorio
 *   enviou (o atendente respondendo pelo celular). Nao e atendimento novo.
 * - `@g.us` -> `null`. Id de GRUPO nao e paciente.
 * - `@lid` -> o telefone vem em `remoteJidAlt`. O WhatsApp passou a enderecar
 *   por LID (identificador privado, ex. `128999376343081@lid`); o LID nao e
 *   discavel, nao casa com o cadastro do paciente e nao serve para responder.
 *   Sem `remoteJidAlt` a mensagem e DESCARTADA de proposito (com log): uma
 *   conversa presa a um LID seria pior que nenhuma — sem resposta e sem dedupe.
 */
function inboundPhoneOf(key: Record<string, unknown> | null): string | null {
  if (!key || key.fromMe === true) return null;
  const jid = asNonEmptyString(key.remoteJid);
  if (!jid || jid.endsWith('@g.us')) return null;
  return jid.endsWith('@lid') ? phoneFromJid(key.remoteJidAlt) : phoneFromJid(jid);
}

function evolutionInboundOf(data: unknown): EvolutionInboundMessage | null {
  const record = asRecord(data);
  if (!record) return null;
  const key = asRecord(record.key);
  const phone = inboundPhoneOf(key);
  if (!phone) return null;

  const message = asRecord(record.message);
  const text =
    (message && asNonEmptyString(message.conversation)) ??
    (message && asNonEmptyString(asRecord(message.extendedTextMessage)?.text));
  if (!text) return null;

  return {
    phone,
    text,
    name: asNonEmptyString(record.pushName),
    externalId: key ? asNonEmptyString(key.id) : null,
  };
}

interface EvolutionConnectionState {
  connected: boolean;
  phoneNumber: string | null;
}

/**
 * `data` de um evento `CONNECTION_UPDATE`. `state: 'open'` -> conectado
 * (`owner`/`wuid` carrega o numero pareado, quando o gateway manda);
 * `'close'` -> desconectado (logout no celular ou banimento — a UI nao
 * distingue, spec §4.2). `'connecting'`/estado desconhecido -> `null`
 * (sem efeito: nem conectado nem desconectado ainda).
 */
function evolutionConnectionStateOf(data: unknown): EvolutionConnectionState | null {
  const record = asRecord(data);
  if (!record) return null;
  if (record.state === 'open') {
    return { connected: true, phoneNumber: phoneFromJid(record.owner ?? record.wuid) };
  }
  if (record.state === 'close') {
    return { connected: false, phoneNumber: null };
  }
  return null;
}

async function applyEvolutionConnectionUpdate(
  db: DbClient,
  tenantId: string,
  data: unknown,
): Promise<void> {
  const state = evolutionConnectionStateOf(data);
  if (!state) return;
  await db.withTenant(tenantId, (tx) =>
    state.connected
      ? channelSettingsRepo.markWhatsAppConnected(tx, tenantId, state.phoneNumber)
      : channelSettingsRepo.markWhatsAppDisconnected(tx, tenantId),
  );
}

/**
 * `true` quando o payload afirma vir da instancia CERTA para este tenant.
 *
 * I4 da revisao da Task 5 (fechada na rodada 1, estendida na rodada 2): o
 * `:tenant` da URL e um SLUG PUBLICO, e o token e UNICO PARA A INSTALACAO
 * INTEIRA (D-073 emendada, mesmo risco de `whatsapp.service.ts` — ver o
 * comentario de `mergeCredentials`) — quem conhece o token pode POSTar em
 * QUALQUER slug. O payload documentado (API_CONTRACTS.md) carrega o nome real
 * da instancia que o gerou (`instance: "tenant-<uuid>"`, exemplo em
 * API_CONTRACTS.md:743); EXIGIR e conferir esse campo contra
 * `evolutionInstanceName(tenantId)` fecha a substituicao de slug de verdade —
 * um payload SEM o campo ou que afirma vir de OUTRA instancia e recusado
 * antes de qualquer escrita, mesmo com token valido (quem so tem o token e o
 * slug publico nao sabe o uuid interno do tenant alheio, que e o que
 * `evolutionInstanceName` usa).
 *
 * NAO e so `evolutionInbound`: `evolutionStatus` (`/status`) grava exatamente
 * o mesmo efeito (`markWhatsAppConnected`/`Disconnected`) por um caminho
 * SEPARADO, inclusive no formato achatado (sem envelope de evento) — a
 * rodada 1 checou so a rota principal e deixou este bypass de um segmento de
 * URL (achado da re-revisao). As DUAS rotas chamam esta MESMA funcao, sobre o
 * MESMO corpo (`body`, nunca so `body.data`), porque o campo `instance` vive
 * no nivel do envelope, nao dentro de `data`.
 */
function instanceClaimMatches(body: Record<string, unknown> | null, tenantId: string): boolean {
  const instanceClaim = body ? asNonEmptyString(body.instance) : null;
  return instanceClaim === evolutionInstanceName(tenantId);
}

export function evolutionInbound(services: WebhookServices, db: DbClient): RequestHandler {
  return safeHandle(async (req, res) => {
    const authenticated = await authenticateEvolution(req, services);
    if (!authenticated) {
      acknowledge(res);
      return;
    }
    const { tenantId } = authenticated;

    const body = asRecord(req.body);
    const event = normalizeEvolutionEvent(body ? asNonEmptyString(body.event) : null);

    if (
      (event === 'MESSAGES_UPSERT' || event === 'CONNECTION_UPDATE') &&
      !instanceClaimMatches(body, tenantId)
    ) {
      logger.warn('evolution.webhook_instance_mismatch', { tenantId, event });
      acknowledge(res);
      return;
    }

    if (event === 'MESSAGES_UPSERT') {
      const inbound = evolutionInboundOf(body?.data);
      if (inbound) {
        try {
          // WORKFLOWS §1, mesmo caminho do webhook da Meta.
          const conversation = await services.conversations.findOrCreateByPhone(
            tenantId,
            inbound.phone,
            inbound.name,
          );
          await services.messages.createFromPatient(tenantId, conversation.id, {
            content: inbound.text,
            messageType: 'text',
            attachmentUrl: null,
            externalId: inbound.externalId,
          });
        } catch (err) {
          logger.error('evolution.inbound_message_rejected', {
            tenantId,
            externalId: inbound.externalId,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } else if (event === 'CONNECTION_UPDATE') {
      await applyEvolutionConnectionUpdate(db, tenantId, body?.data);
    }
    // QRCODE_UPDATED e eventos desconhecidos: sem efeito no banco de proposito.

    logger.info('evolution.webhook_processed', { tenantId, event: event ?? 'desconhecido' });
    acknowledge(res);
  });
}

/**
 * Variante so de estado — mesmo padrao de `/whatsapp/status`. Aceita tanto o
 * envelope `{ event: 'CONNECTION_UPDATE', data }` quanto um payload ja achatado
 * (`{ state, owner }`), porque o gateway pode ser configurado com uma URL de
 * webhook dedicada por evento (`webhookByEvents`).
 */
export function evolutionStatus(services: WebhookServices, db: DbClient): RequestHandler {
  return safeHandle(async (req, res) => {
    const authenticated = await authenticateEvolution(req, services);
    if (!authenticated) {
      acknowledge(res);
      return;
    }
    const { tenantId } = authenticated;
    const body = asRecord(req.body);

    // Mesma checagem de `evolutionInbound` (I4, re-revisao da Task 5): esta
    // rota grava o MESMO efeito (`markWhatsAppConnected`/`Disconnected`) por
    // um caminho SEPARADO — sem isto, um payload recusado em
    // `/webhooks/evolution/:tenant` por `instance` errado passava batido so
    // por adicionar `/status` na URL. O campo `instance` e exigido tambem no
    // formato achatado (sem envelope): o gateway real inclui `instance` no
    // corpo independente de `webhookByEvents`, entao a tolerancia de formato
    // (deviation 4 da revisao) continua valendo so para a AUSENCIA do
    // envelope `{event, data}`, nunca para a ausencia do `instance`.
    if (!instanceClaimMatches(body, tenantId)) {
      logger.warn('evolution.webhook_instance_mismatch', { tenantId, event: 'status' });
      acknowledge(res);
      return;
    }

    const data = body && asNonEmptyString(body.event) === 'CONNECTION_UPDATE' ? body.data : body;
    await applyEvolutionConnectionUpdate(db, tenantId, data);

    logger.info('evolution.status_processed', { tenantId });
    acknowledge(res);
  });
}

/**
 * Rotas publicas: NAO usam `requireAuth`. Quem autentica e o HMAC (Meta) ou o
 * token (Evolution).
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

  router.post('/evolution/:tenant', evolutionInbound(services, deps.db));
  router.post('/evolution/:tenant/status', evolutionStatus(services, deps.db));

  return { basePath: '/webhooks', router, requiresAuth: false };
}
