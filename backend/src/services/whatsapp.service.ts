/**
 * WhatsAppService — adapter do canal externo (SERVICES.md §11).
 *
 * ============================================================================
 * Tres coisas que este arquivo garante
 * ============================================================================
 *
 * 1. DRIVER MOCK EM DEV/TESTE. `WHATSAPP_API_URL` vazia => `MockWhatsAppDriver`,
 *    que ECOA a mensagem (guarda em `sent` e devolve um `externalId` sintetico).
 *    Nenhuma chamada de rede em dev, em CI ou em teste. Com a URL preenchida,
 *    `HttpWhatsAppDriver` fala com a API de verdade — mesma interface.
 *
 * 2. ASSINATURA HMAC ANTES DE QUALQUER PROCESSAMENTO. `verifyWebhookSignature`
 *    compara com `crypto.timingSafeEqual`, NUNCA com `===`: comparacao de
 *    string curto-circuita no primeiro byte diferente e o tempo de resposta
 *    vira um oraculo para forjar a assinatura byte a byte. Assinatura invalida
 *    => a rota devolve 200 vazio e NADA toca o banco (SECURITY.md "Webhooks":
 *    payload invalido nao ganha oraculo).
 *
 * 3. ENVIO EM FILA COM RETRY EXPONENCIAL (3 tentativas). A fila e a interface
 *    de `src/lib/queue.ts` (D-011: Bull/Redis entra atras dela sem tocar aqui).
 *    O relogio e injetavel, entao o teste de retry roda em milissegundos.
 *
 * ============================================================================
 * CREDENCIAIS POR TENANT
 * ============================================================================
 * Cada laboratorio conecta o proprio numero, entao `send` e o webhook operam
 * sobre `WhatsAppCredentials` resolvidas POR TENANT — nunca sobre uma constante
 * global. Enquanto o schema nao tem tabela de canal (pedido registrado em
 * STATUS.md para o Agent-DB), o resolver default deriva as credenciais das env
 * vars e a IDENTIDADE do tenant do slug que vem na URL do webhook. Trocar isso
 * por uma consulta a tabela e trocar a implementacao do resolver: nenhum outro
 * arquivo muda.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { MessageStatus, MessageType } from '@crm-lab/shared';
import { env } from '../config/env.js';
import type { DbClient } from '../db/types.js';
import { logger } from '../lib/logger.js';
import { createQueue, type QueueService } from '../lib/queue.js';

// ---------------------------------------------------------------------------
// Credenciais
// ---------------------------------------------------------------------------

export interface WhatsAppCredentials {
  tenantId: string;
  /** Numero/id do numero do laboratorio na API do canal. */
  phoneNumberId: string;
  /** Vazia => driver mock. */
  apiUrl: string;
  apiToken: string;
  /** Segredo do HMAC do webhook deste tenant. */
  webhookSecret: string;
}

/**
 * Ponto de extensao para quando as credenciais sairem das env vars e virarem
 * linha de tabela. `byWebhookIdentity` recebe o identificador que o canal
 * manda (slug na URL ou `phone_number_id` no payload).
 */
export interface WhatsAppCredentialsResolver {
  forTenant(tenantId: string): Promise<WhatsAppCredentials>;
  byWebhookIdentity(identity: string): Promise<WhatsAppCredentials | null>;
}

/**
 * Resolver default.
 *
 * O `withoutTenant()` aqui e o MESMO caso do login: o tenant ainda nao e
 * conhecido (o webhook chega sem sessao) e a unica coisa lida e o `id` a partir
 * do slug — nenhum dado de laboratorio. A partir dai TODA escrita acontece
 * dentro de `withTenant()`.
 */
export function createEnvCredentialsResolver(db: DbClient): WhatsAppCredentialsResolver {
  const base = {
    phoneNumberId: env.WHATSAPP_API_TOKEN ? 'default' : 'mock',
    apiUrl: env.WHATSAPP_API_URL ?? '',
    apiToken: env.WHATSAPP_API_TOKEN ?? '',
    webhookSecret: env.WHATSAPP_WEBHOOK_SECRET ?? '',
  };

  return {
    async forTenant(tenantId: string): Promise<WhatsAppCredentials> {
      return { tenantId, ...base };
    },
    async byWebhookIdentity(identity: string): Promise<WhatsAppCredentials | null> {
      const trimmed = identity.trim();
      if (trimmed.length === 0) return null;
      const found = await db.withoutTenant((tx) =>
        tx.query<{ id: string }>(
          `SELECT id FROM tenants
           WHERE (slug = $1 OR id::text = $1) AND is_active = TRUE AND deleted_at IS NULL
           LIMIT 1`,
          [trimmed],
        ),
      );
      const id = found.rows[0]?.id;
      return id ? { tenantId: id, ...base } : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface SendResult {
  externalId: string;
}

export interface WhatsAppDriver {
  readonly name: string;
  send(credentials: WhatsAppCredentials, phone: string, content: string): Promise<SendResult>;
}

export interface MockSentMessage {
  tenantId: string;
  phone: string;
  content: string;
  externalId: string;
  at: string;
}

/**
 * Driver de dev/teste: nao sai da maquina. "Ecoa" no sentido de DEVELOPMENT.md
 * — a mensagem enviada fica registrada em `sent` (e no log) e o envio devolve
 * um `externalId` sintetico, exatamente como faria a API real.
 */
export class MockWhatsAppDriver implements WhatsAppDriver {
  readonly name = 'mock';
  readonly sent: MockSentMessage[] = [];

  async send(
    credentials: WhatsAppCredentials,
    phone: string,
    content: string,
  ): Promise<SendResult> {
    const externalId = `wamid.mock.${randomUUID()}`;
    this.sent.push({
      tenantId: credentials.tenantId,
      phone,
      content,
      externalId,
      at: new Date().toISOString(),
    });
    // Conteudo de mensagem de paciente NUNCA vai para o log (SECURITY.md).
    logger.debug('whatsapp.mock_send', { tenantId: credentials.tenantId, externalId });
    return { externalId };
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/** Driver real. Falha => a fila tenta de novo (retry exponencial). */
export class HttpWhatsAppDriver implements WhatsAppDriver {
  readonly name = 'http';

  async send(
    credentials: WhatsAppCredentials,
    phone: string,
    content: string,
  ): Promise<SendResult> {
    const response = await fetch(`${credentials.apiUrl}/${credentials.phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credentials.apiToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: content },
      }),
    });

    if (!response.ok) {
      throw new Error(`WhatsApp API respondeu ${response.status}`);
    }
    const payload: unknown = await response.json();
    const externalId = firstMessageId(payload);
    if (!externalId) throw new Error('WhatsApp API nao devolveu id da mensagem');
    return { externalId };
  }
}

function firstMessageId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;
  const first = messages[0];
  if (typeof first !== 'object' || first === null) return null;
  const id = (first as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

/** `WHATSAPP_API_URL` vazia => mock (SERVICES.md §11, CONVENTIONS.md). */
export function createDefaultDriver(): WhatsAppDriver {
  const url = env.WHATSAPP_API_URL;
  return url && url.trim().length > 0 ? new HttpWhatsAppDriver() : new MockWhatsAppDriver();
}

// ---------------------------------------------------------------------------
// Assinatura HMAC
// ---------------------------------------------------------------------------

/** Calcula `sha256=<hex>` sobre o corpo cru — o formato que o canal envia. */
export function signWebhookBody(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

/**
 * Comparacao em TEMPO CONSTANTE. `timingSafeEqual` exige buffers do mesmo
 * tamanho, entao o tamanho diferente e recusado antes (isso nao vaza nada: o
 * tamanho do digest e publico).
 */
export function safeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * `true` somente quando a assinatura confere. Segredo vazio => `false`: um
 * webhook sem segredo configurado nao pode ser tratado como autentico.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!secret || secret.length === 0) return false;
  if (typeof signature !== 'string' || signature.length === 0) return false;
  return safeEquals(signWebhookBody(rawBody, secret), signature.trim());
}

// ---------------------------------------------------------------------------
// DTOs de entrada
// ---------------------------------------------------------------------------

/** Mensagem recebida do paciente, ja normalizada. */
export interface InboundMessageDTO {
  /** Telefone do paciente como veio do canal. */
  phone: string;
  /** Nome do perfil, quando o canal informa. */
  patientName: string | null;
  content: string;
  messageType: MessageType;
  attachmentUrl: string | null;
  /** Id do canal — usado para dedupe (SECURITY.md "Webhooks"). */
  externalId: string | null;
}

export interface StatusCallbackDTO {
  externalId: string;
  status: MessageStatus;
}

/** Mapa status do canal -> `MessageStatus` do contrato. */
const STATUS_MAP: Record<string, MessageStatus> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
  undelivered: 'failed',
};

const TYPE_MAP: Record<string, MessageType> = {
  text: 'text',
  image: 'image',
  audio: 'audio',
  voice: 'audio',
  document: 'doc',
  pdf: 'pdf',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Extrai o `value` de cada `entry[].changes[]` do payload da Meta. Payload em
 * outro formato simplesmente nao produz `value` nenhum — nunca lanca.
 */
function changeValues(payload: unknown): Record<string, unknown>[] {
  const root = asRecord(payload);
  if (!root) return [];
  const out: Record<string, unknown>[] = [];
  for (const entry of asArray(root.entry)) {
    const entryRecord = asRecord(entry);
    if (!entryRecord) continue;
    for (const change of asArray(entryRecord.changes)) {
      const value = asRecord(asRecord(change)?.value);
      if (value) out.push(value);
    }
  }
  return out;
}

function contactNames(value: Record<string, unknown>): Map<string, string> {
  const names = new Map<string, string>();
  for (const contact of asArray(value.contacts)) {
    const record = asRecord(contact);
    if (!record) continue;
    const waId = asString(record.wa_id);
    const name = asString(asRecord(record.profile)?.name);
    if (waId && name) names.set(waId, name);
  }
  return names;
}

function contentOf(message: Record<string, unknown>): { content: string; url: string | null } {
  const type = asString(message.type) ?? 'text';
  const body = asString(asRecord(message.text)?.body);
  if (body) return { content: body, url: null };

  const media = asRecord(message[type]);
  const caption = asString(media?.caption);
  const link = asString(media?.link);
  return { content: caption ?? `[${type}]`, url: link };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface WhatsAppServiceDeps {
  credentials: WhatsAppCredentialsResolver;
  driver?: WhatsAppDriver;
  queue?: QueueService;
  /** Tentativas totais do envio. SERVICES.md §11 exige 3. */
  attempts?: number;
}

export class WhatsAppService {
  readonly driver: WhatsAppDriver;
  private readonly queue: QueueService;
  private readonly credentials: WhatsAppCredentialsResolver;
  private readonly attempts: number;

  constructor(deps: WhatsAppServiceDeps) {
    this.credentials = deps.credentials;
    this.driver = deps.driver ?? createDefaultDriver();
    this.queue = deps.queue ?? createQueue();
    this.attempts = deps.attempts ?? 3;
  }

  /**
   * Envia pela fila, com retry exponencial. Esgotadas as tentativas, PROPAGA o
   * erro: quem chama (MessageService) e que marca a mensagem como `failed` e
   * devolve `MESSAGE_SEND_FAILED` (502) — o adapter nao conhece o contrato HTTP.
   */
  async send(tenantId: string, phone: string, content: string): Promise<SendResult> {
    const credentials = await this.credentials.forTenant(tenantId);
    return this.queue.run(
      'whatsapp.send',
      () => this.driver.send(credentials, phone, content),
      { attempts: this.attempts },
    );
  }

  /** Credenciais do tenant identificado pelo webhook. `null` = desconhecido. */
  async resolveWebhookTenant(identity: string): Promise<WhatsAppCredentials | null> {
    return this.credentials.byWebhookIdentity(identity);
  }

  /**
   * Normaliza o payload de entrada.
   *
   * Divergencia de SERVICES.md §11 (registrada em DECISIONS.md): devolve uma
   * LISTA. A Meta entrega lote — um POST pode carregar varias mensagens e
   * descartar as demais perderia mensagem de paciente.
   *
   * Aceita tambem o formato simplificado `{ from, text }`, que e o que o driver
   * mock produz em dev. NUNCA lanca: payload malformado devolve lista vazia
   * (SECURITY.md "payload invalido -> 200 vazio").
   */
  async handleWebhook(payload: unknown): Promise<InboundMessageDTO[]> {
    const out: InboundMessageDTO[] = [];

    for (const value of changeValues(payload)) {
      const names = contactNames(value);
      for (const raw of asArray(value.messages)) {
        const message = asRecord(raw);
        if (!message) continue;
        const from = asString(message.from);
        if (!from) continue;
        const { content, url } = contentOf(message);
        out.push({
          phone: from,
          patientName: names.get(from) ?? null,
          content,
          messageType: TYPE_MAP[asString(message.type) ?? 'text'] ?? 'text',
          attachmentUrl: url,
          externalId: asString(message.id),
        });
      }
    }

    if (out.length === 0) {
      const flat = asRecord(payload);
      const from = flat ? (asString(flat.from) ?? asString(flat.phone)) : null;
      const content = flat ? (asString(flat.text) ?? asString(flat.content)) : null;
      if (from && content) {
        out.push({
          phone: from,
          patientName: flat ? asString(flat.name) : null,
          content,
          messageType: TYPE_MAP[(flat && asString(flat.type)) ?? 'text'] ?? 'text',
          attachmentUrl: null,
          externalId: flat ? asString(flat.externalId) : null,
        });
      }
    }

    return out;
  }

  /**
   * Normaliza o callback de status. Mesma divergencia de `handleWebhook`:
   * devolve lista, porque o canal entrega lote. Nunca lanca.
   */
  async handleStatusCallback(payload: unknown): Promise<StatusCallbackDTO[]> {
    const out: StatusCallbackDTO[] = [];

    for (const value of changeValues(payload)) {
      for (const raw of asArray(value.statuses)) {
        const record = asRecord(raw);
        if (!record) continue;
        const externalId = asString(record.id);
        const status = STATUS_MAP[asString(record.status) ?? ''];
        if (externalId && status) out.push({ externalId, status });
      }
    }

    if (out.length === 0) {
      const flat = asRecord(payload);
      const externalId = flat ? (asString(flat.externalId) ?? asString(flat.id)) : null;
      const status = flat ? STATUS_MAP[asString(flat.status) ?? ''] : undefined;
      if (externalId && status) out.push({ externalId, status });
    }

    return out;
  }
}

/** Monta o adapter com o driver e a fila default (mock em dev/teste). */
export function createWhatsAppService(
  db: DbClient,
  overrides: Partial<WhatsAppServiceDeps> = {},
): WhatsAppService {
  return new WhatsAppService({
    credentials: overrides.credentials ?? createEnvCredentialsResolver(db),
    ...(overrides.driver !== undefined ? { driver: overrides.driver } : {}),
    ...(overrides.queue !== undefined ? { queue: overrides.queue } : {}),
    ...(overrides.attempts !== undefined ? { attempts: overrides.attempts } : {}),
  });
}
