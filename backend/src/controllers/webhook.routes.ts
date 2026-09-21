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
import { createHash } from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { env } from '../config/env.js';
import type { DbClient } from '../db/types.js';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { rateLimit } from '../http/middleware/rate-limit.js';
import type { CacheService } from '../lib/cache.js';
import type { WsHub } from '../lib/ws-hub.js';
import {
  EVOLUTION_QR_TTL_SECONDS,
  evolutionInstanceName,
  evolutionQrCacheKey,
} from '../lib/evolution-client.js';
import { logger } from '../lib/logger.js';
import * as channelSettingsRepo from '../repositories/channel-settings.repository.js';
import { ConversationRepository } from '../repositories/conversation.repository.js';
import { MediaRepository } from '../repositories/media.repository.js';
import { MessageRepository } from '../repositories/message.repository.js';
import { createAuditService } from '../services/audit.service.js';
import { ConversationService } from '../services/conversation.service.js';
import { MediaService, messageTypeFromMime } from '../services/media.service.js';
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

/**
 * Anti-replay (CRMLAB-38 item 5, D-149). HMAC/token provam que o REMETENTE e
 * legitimo, nao que a requisicao e NOVA — um corpo capturado (proxy, log,
 * MITM antes do TLS) e reenviavel indefinidamente com assinatura valida.
 * `messages.external_id` (019_messages_external_id_unique.sql) ja impede
 * duplicar a MENSAGEM; isto cobre o que sobra: callbacks de status/conexao
 * repetidos, que nao tem `external_id` nenhum pra colidir contra.
 *
 * TTL curto (10 min): o objetivo e recusar um replay LOGO em seguida
 * (a janela realista de um MITM ou de um proxy reentregando), nao guardar
 * hash pra sempre — isso so cresceria o Redis sem beneficio adicional.
 */
const REPLAY_TTL_SECONDS = 600;

export function replayKey(tenantId: string, rawBody: string): string {
  const digest = createHash('sha256').update(rawBody).digest('hex');
  return `webhook:replay:${tenantId}:${digest}`;
}

/**
 * `true` = corpo ja visto para este tenant nos ultimos 10 min. Marca como visto
 * de qualquer forma.
 *
 * `incr` e nao get-entao-set (correcao da revisao deste card): `get` seguido de
 * `set` nao e atomico e dois replays identicos chegando juntos passavam os DOIS
 * pelo `get` antes de qualquer `set`. `incr` e atomico nas duas implementacoes
 * de `CacheService` (`INCR` no Redis, um contador so no `MemoryCache`) e ja
 * renova o TTL: quem recebe `1` e o primeiro, o resto e replay.
 */
export async function isReplay(cache: CacheService, tenantId: string, rawBody: string): Promise<boolean> {
  const key = replayKey(tenantId, rawBody);
  return (await cache.incr(key, REPLAY_TTL_SECONDS)) > 1;
}

/**
 * Eventos cujo corpo se REPETE de forma legitima e cuja aplicacao e idempotente
 * (correcao da revisao deste card).
 *
 * `CONNECTION_UPDATE` nao tem id nem timestamp: o corpo de um `state: 'open'` e
 * byte a byte igual ao do `open` anterior. Num flap open -> close -> open dentro
 * de 10 min, o segundo `open` cairia como replay e o canal ficaria marcado como
 * desconectado no banco, na tela e no WS ate o proximo flap — pior do que o
 * replay que a guarda evita, porque aqui reaplicar o estado nao causa dano
 * nenhum (`markWhatsAppConnected/Disconnected` e idempotente).
 */
export function replayExempt(req: Request): boolean {
  const body = asRecord(req.body);
  const event = normalizeEvolutionEvent(body ? asNonEmptyString(body.event) : null);
  return event === 'CONNECTION_UPDATE';
}

/** Resposta unica de todos os caminhos — nao e oraculo de nada. */
function acknowledge(res: Response): void {
  res.status(200).json({ received: true });
}

export interface WebhookServices {
  whatsapp: WhatsAppService;
  conversations: ConversationService;
  messages: MessageService;
  media: MediaService;
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
  const media = new MediaService(new MediaRepository(deps.db));
  return { whatsapp, conversations, messages, media };
}

/**
 * Autentica o webhook: resolve o tenant e confere o HMAC.
 * `null` = requisicao recusada; o chamador responde 200 e para.
 */
async function authenticate(
  req: Request,
  services: WebhookServices,
  cache: CacheService,
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

  // Anti-replay (CRMLAB-38 item 5, D-149) — ver comentario de `isReplay` acima.
  if (await isReplay(cache, credentials.tenantId, rawBodyOf(req))) {
    logger.warn('whatsapp.webhook_replay', { tenantId: credentials.tenantId });
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

export function whatsappInbound(services: WebhookServices, cache: CacheService): RequestHandler {
  return safeHandle(async (req, res) => {
    const authenticated = await authenticate(req, services, cache);
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

export function whatsappStatus(services: WebhookServices, cache: CacheService): RequestHandler {
  return safeHandle(async (req, res) => {
    const authenticated = await authenticate(req, services, cache);
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
  cache: CacheService,
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
  // Anti-replay (CRMLAB-38 item 5, D-149) — mesma logica de `authenticate()`
  // acima; sem checagem de timestamp (payload do Evolution nao tem campo
  // equivalente ao da Meta). `CONNECTION_UPDATE` fica de fora (`replayExempt`).
  if (!replayExempt(req) && (await isReplay(cache, credentials.tenantId, rawBodyOf(req)))) {
    logger.warn('evolution.webhook_replay', { tenantId: credentials.tenantId });
    return null;
  }
  return { tenantId: credentials.tenantId };
}

/** Mídia reconhecida em `message.<key>Message` (Onda 8 §4.2). */
interface EvolutionInboundMedia {
  mimeType: string;
  fileName: string;
  base64: string;
}

interface EvolutionInboundMessage {
  phone: string;
  text: string;
  media: EvolutionInboundMedia | null;
  name: string | null;
  externalId: string | null;
}

/**
 * Submensagens que carregam arquivo. `video` e `sticker` entraram na auditoria
 * de 2026-09-17: o parser so conhecia imagem/audio/documento, entao um video
 * de paciente era DESCARTADO em silencio — o pior desfecho possivel, porque o
 * atendente nunca fica sabendo que recebeu algo.
 *
 * Nenhum tipo novo em `MessageType` (`shared/types/conversation.types.ts`):
 * `messageTypeFromMime` ja mapeia `video/*` para `doc`, entao o video chega
 * como anexo em vez de sumir. Anexo generico e pior que um player dedicado,
 * mas e MUITO melhor que perda silenciosa, e nao espalha mudanca de contrato
 * pelo frontend inteiro. Trocar por um `video` de verdade e evolucao proxima,
 * nao pre-requisito para parar a perda.
 */
const MEDIA_MESSAGE_KEYS = [
  'imageMessage',
  'audioMessage',
  'documentMessage',
  'videoMessage',
  'stickerMessage',
] as const;

const DEFAULT_MEDIA_NAME: Record<(typeof MEDIA_MESSAGE_KEYS)[number], string> = {
  imageMessage: 'imagem',
  audioMessage: 'audio',
  documentMessage: 'documento',
  videoMessage: 'video',
  stickerMessage: 'figurinha',
};

/**
 * Tipos SEM arquivo que viravam descarte silencioso: localizacao e contato
 * compartilhado. Nao tem midia nem texto proprio, entao caiam no
 * `!text && !media` e sumiam. Agora viram uma linha de texto legivel — o
 * atendente ve que o paciente mandou o endereco, mesmo sem mapa na tela.
 */
function describeNonMedia(message: Record<string, unknown>): string | null {
  const location = asRecord(message.locationMessage) ?? asRecord(message.liveLocationMessage);
  if (location) {
    const lat = location.degreesLatitude;
    const lng = location.degreesLongitude;
    const name = asNonEmptyString(location.name);
    const coords =
      typeof lat === 'number' && typeof lng === 'number' ? `${lat}, ${lng}` : 'sem coordenadas';
    return name ? `[Localizacao] ${name} (${coords})` : `[Localizacao] ${coords}`;
  }

  const contact = asRecord(message.contactMessage);
  if (contact) {
    return `[Contato] ${asNonEmptyString(contact.displayName) ?? 'sem nome'}`;
  }

  const contacts = message.contactsArrayMessage;
  if (asRecord(contacts)) {
    const list = asRecord(contacts)?.contacts;
    const count = Array.isArray(list) ? list.length : 0;
    return `[Contatos] ${count} contato(s) compartilhado(s)`;
  }
  return null;
}

/**
 * `message.imageMessage`/`audioMessage`/`documentMessage`, com o base64
 * habilitado no webhook (`base64: true`, `evolution-client.ts`). O CAMPO exato
 * onde o gateway v2.3.7 coloca o base64 nao foi confirmado contra um payload
 * real (spec Onda 8 §7.4 exige essa verificacao antes de fechar a onda) —
 * este parser tolera as duas posicoes mais prováveis (`base64` dentro do
 * proprio submessage, ou no nivel do `message`) para nao ficar preso a uma
 * suposicao unica.
 */
function evolutionInboundMediaOf(message: Record<string, unknown> | null): EvolutionInboundMedia | null {
  if (!message) return null;
  const topLevelBase64 = asNonEmptyString(message.base64);

  for (const key of MEDIA_MESSAGE_KEYS) {
    const media = asRecord(message[key]);
    if (!media) continue;
    const base64 = asNonEmptyString(media.base64) ?? topLevelBase64;
    if (!base64) continue;
    const mimeType = asNonEmptyString(media.mimetype) ?? 'application/octet-stream';
    const fileName = asNonEmptyString(media.fileName) ?? DEFAULT_MEDIA_NAME[key];
    return { mimeType, fileName, base64 };
  }
  return null;
}

function mediaCaption(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  for (const key of MEDIA_MESSAGE_KEYS) {
    const caption = asNonEmptyString(asRecord(message[key])?.caption);
    if (caption) return caption;
  }
  return null;
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
function inboundPhoneOf(key: Record<string, unknown> | null): PhoneResult {
  if (!key) return { ok: false, reason: 'payload_sem_key' };
  if (key.fromMe === true) return { ok: false, reason: 'from_me' };
  const jid = asNonEmptyString(key.remoteJid);
  if (!jid) return { ok: false, reason: 'sem_remote_jid' };
  if (jid.endsWith('@g.us')) return { ok: false, reason: 'grupo' };
  const phone = jid.endsWith('@lid') ? phoneFromJid(key.remoteJidAlt) : phoneFromJid(jid);
  if (!phone) {
    return { ok: false, reason: jid.endsWith('@lid') ? 'lid_sem_remote_jid_alt' : 'jid_sem_telefone' };
  }
  return { ok: true, phone };
}

type PhoneResult = { ok: true; phone: string } | { ok: false; reason: DiscardReason };

/**
 * Por que uma mensagem recebida NAO virou mensagem no CRM.
 *
 * Nem todo motivo e defeito: `from_me` e `grupo` sao descarte correto e
 * esperado (o laboratorio respondendo pelo celular, conversa de grupo). O que
 * a auditoria de 2026-09-17 mostrou e que ate o descarte CORRETO precisa ser
 * contavel — sem isso nao da para distinguir "nao chegou nada" de "chegou e o
 * parser jogou fora", e 17% do movimento de um dia sumiu sem ninguem notar.
 */
export type DiscardReason =
  | 'payload_sem_key'
  | 'from_me'
  | 'grupo'
  | 'sem_remote_jid'
  | 'jid_sem_telefone'
  | 'lid_sem_remote_jid_alt'
  | 'tipo_nao_suportado'
  | 'sem_texto_nem_midia'
  | 'midia_recusada'
  | 'erro_no_processamento';

export type EvolutionInboundResult =
  | { ok: true; message: EvolutionInboundMessage }
  | { ok: false; reason: DiscardReason; messageType: string | null };

function evolutionInboundOf(data: unknown): EvolutionInboundResult {
  const record = asRecord(data);
  const messageType = record ? asNonEmptyString(record.messageType) : null;
  if (!record) return { ok: false, reason: 'payload_sem_key', messageType };
  const key = asRecord(record.key);
  const phone = inboundPhoneOf(key);
  if (!phone.ok) return { ok: false, reason: phone.reason, messageType };

  const message = asRecord(record.message);
  const media = evolutionInboundMediaOf(message);
  const text =
    (message && asNonEmptyString(message.conversation)) ??
    (message && asNonEmptyString(asRecord(message.extendedTextMessage)?.text)) ??
    (message && describeNonMedia(message)) ??
    mediaCaption(message);
  if (!text && !media) {
    // Distingue "tipo que este parser nao entende" de "payload vazio": o
    // primeiro e uma lacuna NOSSA que da para fechar, o segundo e lixo.
    const known = message !== null && Object.keys(message).length > 0;
    return { ok: false, reason: known ? 'tipo_nao_suportado' : 'sem_texto_nem_midia', messageType };
  }

  return {
    ok: true,
    message: {
      phone: phone.phone,
      // Sem legenda: o nome do arquivo vira o preview da conversa em vez de "".
      text: text ?? media?.fileName ?? '',
      media,
      name: asNonEmptyString(record.pushName),
      externalId: key ? asNonEmptyString(key.id) : null,
    },
  };
}

/**
 * QR de um evento `QRCODE_UPDATED`. O gateway v2.3.7 manda
 * `{ qrcode: { base64, code, pairingCode } }`; toleramos tambem o `base64` no
 * nivel do `data`, pela mesma razao do parser de midia — nao ficar preso a uma
 * unica suposicao sobre a forma do payload.
 */
function evolutionQrOf(data: unknown): string | null {
  const record = asRecord(data);
  if (!record) return null;
  const qrcode = asRecord(record.qrcode);
  return asNonEmptyString(qrcode?.base64) ?? asNonEmptyString(record.base64);
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
  wsHub: WsHub,
): Promise<void> {
  const state = evolutionConnectionStateOf(data);
  if (!state) return;
  await db.withTenant(tenantId, (tx) =>
    state.connected
      ? channelSettingsRepo.markWhatsAppConnected(tx, tenantId, state.phoneNumber)
      : channelSettingsRepo.markWhatsAppDisconnected(tx, tenantId),
  );

  // A queda PRECISA sair do banco e chegar em alguem. Na auditoria de
  // 2026-09-17 a sessao caiu as 16:17 e o estado so foi gravado: quem estava
  // atendendo continuou achando que o canal respondia, e a descoberta so
  // aconteceu horas depois, por acaso. `error` (nao `info`) porque canal de
  // atendimento caido e incidente, nao rotina — e e o nivel que um alerta de
  // infra consegue filtrar.
  if (state.connected) {
    logger.info('channel.whatsapp_connected', { tenantId });
  } else {
    logger.error('channel.whatsapp_disconnected', { tenantId });
  }
  wsHub.emitToTenant(tenantId, 'channel.connection_changed', {
    channel: 'whatsapp',
    connected: state.connected,
  });
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

export function evolutionInbound(
  services: WebhookServices,
  db: DbClient,
  cache: CacheService,
  wsHub: WsHub,
): RequestHandler {
  return safeHandle(async (req, res) => {
    const authenticated = await authenticateEvolution(req, services, cache);
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
      const parsed = evolutionInboundOf(body?.data);
      if (!parsed.ok) {
        // Este log e a UNICA prova de que a mensagem existiu. Sem ele (o
        // comportamento ate 2026-09-17) o webhook respondia 200 e a mensagem
        // sumia sem deixar rastro — e o gateway nao reentrega, porque 200
        // significa "entregue". Ver `DiscardReason`.
        logger.warn('evolution.inbound_discarded', {
          tenantId,
          reason: parsed.reason,
          messageType: parsed.messageType,
        });
      }
      const inbound = parsed.ok ? parsed.message : null;
      if (inbound) {
        try {
          // WORKFLOWS §1, mesmo caminho do webhook da Meta.
          const conversation = await services.conversations.findOrCreateByPhone(
            tenantId,
            inbound.phone,
            inbound.name,
          );

          if (inbound.media) {
            // Mídia recusada (tamanho, §4.2 "recusa com log explicito"): a
            // mensagem NAO e criada — nao ha o que mostrar sem o arquivo, mas
            // o webhook responde 200 do mesmo jeito (`acknowledge` no fim).
            const stored = await services.media.storeInbound(tenantId, inbound.media);
            if (stored) {
              // `stored.mimeType` (nao `inbound.media.mimeType`): allow-list e
              // sniff de magic bytes (CRMLAB-31) podem rebaixar o MIME
              // declarado para `application/octet-stream` — o `messageType`
              // precisa refletir o que foi REALMENTE gravado e servido, senao
              // a bolha tenta abrir como imagem/pdf um anexo generico.
              const message = await services.messages.createFromPatient(tenantId, conversation.id, {
                content: inbound.text,
                messageType: messageTypeFromMime(stored.mimeType),
                attachmentUrl: `/api/v1/media/${stored.id}`,
                externalId: inbound.externalId,
              });
              await services.media.attachToMessage(tenantId, stored.id, message.id);
            } else {
              // Continua sem criar mensagem (spec Onda 8 §4.2), mas agora
              // DEIXA RASTRO: antes o arquivo recusado sumia junto com a
              // mensagem e ninguem conseguia saber que o paciente tentou
              // mandar algo.
              logger.warn('evolution.inbound_discarded', {
                tenantId,
                reason: 'midia_recusada' satisfies DiscardReason,
                messageType: inbound.media.mimeType,
              });
            }
          } else {
            await services.messages.createFromPatient(tenantId, conversation.id, {
              content: inbound.text,
              messageType: 'text',
              attachmentUrl: null,
              externalId: inbound.externalId,
            });
          }
        } catch (err) {
          logger.error('evolution.inbound_message_rejected', {
            tenantId,
            externalId: inbound.externalId,
            discardReason: 'erro_no_processamento' satisfies DiscardReason,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } else if (event === 'CONNECTION_UPDATE') {
      await applyEvolutionConnectionUpdate(db, tenantId, body?.data, wsHub);
    } else if (event === 'QRCODE_UPDATED') {
      // O QR passa a chegar POR AQUI em vez de ser buscado a cada polling.
      // `GET /settings/channels/whatsapp/qr` le desta chave; sem isso, cada
      // polling do modal chamava `/instance/connect`, que recria a conexao
      // Baileys — 169 sockets em 3 minutos na auditoria de 2026-09-17.
      const qrcode = evolutionQrOf(body?.data);
      if (qrcode) {
        await cache.set(evolutionQrCacheKey(tenantId), qrcode, EVOLUTION_QR_TTL_SECONDS);
      }
    }
    // Eventos desconhecidos: sem efeito no banco de proposito.

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
export function evolutionStatus(
  services: WebhookServices,
  db: DbClient,
  cache: CacheService,
  wsHub: WsHub,
): RequestHandler {
  return safeHandle(async (req, res) => {
    const authenticated = await authenticateEvolution(req, services, cache);
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
    await applyEvolutionConnectionUpdate(db, tenantId, data, wsHub);

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

  // Balde PROPRIO do webhook. O limitador global pula estas rotas
  // (`isChannelWebhook`), mas rota publica sem teto nenhum seria amplificador:
  // o que muda e que o teto passa a ser o de uma maquina que reentrega, nao o
  // de uma pessoa navegando.
  router.use(rateLimit({ cache: deps.cache, limit: env.RATE_LIMIT_WEBHOOK_PER_MINUTE }));

  router.post('/whatsapp', whatsappInbound(services, deps.cache));
  router.post('/whatsapp/status', whatsappStatus(services, deps.cache));
  router.post('/whatsapp/:tenant', whatsappInbound(services, deps.cache));
  router.post('/whatsapp/:tenant/status', whatsappStatus(services, deps.cache));

  router.post('/evolution/:tenant', evolutionInbound(services, deps.db, deps.cache, deps.wsHub));
  router.post(
    '/evolution/:tenant/status',
    evolutionStatus(services, deps.db, deps.cache, deps.wsHub),
  );

  return { basePath: '/webhooks', router, requiresAuth: false };
}
