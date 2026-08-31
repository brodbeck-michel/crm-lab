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
 * CREDENCIAIS POR TENANT — TABELA PRIMEIRO, ENV VAR DEPOIS (D-024)
 * ============================================================================
 * Cada laboratorio conecta o proprio numero, entao `send` e o webhook operam
 * sobre `WhatsAppCredentials` resolvidas POR TENANT — nunca sobre uma constante
 * global. A fonte agora e `tenant_channels`, lida por
 * `ChannelSettingsService.resolveCredentials` (o UNICO ponto que le o segredo em
 * claro, D-064). Cada campo cai para a env var correspondente quando a tabela
 * nao tem valor: um ambiente que ja rodava so com env var continua rodando, e
 * um laboratorio que conectou o proprio numero passa a mandar no proprio.
 *
 * A IDENTIDADE do tenant continua vindo do slug/uuid da URL do webhook — o que
 * a tabela resolve e a CREDENCIAL, inclusive o segredo do HMAC.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ConversationChannel, MessageStatus, MessageType } from '@crm-lab/shared';
import { env } from '../config/env.js';
import type { DbClient } from '../db/types.js';
import {
  createDefaultEvolutionClient,
  evolutionInstanceName,
  type EvolutionClient,
} from '../lib/evolution-client.js';
import { logger } from '../lib/logger.js';
import { createQueue, type QueueService } from '../lib/queue.js';
import type { ChannelCredentials } from '../repositories/channel-settings.repository.js';
import { createAuditService } from './audit.service.js';
import { createChannelSettingsService } from './channel-settings.service.js';

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
  /**
   * Canal LIGADO (D-074). `false` = `tenant_channels.is_active = FALSE`:
   * o webhook nao e aceito e o envio nao sai. Sem linha na tabela (ambiente
   * so-env-var) o canal e considerado ligado.
   */
  isActive: boolean;
  /**
   * O laboratorio APAGOU o token deliberadamente (D-073 emendada). Diferente de
   * "nunca configurou": revogado nao volta para o token global da instalacao.
   */
  apiTokenRevoked: boolean;
  /**
   * Como o canal fala com o provedor (Onda 7, Bloco B). `cloud_api` = API
   * oficial da Meta (`HttpWhatsAppDriver`); `qr` = numero proprio pareado via
   * QR no gateway Evolution (`EvolutionWhatsAppDriver`). Decide o driver em
   * `WhatsAppService.send` — nunca uma constante global, porque cada tenant
   * escolhe o proprio caminho.
   */
  connectionMode: 'cloud_api' | 'qr';
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

/** Credenciais das env vars — o fallback de quem ainda nao conectou o canal. */
export function envCredentials(): Omit<WhatsAppCredentials, 'tenantId'> {
  return {
    phoneNumberId: env.WHATSAPP_API_TOKEN ? 'default' : 'mock',
    apiUrl: env.WHATSAPP_API_URL ?? '',
    apiToken: env.WHATSAPP_API_TOKEN ?? '',
    webhookSecret: env.WHATSAPP_WEBHOOK_SECRET ?? '',
    isActive: true,
    apiTokenRevoked: false,
    // Sem linha em `tenant_channels`, o laboratorio so pode estar no caminho de
    // sempre (API oficial via env var). `qr` so existe depois de um
    // `connectWhatsAppQr` bem-sucedido, que grava a linha.
    connectionMode: 'cloud_api',
  };
}

/**
 * Fonte das credenciais em claro. A implementacao real e
 * `ChannelSettingsService.resolveCredentials`; a interface existe para o teste
 * injetar uma linha de tabela sem montar o service inteiro.
 */
export interface ChannelCredentialsSource {
  resolveCredentials(
    tenantId: string,
    channel: ConversationChannel,
  ): Promise<ChannelCredentials | null>;
}

/**
 * Resolver que so conhece env var. Continua exportado porque a IDENTIDADE do
 * tenant (slug/uuid -> id) e resolvida aqui e nao muda com a tabela.
 *
 * O `withoutTenant()` aqui e o MESMO caso do login: o tenant ainda nao e
 * conhecido (o webhook chega sem sessao) e a unica coisa lida e o `id` a partir
 * do slug — nenhum dado de laboratorio. A partir dai TODA escrita acontece
 * dentro de `withTenant()`.
 */
export function createEnvCredentialsResolver(db: DbClient): WhatsAppCredentialsResolver {
  const base = envCredentials();

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

/**
 * Aplica a precedencia de D-024, CAMPO A CAMPO: o que `tenant_channels` guarda
 * vence; o que estiver ausente (linha inexistente ou coluna nula) cai na env
 * var. Merge por campo, e nao "linha existe => ignora env", porque um
 * laboratorio pode ter conectado o numero e ainda nao ter girado o segredo do
 * webhook — nesse meio do caminho o webhook precisa continuar validando.
 *
 * ============================================================================
 * "NUNCA CONFIGUROU" x "REVOGOU" (D-073 emendada)
 * ============================================================================
 * O fallback so vale para o primeiro caso. A coluna guarda `NULL` quando o
 * laboratorio nunca configurou (fallback legitimo) e `''` quando ele mandou
 * `{"webhookSecret": null}` no PATCH (revogacao). O `??` abaixo respeita a
 * diferenca sozinho — `'' ?? x` e `''` —, e e por isso que a sentinela e string
 * vazia e nao `NULL`.
 *
 * Sem essa distincao, revogar o segredo devolveria `WHATSAPP_WEBHOOK_SECRET`,
 * que e um valor SO PARA A INSTALACAO INTEIRA: quem o conhecesse (operador de
 * infra, `.env` vazado, outro laboratorio da mesma instalacao) assinaria
 * webhook valido para qualquer tenant que ainda nao tivesse girado o proprio —
 * e o slug vai na URL, que e publica. Escrita cross-tenant em
 * `messages`/`conversations`/`patients`.
 *
 * `apiUrl` nao mora na tabela: e endereco da API do canal, nao credencial do
 * laboratorio (e e ela que decide driver mock x driver real).
 */
export function mergeCredentials(
  tenantId: string,
  stored: ChannelCredentials | null,
  fallback: Omit<WhatsAppCredentials, 'tenantId'> = envCredentials(),
): WhatsAppCredentials {
  return {
    tenantId,
    phoneNumberId: stored?.phoneNumberId ?? fallback.phoneNumberId,
    apiUrl: fallback.apiUrl,
    apiToken: stored?.apiToken ?? fallback.apiToken,
    // Segredo vazio continua recusando TUDO (`verifyWebhookSignature`): nada
    // aqui transforma "nao configurado" em "autentico".
    webhookSecret: stored?.webhookSecret ?? fallback.webhookSecret,
    // Sem linha na tabela o canal esta ligado (ambiente so-env-var).
    isActive: stored?.isActive ?? fallback.isActive,
    apiTokenRevoked: stored?.apiToken === '' ? true : fallback.apiTokenRevoked,
    // `connectionMode` so existe na tabela (nunca em env var): sem linha, so
    // resta `cloud_api`.
    connectionMode: stored?.connectionMode ?? fallback.connectionMode,
  };
}

/**
 * Resolver default de producao (D-024): tabela primeiro, env var como fallback.
 *
 * A leitura da tabela acontece FORA de qualquer transacao de escrita — o
 * webhook resolve as credenciais antes de tocar no banco —, entao o
 * `db.withTenant` interno de `resolveCredentials` nao aninha com nada.
 */
export function createTenantCredentialsResolver(
  db: DbClient,
  options: {
    /** Default: `ChannelSettingsService`. O teste injeta uma fonte de mentira. */
    source?: ChannelCredentialsSource;
    /** Default: `envCredentials()`. O teste injeta env vars deterministicas. */
    fallback?: Omit<WhatsAppCredentials, 'tenantId'>;
  } = {},
): WhatsAppCredentialsResolver {
  const identities = createEnvCredentialsResolver(db);
  const channels: ChannelCredentialsSource =
    options.source ?? createChannelSettingsService({ db, audit: createAuditService(db) });
  const fallback = options.fallback ?? envCredentials();

  const withStored = async (tenantId: string): Promise<WhatsAppCredentials> => {
    const stored = await channels.resolveCredentials(tenantId, 'whatsapp');
    return mergeCredentials(tenantId, stored, fallback);
  };

  return {
    async forTenant(tenantId: string): Promise<WhatsAppCredentials> {
      return withStored(tenantId);
    },
    async byWebhookIdentity(identity: string): Promise<WhatsAppCredentials | null> {
      const found = await identities.byWebhookIdentity(identity);
      if (!found) return null;
      return withStored(found.tenantId);
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

/**
 * Driver `connectionMode: 'qr'` (Onda 7, Bloco B) — fala com o gateway Evolution
 * self-hosted em vez da API oficial da Meta. Mesma interface de
 * `HttpWhatsAppDriver`: `WhatsAppService.send` nao sabe qual dos dois esta
 * chamando. `instanceName` e sempre `evolutionInstanceName(credentials.tenantId)`
 * — o MESMO calculo que `ChannelSettingsService.connectWhatsAppQr` usa para criar
 * a instancia, entao os dois nunca divergem.
 */
export class EvolutionWhatsAppDriver implements WhatsAppDriver {
  readonly name = 'evolution';

  constructor(private readonly client: EvolutionClient) {}

  async send(
    credentials: WhatsAppCredentials,
    phone: string,
    content: string,
  ): Promise<SendResult> {
    const instanceName = evolutionInstanceName(credentials.tenantId);
    const { externalId } = await this.client.sendText(instanceName, phone, content);
    return { externalId };
  }
}

export function createEvolutionWhatsAppDriver(client: EvolutionClient): WhatsAppDriver {
  return new EvolutionWhatsAppDriver(client);
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

/**
 * `conversations.patient_name` e `patients.name` sao VARCHAR(255) (SCHEMA.md).
 * O nome vem do PERFIL do canal, escolhido por terceiro, e nao tem limite la:
 * um apelido de 400 caracteres estourava a coluna, o handler subia com erro
 * 22001 e a mensagem do paciente era descartada em silencio (o canal responde
 * 200 e nao reentrega). Truncar o enfeite e melhor que perder a mensagem.
 */
const PROFILE_NAME_MAX = 255;

function profileName(value: string | null): string | null {
  if (value === null) return null;
  return value.length > PROFILE_NAME_MAX ? value.slice(0, PROFILE_NAME_MAX) : value;
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
  /** Driver `connectionMode: 'cloud_api'` (default) — mock em dev/teste, HTTP em producao. */
  driver?: WhatsAppDriver;
  /**
   * Driver `connectionMode: 'qr'` (Onda 7). `undefined` quando o gateway
   * Evolution nao esta configurado — `send` lanca nesse caso, so para um
   * tenant que efetivamente escolheu `qr` (D-024: nunca afeta quem esta em
   * `cloud_api`).
   */
  evolutionDriver?: WhatsAppDriver;
  queue?: QueueService;
  /** Tentativas totais do envio. SERVICES.md §11 exige 3. */
  attempts?: number;
}

export class WhatsAppService {
  readonly driver: WhatsAppDriver;
  private readonly evolutionDriver: WhatsAppDriver | undefined;
  private readonly queue: QueueService;
  private readonly credentials: WhatsAppCredentialsResolver;
  private readonly attempts: number;

  constructor(deps: WhatsAppServiceDeps) {
    this.credentials = deps.credentials;
    this.driver = deps.driver ?? createDefaultDriver();
    this.evolutionDriver = deps.evolutionDriver;
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

    // D-074: canal desligado NAO envia. Antes da fila, porque isso nao e falha
    // transitoria — repetir tres vezes so atrasaria o `failed` do atendente.
    if (!credentials.isActive) {
      throw new Error('canal whatsapp desativado para este laboratorio (isActive: false)');
    }
    // D-073 emendada: token revogado nao volta a sair pelo numero global.
    if (credentials.apiTokenRevoked) {
      throw new Error('token do canal whatsapp foi revogado por este laboratorio');
    }

    // Seleciona o driver PELO TENANT (D-024/D-032) — nunca um driver global: um
    // laboratorio em `qr` nao pode acidentalmente sair pela API oficial de outro.
    const driver = this.driverFor(credentials);

    return this.queue.run(
      'whatsapp.send',
      () => driver.send(credentials, phone, content),
      { attempts: this.attempts },
    );
  }

  private driverFor(credentials: WhatsAppCredentials): WhatsAppDriver {
    if (credentials.connectionMode !== 'qr') return this.driver;
    if (!this.evolutionDriver) {
      throw new Error(
        'canal whatsapp em connectionMode "qr" mas o gateway Evolution nao esta configurado',
      );
    }
    return this.evolutionDriver;
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
          patientName: profileName(names.get(from) ?? null),
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
          patientName: profileName(flat ? asString(flat.name) : null),
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

/** `EVOLUTION_API_URL`/`EVOLUTION_API_KEY` ausentes => `undefined` (send em `qr` lanca). */
function defaultEvolutionDriver(): WhatsAppDriver | undefined {
  const client = createDefaultEvolutionClient();
  return client ? createEvolutionWhatsAppDriver(client) : undefined;
}

/** Monta o adapter com os drivers e a fila default (mock em dev/teste). */
export function createWhatsAppService(
  db: DbClient,
  overrides: Partial<WhatsAppServiceDeps> = {},
): WhatsAppService {
  return new WhatsAppService({
    credentials: overrides.credentials ?? createTenantCredentialsResolver(db),
    ...(overrides.driver !== undefined ? { driver: overrides.driver } : {}),
    evolutionDriver: overrides.evolutionDriver ?? defaultEvolutionDriver(),
    ...(overrides.queue !== undefined ? { queue: overrides.queue } : {}),
    ...(overrides.attempts !== undefined ? { attempts: overrides.attempts } : {}),
  });
}
