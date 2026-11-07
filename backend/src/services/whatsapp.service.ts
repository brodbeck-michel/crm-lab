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
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  MAX_MEDIA_BYTES,
  cloudApiMediaRule,
  normalizeMediaMimeType,
  WHATSAPP_PRICING_CATEGORIES,
  type ConversationChannel,
  type MessageStatus,
  type MessageType,
  type WhatsAppPricingCategory,
  type WhatsAppTemplate,
} from '@crm-lab/shared';
import { env } from '../config/env.js';
import { convertAudioToOgg, type AudioConverter } from '../lib/audio-to-ogg.js';
import { cloudApiMockAllowed } from '../lib/cloud-api-mock.js';
import { BusinessError } from '../http/errors.js';
import type { DbClient } from '../db/types.js';
import {
  createDefaultEvolutionClient,
  evolutionInstanceName,
  type EvolutionClient,
} from '../lib/evolution-client.js';
import { GatewayTimeoutError, withGatewayTimeout } from '../lib/fetch-timeout.js';
import { logger } from '../lib/logger.js';
import { createQueue, type QueueService } from '../lib/queue.js';
import type { ChannelCredentials } from '../repositories/channel-settings.repository.js';
import { createAuditService } from './audit.service.js';
import { createChannelSettingsService } from './channel-settings.service.js';
import { parseMetaTemplates } from './whatsapp-templates.js';

// ---------------------------------------------------------------------------
// Credenciais
// ---------------------------------------------------------------------------

export interface WhatsAppCredentials {
  tenantId: string;
  /** Numero/id do numero do laboratorio na API do canal. */
  phoneNumberId: string;
  /** Vazia => driver mock. */
  apiUrl: string;
  /** WABA da Meta (só `cloud_api`); vazia = não configurado. Não é segredo (CRMLAB-135). */
  wabaId: string;
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
  /**
   * Apikey da instancia Evolution — SOMENTE da LINHA de `tenant_channels`,
   * NUNCA de env var (N1 da revisao da Task 5, rodada 2). Campo separado de
   * `apiToken` de proposito: `apiToken` cai para `WHATSAPP_API_TOKEN` (o
   * token da API OFICIAL da Meta, outro provedor) quando a linha nao tem
   * valor — o `EvolutionWhatsAppDriver` nao pode ler esse campo, ou um tenant
   * cujo `connectWhatsAppQr` falhou entre gravar `connection_mode='qr'` e
   * gravar a apikey (janela fechada pela propria Task 5, mas defesa em
   * profundidade) mandaria o segredo do provedor A (Meta) num header
   * endereçado ao host do provedor B (Evolution self-hosted). `null` = a
   * linha nao tem apikey gravada — o driver Evolution tem que RECUSAR enviar,
   * nunca cair em outro valor.
   */
  qrInstanceApiKey: string | null;
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
    // Sem fallback de env para as credenciais da Meta (D-308 item 5): cada
    // laboratorio envia so com as proprias. O mock (URL vazia) nao as exige.
    phoneNumberId: '',
    // `trim()` como em `createDefaultDriver`: URL so de espacos = mock.
    apiUrl: (env.WHATSAPP_API_URL ?? '').trim(),
    wabaId: '',
    apiToken: '',
    webhookSecret: env.WHATSAPP_WEBHOOK_SECRET ?? '',
    isActive: true,
    apiTokenRevoked: false,
    // Sem linha em `tenant_channels`, o laboratorio so pode estar no caminho de
    // sempre (API oficial via env var). `qr` so existe depois de um
    // `connectWhatsAppQr` bem-sucedido, que grava a linha.
    connectionMode: 'cloud_api',
    // Nao existe env var para isto — a apikey da instancia SO vem da tabela.
    qrInstanceApiKey: null,
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
 * Envio sem configuração válida é erro de NEGÓCIO claro, nunca um envio mudo
 * pelo driver mock nem um erro genérico do provedor (CRMLAB-135, D-308).
 * `cloud_api`: exige `phone_number_id`, `waba_id` e token do laboratório; o
 * erro lista só os NOMES dos campos faltantes, nunca valores. `qr`: exige a
 * apikey da instância (só a tabela a guarda). Sem `WHATSAPP_API_URL` o driver
 * mock vale fora de produção; em produção só com `WHATSAPP_CLOUD_API_MOCK=true`
 * (hml). Senão, `CHANNEL_CLOUD_API_UNAVAILABLE` (D-308 item 5).
 */
export function assertChannelConfigured(credentials: WhatsAppCredentials): void {
  if (credentials.connectionMode === 'qr') {
    if (credentials.qrInstanceApiKey === null || credentials.qrInstanceApiKey === '') {
      throw new BusinessError('CHANNEL_QR_UNAVAILABLE', { reason: 'qr_not_paired' });
    }
    return;
  }
  if (credentials.apiUrl === '') {
    if (cloudApiMockAllowed(credentials.apiUrl)) return;
    // Instalacao de producao sem a URL da Meta: problema da instalacao, nao
    // do laboratorio (D-308 item 4).
    throw new BusinessError('CHANNEL_CLOUD_API_UNAVAILABLE');
  }
  const missing = cloudApiMissing(credentials);
  if (missing.length > 0) {
    throw new BusinessError('CHANNEL_CLOUD_API_NOT_CONFIGURED', { missing });
  }
}

/** Nomes (nunca valores) das credenciais da Cloud API que faltam. */
function cloudApiMissing(credentials: WhatsAppCredentials): string[] {
  const missing: string[] = [];
  if (credentials.phoneNumberId === '') missing.push('phoneNumberId');
  if (credentials.wabaId === '') missing.push('wabaId');
  if (credentials.apiToken === '') missing.push('apiToken');
  return missing;
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
    // D-308 item 5: as tres credenciais da Meta so vem da linha do
    // laboratorio, nunca da instalacao. O token e o de `cloud_api_token`, nunca
    // a apikey do QR em `api_token` (item 3).
    phoneNumberId: stored?.phoneNumberId ?? '',
    apiUrl: fallback.apiUrl,
    wabaId: stored?.wabaId ?? '',
    apiToken: stored?.cloudApiToken ?? '',
    // Segredo vazio continua recusando TUDO (`verifyWebhookSignature`): nada
    // aqui transforma "nao configurado" em "autentico".
    webhookSecret: stored?.webhookSecret ?? fallback.webhookSecret,
    // Sem linha na tabela o canal esta ligado (ambiente so-env-var).
    isActive: stored?.isActive ?? fallback.isActive,
    // Revogar o token da Meta so trava o envio em `cloud_api`: em `qr` o token
    // da Meta nao e usado.
    apiTokenRevoked:
      stored?.connectionMode !== 'qr' && stored?.cloudApiToken === ''
        ? true
        : fallback.apiTokenRevoked,
    // `connectionMode` so existe na tabela (nunca em env var): sem linha, so
    // resta `cloud_api`.
    connectionMode: stored?.connectionMode ?? fallback.connectionMode,
    // N1 da revisao (rodada 2): SEM `?? fallback`, de proposito. `fallback`
    // pode carregar `WHATSAPP_API_TOKEN` (Meta, outro provedor) — deixar isto
    // cair nele faria o driver Evolution herdar um segredo que nao e dele.
    // `null` sem linha, ou sem apikey gravada na linha, e o unico
    // comportamento correto aqui.
    qrInstanceApiKey: stored?.apiToken ?? null,
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
  /**
   * Por onde saiu (CRMLAB-141, D-312): `cloud_api` grava a categoria de
   * cobranca na confirmacao. Preenchido pelo `WhatsAppService`, nao pelo driver.
   */
  via?: 'qr' | 'cloud_api';
}

export interface OutboundMedia {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  /** Legenda (CRMLAB-69, D-231); o driver Evolution descarta em áudio. */
  caption?: string | null;
}

/** Midia baixada da Meta (CRMLAB-140). */
export interface DownloadedMedia {
  buffer: Buffer;
  mimeType: string;
}

/** Motivo de download que nao deu certo — vai para o log, sem PII (D-314 item 5). */
export type MediaDownloadFailure = 'too_large' | 'http_error' | 'host_not_allowed' | 'bad_response' | 'timeout';

export class MediaDownloadError extends Error {
  constructor(readonly reason: MediaDownloadFailure) {
    super(`download de midia da Meta falhou: ${reason}`);
    this.name = 'MediaDownloadError';
  }
}

/**
 * Para onde o token da Meta pode ir no download (D-314 item 4): `https` da
 * propria Meta ou a origem configurada de `WHATSAPP_API_URL`.
 */
export function isMetaMediaHost(url: string, apiUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (apiUrl !== '' && sameOrigin(url, new URL(apiUrl).origin)) return true;
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return (
    host === 'graph.facebook.com' ||
    ['.fbsbx.com', '.whatsapp.net', '.fbcdn.net'].some((suffix) => host.endsWith(suffix))
  );
}

/**
 * Mensagem citada no envio (CRMLAB-66, D-221): id externo da original, de que
 * lado ela esta e o texto (o Evolution usa para montar a citacao).
 */
export interface QuotedRef {
  externalId: string;
  fromMe: boolean;
  content: string;
}

export interface SendOptions {
  quoted?: QuotedRef;
}

/** Alvo de uma reacao (D-222). */
export interface ReactionTarget {
  externalId: string;
  fromMe: boolean;
}

export interface WhatsAppDriver {
  readonly name: string;
  send(
    credentials: WhatsAppCredentials,
    phone: string,
    content: string,
    options?: SendOptions,
  ): Promise<SendResult>;
  sendMedia(
    credentials: WhatsAppCredentials,
    phone: string,
    media: OutboundMedia,
    options?: SendOptions,
  ): Promise<SendResult>;
  /**
   * Baixa a midia RECEBIDA pela Cloud API (CRMLAB-140, D-314 item 4). OPCIONAL:
   * driver sem o metodo (mock) faz o webhook usar o aviso de texto. Lanca
   * `MediaDownloadError` com o motivo.
   */
  downloadMedia?(credentials: WhatsAppCredentials, mediaId: string): Promise<DownloadedMedia>;
  /**
   * Reacao com emoji (D-222); `''` remove. OPCIONAL: driver sem suporte faz o
   * `WhatsAppService.sendReaction` lancar, e a API responde `MESSAGE_SEND_FAILED`.
   */
  sendReaction?(
    credentials: WhatsAppCredentials,
    phone: string,
    target: ReactionTarget,
    emoji: string,
  ): Promise<void>;
  /**
   * Presenca da atendente para o paciente (D-226/D-227). OPCIONAL: so o
   * Evolution tem; driver sem suporte faz `WhatsAppService.sendPresence` virar
   * no-op (a Cloud API nao tem presenca).
   */
  sendPresence?(
    credentials: WhatsAppCredentials,
    phone: string,
    presence: OutboundPresence,
    delayMs: number,
  ): Promise<void>;
  /**
   * A autora corrige texto/legenda de mensagem NOSSA (CRMLAB-105, D-280).
   * OPCIONAL, como `sendReaction`: driver sem os dois metodos (Cloud API) nao
   * oferece editar/apagar — `WhatsAppService.canEditMessages` diz isso a tela.
   */
  editMessage?(
    credentials: WhatsAppCredentials,
    phone: string,
    externalId: string,
    content: string,
  ): Promise<void>;
  /** "Apagar para todos" de mensagem NOSSA (D-280). OPCIONAL, idem. */
  deleteMessage?(credentials: WhatsAppCredentials, phone: string, externalId: string): Promise<void>;
  /**
   * Modelos da conta (CRMLAB-136, D-309): linhas CRUAS de
   * `GET /{waba_id}/message_templates`, todas as paginas. Quem filtra e
   * `parseMetaTemplates`. OPCIONAL: so a Cloud API tem modelo.
   */
  listTemplates?(credentials: WhatsAppCredentials): Promise<unknown[]>;
  /** Envio por modelo aprovado (D-309). OPCIONAL, idem. */
  sendTemplate?(
    credentials: WhatsAppCredentials,
    phone: string,
    template: TemplateSend,
  ): Promise<SendResult>;
}

/** O que o driver precisa para mandar um modelo: nome, idioma e as variaveis do corpo em ordem. */
export interface TemplateSend {
  name: string;
  language: string;
  variables: readonly string[];
}

/** O que a atendente manda ao paciente: `paused` so assina, `composing` = digitando (D-226). */
export type OutboundPresence = 'paused' | 'composing';

/**
 * Quanto o gateway segura cada presenca (D-227). `composing` dura o intervalo
 * do debounce da tela (4 s); `paused` so precisa do `presenceSubscribe` que a
 * rota faz antes.
 */
export const PRESENCE_DELAY_MS: Record<OutboundPresence, number> = {
  paused: 200,
  composing: 4_000,
};

export interface MockSentPresence {
  tenantId: string;
  phone: string;
  presence: OutboundPresence;
}

export interface MockSentMessage {
  tenantId: string;
  phone: string;
  content: string;
  externalId: string;
  at: string;
  /** Id externo da mensagem citada (D-221), quando houve. */
  quotedExternalId?: string;
  /** Legenda da mídia (CRMLAB-69, D-231), quando houve. */
  caption?: string;
  /** Envio por modelo (CRMLAB-136): `content` fica vazio e o modelo vem aqui. */
  template?: TemplateSend;
}

/** Edicao/apagamento feito pela autora (D-280) — o que o mock "mandou". */
export interface MockMessageAction {
  tenantId: string;
  phone: string;
  kind: 'edit' | 'delete';
  externalId: string;
  content?: string;
}

export interface MockSentReaction {
  tenantId: string;
  phone: string;
  targetExternalId: string;
  emoji: string;
}

/**
 * Driver de dev/teste: nao sai da maquina. "Ecoa" no sentido de DEVELOPMENT.md
 * — a mensagem enviada fica registrada em `sent` (e no log) e o envio devolve
 * um `externalId` sintetico, exatamente como faria a API real.
 */
/**
 * Modelos que o mock "tem na Meta" (CRMLAB-136): dev, testes e a hml com
 * `WHATSAPP_CLOUD_API_MOCK=true` enxergam estes. Formato CRU da Graph API.
 */
export const MOCK_META_TEMPLATES: readonly unknown[] = [
  {
    name: 'retomar_atendimento',
    language: 'pt_BR',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Olá {{1}}, aqui é do laboratório. Podemos continuar o seu atendimento por aqui?',
        example: { body_text: [['Maria']] },
      },
    ],
  },
  {
    name: 'lembrete_coleta',
    language: 'pt_BR',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Olá {{1}}, sua coleta está agendada para {{2}}. Qualquer dúvida, responda esta mensagem.',
        example: { body_text: [['Maria', '12/11 às 8h']] },
      },
    ],
  },
];

export class MockWhatsAppDriver implements WhatsAppDriver {
  readonly name = 'mock';
  readonly sent: MockSentMessage[] = [];
  /** Linhas cruas devolvidas por `listTemplates`; o teste troca para simular a conta. */
  templates: unknown[] = [...MOCK_META_TEMPLATES];
  /** Chamadas a `listTemplates` (o teste confere o cache). */
  templateListCalls = 0;
  /** `true` = `listTemplates` falha como a Meta fora do ar. */
  failTemplateList = false;
  readonly reactions: MockSentReaction[] = [];
  readonly presences: MockSentPresence[] = [];
  readonly messageActions: MockMessageAction[] = [];

  async send(
    credentials: WhatsAppCredentials,
    phone: string,
    content: string,
    options: SendOptions = {},
  ): Promise<SendResult> {
    const externalId = `wamid.mock.${randomUUID()}`;
    this.sent.push({
      tenantId: credentials.tenantId,
      phone,
      content,
      externalId,
      at: new Date().toISOString(),
      ...(options.quoted ? { quotedExternalId: options.quoted.externalId } : {}),
    });
    // Conteudo de mensagem de paciente NUNCA vai para o log (SECURITY.md).
    logger.debug('whatsapp.mock_send', { tenantId: credentials.tenantId, externalId });
    return { externalId };
  }

  async listTemplates(): Promise<unknown[]> {
    this.templateListCalls += 1;
    if (this.failTemplateList) throw new Error('mock: Meta fora do ar');
    return [...this.templates];
  }

  async sendTemplate(
    credentials: WhatsAppCredentials,
    phone: string,
    template: TemplateSend,
  ): Promise<SendResult> {
    const externalId = `wamid.mock.${randomUUID()}`;
    this.sent.push({
      tenantId: credentials.tenantId,
      phone,
      content: '',
      externalId,
      at: new Date().toISOString(),
      template: { name: template.name, language: template.language, variables: [...template.variables] },
    });
    logger.debug('whatsapp.mock_send_template', { tenantId: credentials.tenantId, externalId });
    return { externalId };
  }

  async sendMedia(
    credentials: WhatsAppCredentials,
    phone: string,
    media: OutboundMedia,
    options: SendOptions = {},
  ): Promise<SendResult> {
    const externalId = `wamid.mock.${randomUUID()}`;
    this.sent.push({
      tenantId: credentials.tenantId,
      phone,
      content: `[mídia] ${media.fileName}`,
      externalId,
      at: new Date().toISOString(),
      ...(options.quoted ? { quotedExternalId: options.quoted.externalId } : {}),
      ...(media.caption ? { caption: media.caption } : {}),
    });
    logger.debug('whatsapp.mock_send_media', { tenantId: credentials.tenantId, externalId });
    return { externalId };
  }

  async sendReaction(
    credentials: WhatsAppCredentials,
    phone: string,
    target: ReactionTarget,
    emoji: string,
  ): Promise<void> {
    this.reactions.push({
      tenantId: credentials.tenantId,
      phone,
      targetExternalId: target.externalId,
      emoji,
    });
  }

  async sendPresence(
    credentials: WhatsAppCredentials,
    phone: string,
    presence: OutboundPresence,
  ): Promise<void> {
    this.presences.push({ tenantId: credentials.tenantId, phone, presence });
  }

  /** Sucesso fingido (D-280): dev/E2E sem gateway enxergam editar/apagar. */
  async editMessage(
    credentials: WhatsAppCredentials,
    phone: string,
    externalId: string,
    content: string,
  ): Promise<void> {
    this.messageActions.push({ tenantId: credentials.tenantId, phone, kind: 'edit', externalId, content });
  }

  async deleteMessage(
    credentials: WhatsAppCredentials,
    phone: string,
    externalId: string,
  ): Promise<void> {
    this.messageActions.push({ tenantId: credentials.tenantId, phone, kind: 'delete', externalId });
  }

  clear(): void {
    this.sent.length = 0;
    this.reactions.length = 0;
    this.presences.length = 0;
    this.messageActions.length = 0;
  }
}

/**
 * Timeout de UMA chamada a API oficial da Meta (CRMLAB-30, D-137).
 *
 * Mesmo orcamento do `EVOLUTION_TIMEOUT_MS`, pela mesma conta (3 tentativas da
 * fila + backoff tem de caber nos 60 s do `proxy_read_timeout` do nginx), e
 * aqui com folga de sobra: a Meta responde em centenas de milissegundos ou
 * esta indisponivel. Note que a Meta e um host EXTERNO — sem timeout, uma
 * instabilidade de rede prendia o handler ate o socket TCP morrer.
 */
export const META_TIMEOUT_MS = 10_000;
/** Upload de anexo (ate 16 MB) leva mais que uma chamada de texto. */
export const META_MEDIA_TIMEOUT_MS = 12_000;

/** Teto de paginas de `message_templates` (100 por pagina): conta normal tem dezenas. */
export const MAX_TEMPLATE_PAGES = 10;

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** Driver real. Falha => a fila tenta de novo (retry exponencial). */
export class HttpWhatsAppDriver implements WhatsAppDriver {
  readonly name = 'http';
  private readonly convertAudio: AudioConverter;

  /** `convertAudio` injetavel: o teste nao depende do ffmpeg da maquina. */
  constructor(options: { convertAudio?: AudioConverter } = {}) {
    this.convertAudio = options.convertAudio ?? convertAudioToOgg;
  }

  async send(
    credentials: WhatsAppCredentials,
    phone: string,
    content: string,
    options: SendOptions = {},
  ): Promise<SendResult> {
    const payload = await this.post(credentials, {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'text',
      text: { body: content },
      // Responder citando na Cloud API (D-221).
      ...(options.quoted ? { context: { message_id: options.quoted.externalId } } : {}),
    });
    const externalId = firstMessageId(payload);
    if (!externalId) throw new Error('WhatsApp API nao devolveu id da mensagem');
    return { externalId };
  }

  /** Reacao na Cloud API (`type: reaction`, D-222); `emoji: ''` remove. */
  async sendReaction(
    credentials: WhatsAppCredentials,
    phone: string,
    target: ReactionTarget,
    emoji: string,
  ): Promise<void> {
    await this.post(credentials, {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'reaction',
      reaction: { message_id: target.externalId, emoji },
    });
  }

  /**
   * Envio por modelo aprovado (CRMLAB-136, D-309): `type: template`, idioma
   * pelo codigo e as variaveis como `parameters` de texto do corpo, em ordem.
   */
  async sendTemplate(
    credentials: WhatsAppCredentials,
    phone: string,
    template: TemplateSend,
  ): Promise<SendResult> {
    const payload = await this.post(credentials, {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language },
        ...(template.variables.length > 0
          ? {
              components: [
                {
                  type: 'body',
                  parameters: template.variables.map((text) => ({ type: 'text', text })),
                },
              ],
            }
          : {}),
      },
    });
    const externalId = firstMessageId(payload);
    if (!externalId) throw new Error('WhatsApp API nao devolveu id da mensagem');
    return { externalId };
  }

  /**
   * `GET /{waba_id}/message_templates`, seguindo `paging.next` (D-309). So
   * segue link da MESMA origem de `apiUrl`: o token vai no header, e um
   * `next` apontando para outro host nao pode levar o token junto.
   */
  async listTemplates(credentials: WhatsAppCredentials): Promise<unknown[]> {
    const origin = new URL(credentials.apiUrl).origin;
    const fields = 'name,language,status,category,components,parameter_format';
    let url: string | null =
      `${credentials.apiUrl}/${encodeURIComponent(credentials.wabaId)}/message_templates` +
      `?fields=${fields}&limit=100`;
    const rows: unknown[] = [];
    for (let page = 0; url !== null && page < MAX_TEMPLATE_PAGES; page += 1) {
      const target: string = url;
      const { ok, status, payload } = await withGatewayTimeout(
        { gateway: 'meta', path: '/message_templates', timeoutMs: META_TIMEOUT_MS },
        async (signal) => {
          const response = await fetch(target, {
            method: 'GET',
            signal,
            headers: { Authorization: `Bearer ${credentials.apiToken}` },
          });
          const body: unknown = response.ok ? await response.json() : null;
          return { ok: response.ok, status: response.status, payload: body };
        },
      );
      if (!ok) throw new Error(`WhatsApp API respondeu ${status} ao listar modelos`);
      const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
      if (Array.isArray(record.data)) rows.push(...(record.data as unknown[]));
      const paging = typeof record.paging === 'object' && record.paging !== null
        ? (record.paging as Record<string, unknown>)
        : {};
      const next = typeof paging.next === 'string' ? paging.next : null;
      if (next !== null && !sameOrigin(next, origin)) {
        logger.warn('whatsapp.templates_paging_other_host', { tenantId: credentials.tenantId });
      }
      url = next !== null && sameOrigin(next, origin) ? next : null;
      if (url !== null && page === MAX_TEMPLATE_PAGES - 1) {
        logger.warn('whatsapp.templates_paging_truncated', { tenantId: credentials.tenantId });
      }
    }
    return rows;
  }

  private async post(
    credentials: WhatsAppCredentials,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    // `fetch` + leitura do corpo dentro do MESMO signal: o `fetch` resolve nos
    // headers, entao um corpo que nunca termina travaria igual (D-137).
    const { ok, status, payload } = await withGatewayTimeout(
      { gateway: 'meta', path: '/messages', timeoutMs: META_TIMEOUT_MS },
      async (signal) => {
        const response = await fetch(
          `${credentials.apiUrl}/${credentials.phoneNumberId}/messages`,
          {
            method: 'POST',
            signal,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${credentials.apiToken}`,
            },
            body: JSON.stringify(body),
          },
        );
        // O corpo so e lido quando ha o que ler: um erro da Meta com corpo
        // vazio quebraria `.json()` e mascararia o status de verdade.
        const payload: unknown = response.ok ? await response.json() : null;
        return { ok: response.ok, status: response.status, payload };
      },
    );

    if (!ok) {
      throw new Error(`WhatsApp API respondeu ${status}`);
    }
    return payload;
  }

  /**
   * Anexo pela Cloud API (CRMLAB-140, D-314): sobe em `/{phone_number_id}/media`
   * e manda por id. `audio/webm` (recado de voz do navegador) vira OGG/Opus
   * antes. A rota ja recusou o que a Meta nao aceita; a conferencia aqui e a
   * rede de seguranca do "tentar de novo" (formato gravado no QR, por exemplo).
   */
  async sendMedia(
    credentials: WhatsAppCredentials,
    phone: string,
    media: OutboundMedia,
    options: SendOptions = {},
  ): Promise<SendResult> {
    const rule = cloudApiMediaRule(media.mimeType);
    if (!rule) throw new Error('formato de anexo nao aceito pela API oficial da Meta');
    let { buffer, mimeType, fileName } = media;
    if (normalizeMediaMimeType(mimeType) === 'audio/webm') {
      buffer = await this.convertAudio(buffer);
      mimeType = 'audio/ogg';
      fileName = `${fileName.replace(/\.[^./]+$/, '')}.ogg`;
    }
    if (buffer.byteLength > rule.maxBytes) throw new Error('anexo acima do limite da API oficial da Meta');

    const mediaId = await this.upload(credentials, buffer, mimeType, fileName);
    const caption = rule.kind !== 'audio' && media.caption ? media.caption : null;
    const payload = await this.post(credentials, {
      messaging_product: 'whatsapp',
      to: phone,
      type: rule.kind,
      [rule.kind]: {
        id: mediaId,
        ...(caption ? { caption } : {}),
        ...(rule.kind === 'document' ? { filename: fileName } : {}),
      },
      ...(options.quoted ? { context: { message_id: options.quoted.externalId } } : {}),
    });
    const externalId = firstMessageId(payload);
    if (!externalId) throw new Error('WhatsApp API nao devolveu id da mensagem');
    return { externalId };
  }

  /** `POST /{phone_number_id}/media` (multipart) -> id da midia na Meta. */
  private async upload(
    credentials: WhatsAppCredentials,
    buffer: Buffer,
    mimeType: string,
    fileName: string,
  ): Promise<string> {
    const { ok, status, payload } = await withGatewayTimeout(
      { gateway: 'meta', path: '/media', timeoutMs: META_MEDIA_TIMEOUT_MS },
      async (signal) => {
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('type', mimeType);
        form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), fileName);
        const response = await fetch(`${credentials.apiUrl}/${credentials.phoneNumberId}/media`, {
          method: 'POST',
          signal,
          headers: { Authorization: `Bearer ${credentials.apiToken}` },
          body: form,
        });
        const body: unknown = response.ok ? await response.json() : await metaErrorCode(response);
        return { ok: response.ok, status: response.status, payload: body };
      },
    );
    if (!ok) {
      logger.warn('whatsapp.media_upload_refused', {
        tenantId: credentials.tenantId,
        status,
        metaError: typeof payload === 'string' ? payload : null,
      });
      throw new Error(`WhatsApp API respondeu ${status} ao subir a midia`);
    }
    const id = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>).id : null;
    if (typeof id !== 'string' || id === '') throw new Error('WhatsApp API nao devolveu id da midia');
    return id;
  }

  /**
   * Midia recebida (D-314 item 4): `GET /{media_id}` da a URL temporaria e o
   * tamanho; `GET url` com o mesmo Bearer traz o arquivo. O token so vai para
   * host da Meta (`isMetaMediaHost`). Acima de `MAX_MEDIA_BYTES` nem baixa.
   */
  async downloadMedia(credentials: WhatsAppCredentials, mediaId: string): Promise<DownloadedMedia> {
    const auth = { Authorization: `Bearer ${credentials.apiToken}` };
    const meta = await this.timed('/media-info', async (signal) => {
      const response = await fetch(`${credentials.apiUrl}/${encodeURIComponent(mediaId)}`, {
        method: 'GET',
        signal,
        headers: auth,
      });
      if (!response.ok) throw new MediaDownloadError('http_error');
      return (await response.json()) as unknown;
    });
    const record = typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>) : {};
    const url = typeof record.url === 'string' ? record.url : null;
    const mimeType = typeof record.mime_type === 'string' ? record.mime_type : null;
    const declaredSize = typeof record.file_size === 'number' ? record.file_size : null;
    if (!url || !mimeType) throw new MediaDownloadError('bad_response');
    if (declaredSize !== null && declaredSize > MAX_MEDIA_BYTES) throw new MediaDownloadError('too_large');
    if (!isMetaMediaHost(url, credentials.apiUrl)) throw new MediaDownloadError('host_not_allowed');

    const buffer = await this.timed('/media-file', async (signal) => {
      // `redirect: 'manual'`: um redirecionamento para fora da Meta nao leva o token.
      const response = await fetch(url, { method: 'GET', signal, headers: auth, redirect: 'manual' });
      if (!response.ok) throw new MediaDownloadError('http_error');
      const length = Number(response.headers.get('content-length') ?? '0');
      if (length > MAX_MEDIA_BYTES) throw new MediaDownloadError('too_large');
      return readCapped(response, MAX_MEDIA_BYTES);
    });
    if (buffer.byteLength === 0) throw new MediaDownloadError('bad_response');
    if (buffer.byteLength > MAX_MEDIA_BYTES) throw new MediaDownloadError('too_large');
    return { buffer, mimeType };
  }

  /** Chamada a Meta com timeout; estouro vira `MediaDownloadError('timeout')`. */
  private async timed<T>(path: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    try {
      return await withGatewayTimeout({ gateway: 'meta', path, timeoutMs: META_TIMEOUT_MS }, fn);
    } catch (err) {
      if (err instanceof MediaDownloadError) throw err;
      if (err instanceof GatewayTimeoutError) throw new MediaDownloadError('timeout');
      throw new MediaDownloadError('http_error');
    }
  }
}

/**
 * Credencial ausente/errada para o driver Evolution — tipado de proposito
 * (N1 da revisao da Task 5, rodada 2) para nunca ser confundido com uma falha
 * de rede do `EvolutionClient` (que lanca `Error` simples): esta e uma
 * recusa DELIBERADA do proprio driver, antes de qualquer chamada HTTP.
 */
export class EvolutionCredentialError extends Error {
  constructor(tenantId: string) {
    super(
      `canal whatsapp (tenant ${tenantId}) em connectionMode "qr" sem apikey de instancia gravada na tabela — reconecte por QR`,
    );
    this.name = 'EvolutionCredentialError';
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
    options: SendOptions = {},
  ): Promise<SendResult> {
    const instanceName = evolutionInstanceName(credentials.tenantId);
    // Fix do Important 6 (rodada 1) + N1 (rodada 2) da revisao da Task 5: a
    // apikey DA INSTANCIA vem de `credentials.qrInstanceApiKey` — um campo
    // que `mergeCredentials` preenche SOMENTE a partir da LINHA de
    // `tenant_channels`, sem cair em `WHATSAPP_API_TOKEN` (o token da API
    // OFICIAL da Meta, outro provedor). `credentials.apiToken` NAO e lido
    // aqui de proposito: ele tem fallback para a env var da Meta, e um
    // segredo de um provedor nunca pode chegar ao host do outro, nem numa
    // janela estreita (tenant com `connection_mode='qr'` mas sem apikey
    // gravada — `connectWhatsAppQr` fecha essa janela na origem, mas o driver
    // e o portao de ultima instancia e recusa de qualquer forma).
    if (!credentials.qrInstanceApiKey) {
      throw new EvolutionCredentialError(credentials.tenantId);
    }
    const { externalId } = await this.client.sendText(
      instanceName,
      phone,
      content,
      credentials.qrInstanceApiKey,
      options.quoted,
    );
    return { externalId };
  }

  async sendReaction(
    credentials: WhatsAppCredentials,
    phone: string,
    target: ReactionTarget,
    emoji: string,
  ): Promise<void> {
    if (!credentials.qrInstanceApiKey) {
      throw new EvolutionCredentialError(credentials.tenantId);
    }
    await this.client.sendReaction(
      evolutionInstanceName(credentials.tenantId),
      phone,
      target,
      emoji,
      credentials.qrInstanceApiKey,
    );
  }

  async sendPresence(
    credentials: WhatsAppCredentials,
    phone: string,
    presence: OutboundPresence,
    delayMs: number,
  ): Promise<void> {
    if (!credentials.qrInstanceApiKey) {
      throw new EvolutionCredentialError(credentials.tenantId);
    }
    await this.client.sendPresence(
      evolutionInstanceName(credentials.tenantId),
      phone,
      presence,
      delayMs,
      credentials.qrInstanceApiKey,
    );
  }

  async editMessage(
    credentials: WhatsAppCredentials,
    phone: string,
    externalId: string,
    content: string,
  ): Promise<void> {
    if (!credentials.qrInstanceApiKey) {
      throw new EvolutionCredentialError(credentials.tenantId);
    }
    await this.client.updateMessage(
      evolutionInstanceName(credentials.tenantId),
      phone,
      externalId,
      content,
      credentials.qrInstanceApiKey,
    );
  }

  async deleteMessage(
    credentials: WhatsAppCredentials,
    phone: string,
    externalId: string,
  ): Promise<void> {
    if (!credentials.qrInstanceApiKey) {
      throw new EvolutionCredentialError(credentials.tenantId);
    }
    await this.client.deleteMessageForEveryone(
      evolutionInstanceName(credentials.tenantId),
      phone,
      externalId,
      credentials.qrInstanceApiKey,
    );
  }

  async sendMedia(
    credentials: WhatsAppCredentials,
    phone: string,
    media: OutboundMedia,
    options: SendOptions = {},
  ): Promise<SendResult> {
    const instanceName = evolutionInstanceName(credentials.tenantId);
    if (!credentials.qrInstanceApiKey) {
      throw new EvolutionCredentialError(credentials.tenantId);
    }
    const { externalId } = await this.client.sendMedia(
      instanceName,
      phone,
      {
        base64: media.buffer.toString('base64'),
        mimeType: media.mimeType,
        fileName: media.fileName,
        caption: media.caption ?? null,
      },
      credentials.qrInstanceApiKey,
      options.quoted,
    );
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
  /** Mensagem citada pelo paciente (`context.id` na Meta). */
  quotedExternalId?: string | null;
  /**
   * Midia da Meta a baixar (CRMLAB-140, D-314). `content` ja traz o aviso de
   * texto, usado se o download nao der certo.
   */
  cloudMedia?: InboundCloudMedia | null;
}

export interface InboundCloudMedia {
  id: string;
  mimeType: string | null;
  fileName: string | null;
  caption: string | null;
  /** Figurinha fica no formato original (como no QR). */
  sticker: boolean;
}

export interface StatusCallbackDTO {
  externalId: string;
  status: MessageStatus;
  /** `pricing.category` da Meta, quando e uma das quatro (D-312 item 1). */
  pricingCategory?: WhatsAppPricingCategory | null;
  /** `errors[0].code` da Meta num `failed` (D-311 item 5) — so para log, sem PII. */
  errorCode?: string | null;
}

/**
 * `statuses[].pricing.category` (D-312 item 1): a Meta e quem cobra, entao vence
 * a estimativa do envio. Fora das quatro (ex.: `referral_conversion`,
 * `marketing_lite`): ignorado com log.
 */
function pricingCategoryOf(record: Record<string, unknown>, externalId: string): WhatsAppPricingCategory | null {
  const raw = asString(asRecord(record.pricing)?.category);
  if (raw === null) return null;
  const known = WHATSAPP_PRICING_CATEGORIES.find((category) => category === raw);
  if (known) return known;
  logger.info('whatsapp.pricing_category_ignored', { externalId, category: raw });
  return null;
}

/**
 * Le o corpo parando no teto (CRMLAB-140): sem `content-length`, um arquivo
 * maior que o permitido nao chega a ficar inteiro na memoria.
 */
async function readCapped(response: Response, max: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new MediaDownloadError('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** `error.code`/`error_subcode` da resposta de erro da Meta — sem PII, para o log. */
async function metaErrorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    const error = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).error : null;
    if (typeof error !== 'object' || error === null) return null;
    const { code, error_subcode: subcode } = error as Record<string, unknown>;
    return [code, subcode].filter((v) => typeof v === 'number' || typeof v === 'string').join('/') || null;
  } catch {
    return null;
  }
}

/** Marca por onde o envio saiu (CRMLAB-141). */
async function withVia(credentials: WhatsAppCredentials, sending: Promise<SendResult>): Promise<SendResult> {
  const result = await sending;
  return { ...result, via: credentials.connectionMode === 'qr' ? 'qr' : 'cloud_api' };
}

function errorCodeOf(record: Record<string, unknown>): string | null {
  const first = asRecord(asArray(record.errors)[0]);
  const code = first?.code;
  return typeof code === 'number' || typeof code === 'string' ? String(code) : null;
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
 * Aviso da Meta (`entry[].changes[].value`) so com o que e DESTE laboratorio
 * (CRMLAB-139, D-311 item 6). Falha FECHADO: `value` sem
 * `metadata.phone_number_id`, ou laboratorio sem numero configurado, e
 * descartado — o segredo do HMAC pode ser o App Secret da instalacao inteira,
 * e o numero e o que separa um laboratorio do outro. `meta: false` = o corpo
 * nao esta no formato da Meta (payload plano do mock).
 */
export function metaNoticeFor(
  payload: unknown,
  phoneNumberId: string,
): { meta: boolean; payload: unknown; dropped: number; received: string[] } {
  const root = asRecord(payload);
  if (!root || !Array.isArray(root.entry)) return { meta: false, payload, dropped: 0, received: [] };
  let dropped = 0;
  const received: string[] = [];
  const entry = asArray(root.entry).map((rawEntry) => {
    const entryRecord = asRecord(rawEntry) ?? {};
    const changes = asArray(entryRecord.changes).filter((change) => {
      const got = asString(asRecord(asRecord(asRecord(change)?.value)?.metadata)?.phone_number_id);
      if (got !== null) received.push(got);
      const expected = phoneNumberId.trim();
      const ok = expected !== '' && got !== null && got.trim() === expected;
      if (!ok) dropped += 1;
      return ok;
    });
    return { ...entryRecord, changes };
  });
  return { meta: true, payload: { ...root, entry }, dropped, received };
}

/** Reacao do paciente recebida pela Meta (`type: reaction`). `emoji: ''` = tirou a reacao. */
export interface InboundReactionDTO {
  targetExternalId: string;
  emoji: string;
}

/**
 * Extrai o `value` de cada `entry[].changes[]` do payload da Meta. Payload em
 * outro formato simplesmente nao produz `value` nenhum — nunca lanca.
 */
/** Corpo no formato da Meta (`entry[]`), mesmo que vazio ou filtrado. */
export function isMetaShaped(payload: unknown): boolean {
  return Array.isArray(asRecord(payload)?.entry);
}

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

/** Nome do anexo no aviso de midia recebida pela Cloud API (CRMLAB-139, D-313 emendada). */
const CLOUD_MEDIA_LABEL: Record<string, string> = {
  image: 'imagem',
  audio: 'áudio',
  voice: 'áudio',
  video: 'vídeo',
  document: 'documento',
  sticker: 'figurinha',
};

/** Tipos da Meta que NAO sao fala do paciente: nao viram mensagem (nem reabrem conversa). */
const CLOUD_IGNORED_TYPES = new Set(['reaction', 'system', 'request_welcome', 'ephemeral']);

function mediaNotice(label: string): string {
  return (
    `[Recebido pela API oficial: ${label} — o anexo ainda não aparece no CRM. ` +
    'Se precisar, peça ao paciente que descreva por texto.]'
  );
}

/**
 * Mensagem da Meta -> conteudo (CRMLAB-139). Texto, botao de modelo, resposta
 * de lista/botao interativo, localizacao e contato viram texto legivel. Midia
 * ainda nao e baixada (CRMLAB-140, D-313 emendada): entra como TEXTO com um
 * aviso (e a legenda/nome do arquivo), para a atendente saber que o paciente
 * mandou algo e para a fala abrir a janela de 24 h, como na Meta. `null` =
 * nao e fala do paciente (reacao, aviso de sistema, `request_welcome`).
 */
function cloudApiContentOf(message: Record<string, unknown>): {
  content: string;
  messageType: MessageType;
  attachmentUrl: null;
  cloudMedia?: InboundCloudMedia | null;
} | null {
  const type = asString(message.type) ?? 'text';
  if (CLOUD_IGNORED_TYPES.has(type)) {
    if (type !== 'reaction') logger.info('whatsapp.inbound_ignored', { type, externalId: asString(message.id) });
    return null;
  }
  const text = (content: string) => ({ content, messageType: 'text' as const, attachmentUrl: null });

  if (type === 'text') {
    const body = asString(asRecord(message.text)?.body);
    if (!body) logger.info('whatsapp.inbound_ignored', { type, reason: 'empty_text', externalId: asString(message.id) });
    return body ? text(body) : null;
  }
  if (type === 'button') {
    const label = asString(asRecord(message.button)?.text);
    if (label) return text(label);
  }
  if (type === 'interactive') {
    const interactive = asRecord(message.interactive);
    const reply = asRecord(interactive?.button_reply) ?? asRecord(interactive?.list_reply);
    const title = asString(reply?.title);
    const description = asString(reply?.description);
    if (title) return text(description ? `${title} — ${description}` : title);
  }
  if (type === 'location') {
    const location = asRecord(message.location);
    const name = asString(location?.name) ?? asString(location?.address);
    const lat = location?.latitude;
    const lng = location?.longitude;
    const coords = typeof lat === 'number' && typeof lng === 'number' ? ` (${lat}, ${lng})` : '';
    return text(`📍 ${name ?? 'Localização'}${coords}`);
  }
  if (type === 'contacts') {
    const people = asArray(message.contacts).map((raw) => {
      const contact = asRecord(raw);
      const name = asString(asRecord(contact?.name)?.formatted_name) ?? 'Contato';
      const phone = asString(asRecord(asArray(contact?.phones)[0])?.phone);
      return phone ? `${name} (${phone})` : name;
    });
    return text(`👤 ${people.length > 0 ? people.join(', ') : 'Contato'}`);
  }
  const label = CLOUD_MEDIA_LABEL[type];
  if (label) {
    const media = asRecord(message[type]);
    const caption = asString(media?.caption);
    const filename = asString(media?.filename);
    const notice = mediaNotice(filename ? `${label} "${filename}"` : label);
    const mediaId = asString(media?.id);
    return {
      ...text(caption ? `${caption}\n\n${notice}` : notice),
      cloudMedia: mediaId
        ? {
            id: mediaId,
            mimeType: asString(media?.mime_type),
            fileName: filename,
            caption,
            sticker: type === 'sticker',
          }
        : null,
    };
  }
  // `unsupported`, `order` e tipos novos: o paciente mandou ALGO.
  return text(
    '[Recebido pela API oficial: um tipo de mensagem que o CRM ainda não mostra. ' +
      'Se precisar, peça ao paciente que descreva por texto.]',
  );
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
  /** Relogio do cache de modelos (CRMLAB-136); o teste avanca o tempo. */
  now?: () => number;
  /** Conversao WebM -> OGG do recado de voz na Cloud API (CRMLAB-140); injetavel no teste. */
  convertAudio?: AudioConverter;
}

/**
 * Tentativas do anexo pela Cloud API (CRMLAB-140): o pedido HTTP da atendente
 * fica aberto e o nginx corta em 60 s. Orcamento: ffmpeg (15 s, fora da fila) +
 * 2 x (upload 12 s + envio 10 s) + backoff < 60 s.
 */
export const CLOUD_API_MEDIA_ATTEMPTS = 2;

/** Validade do cache de modelos por laboratorio (D-309 item 1). */
export const TEMPLATE_CACHE_TTL_MS = 5 * 60_000;

/**
 * Cache de modelos POR LABORATORIO, compartilhado por todas as instancias de
 * `WhatsAppService` do processo (cada modulo cria a sua): a lista que a tela
 * mostra e a que o envio confere sao a MESMA. A chave guarda a impressao das
 * credenciais, entao trocar credencial ou modo invalida sozinho.
 */
const templateCache = new Map<string, { key: string; at: number; templates: WhatsAppTemplate[] }>();

/** Impressao das credenciais que decidem a lista de modelos. O token entra so como hash. */
function credentialFingerprint(credentials: WhatsAppCredentials): string {
  return createHash('sha256')
    .update([credentials.connectionMode, credentials.apiUrl, credentials.wabaId, credentials.apiToken].join('\u0000'))
    .digest('hex');
}

export class WhatsAppService {
  readonly driver: WhatsAppDriver;
  private readonly evolutionDriver: WhatsAppDriver | undefined;
  private readonly queue: QueueService;
  private readonly credentials: WhatsAppCredentialsResolver;
  private readonly attempts: number;
  private readonly convertAudio: AudioConverter;
  private readonly now: () => number;

  constructor(deps: WhatsAppServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.credentials = deps.credentials;
    this.driver = deps.driver ?? createDefaultDriver();
    this.evolutionDriver = deps.evolutionDriver;
    this.queue = deps.queue ?? createQueue();
    this.attempts = deps.attempts ?? 3;
    this.convertAudio = deps.convertAudio ?? convertAudioToOgg;
  }

  /**
   * Envia pela fila, com retry exponencial. Esgotadas as tentativas, PROPAGA o
   * erro: quem chama (MessageService) e que marca a mensagem como `failed` e
   * devolve `MESSAGE_SEND_FAILED` (502) — o adapter nao conhece o contrato HTTP.
   */
  async send(
    tenantId: string,
    phone: string,
    content: string,
    options: SendOptions = {},
  ): Promise<SendResult> {
    const credentials = await this.sendableCredentials(tenantId);

    // Seleciona o driver PELO TENANT (D-024/D-032) — nunca um driver global: um
    // laboratorio em `qr` nao pode acidentalmente sair pela API oficial de outro.
    const driver = this.driverFor(credentials);

    return withVia(
      credentials,
      this.queue.run('whatsapp.send', () => driver.send(credentials, phone, content, options), {
        attempts: this.attempts,
      }),
    );
  }

  /**
   * Modelos aprovados do laboratorio (CRMLAB-136, D-309), ja filtrados e em
   * ordem. `qr` => `[]` (nao e erro). Credencial incompleta =>
   * `CHANNEL_CLOUD_API_NOT_CONFIGURED`; Meta fora do ar ou token recusado =>
   * `CHANNEL_CLOUD_API_UNAVAILABLE` (nunca 500).
   *
   * Cache de 5 min POR LABORATORIO, e a chave inclui uma impressao das
   * credenciais (modo, URL, WABA, token): trocar credencial ou modo invalida
   * sozinho, sem ninguem precisar lembrar de limpar (contrato §6.2).
   */
  async listTemplates(tenantId: string): Promise<WhatsAppTemplate[]> {
    const credentials = await this.credentials.forTenant(tenantId);
    if (credentials.connectionMode === 'qr') return [];
    assertChannelConfigured(credentials);
    const driver = this.driverFor(credentials);
    if (!driver.listTemplates) throw new BusinessError('CHANNEL_CLOUD_API_UNAVAILABLE');

    const key = credentialFingerprint(credentials);
    const cached = templateCache.get(tenantId);
    if (cached && cached.key === key && this.now() - cached.at < TEMPLATE_CACHE_TTL_MS) {
      return cached.templates;
    }
    let rows: unknown[];
    try {
      rows = await driver.listTemplates(credentials);
    } catch (err) {
      logger.warn('whatsapp.templates_unavailable', {
        tenantId,
        reason: err instanceof Error ? err.message : String(err),
      });
      // `reason` separa "a Meta nao respondeu" da instalacao sem URL (D-308).
      throw new BusinessError('CHANNEL_CLOUD_API_UNAVAILABLE', { reason: 'meta_unreachable' });
    }
    const templates = parseMetaTemplates(rows);
    templateCache.set(tenantId, { key, at: this.now(), templates });
    return templates;
  }

  /**
   * Baixa a midia recebida pela Cloud API (CRMLAB-140, D-314). `failure` =
   * motivo para o log quando nao deu (o webhook usa o aviso de texto). Mock
   * (sem `WHATSAPP_API_URL`) nao tem de onde baixar.
   */
  async downloadInboundMedia(
    credentials: WhatsAppCredentials,
    mediaId: string,
  ): Promise<{ media: DownloadedMedia } | { failure: MediaDownloadFailure | 'mock' }> {
    const driver = this.driver;
    if (credentials.apiUrl === '' || !driver.downloadMedia) return { failure: 'mock' };
    try {
      return { media: await driver.downloadMedia(credentials, mediaId) };
    } catch (err) {
      return { failure: err instanceof MediaDownloadError ? err.reason : 'http_error' };
    }
  }

  /** Modo do canal WhatsApp do laboratorio (`qr` ou `cloud_api`). */
  async connectionMode(tenantId: string): Promise<'qr' | 'cloud_api'> {
    return (await this.credentials.forTenant(tenantId)).connectionMode;
  }

  /** Envio por modelo (D-309) — mesma disciplina de `send` (fila, retry, driver do tenant). */
  async sendTemplate(tenantId: string, phone: string, template: TemplateSend): Promise<SendResult> {
    const credentials = await this.sendableCredentials(tenantId);
    const driver = this.driverFor(credentials);
    const sendTemplate = driver.sendTemplate?.bind(driver);
    if (!sendTemplate) throw new Error('driver do canal nao envia modelo da Meta');
    return withVia(
      credentials,
      this.queue.run('whatsapp.send_template', () => sendTemplate(credentials, phone, template), {
        attempts: this.attempts,
      }),
    );
  }

  /** Mesma disciplina de `send`, para mídia (Onda 8 §4.3). */
  async sendMedia(
    tenantId: string,
    phone: string,
    media: OutboundMedia,
    options: SendOptions = {},
  ): Promise<SendResult> {
    const credentials = await this.sendableCredentials(tenantId);
    const driver = this.driverFor(credentials);
    if (credentials.connectionMode === 'qr') {
      return withVia(
        credentials,
        this.queue.run('whatsapp.send_media', () => driver.sendMedia(credentials, phone, media, options), {
          attempts: this.attempts,
        }),
      );
    }

    // Cloud API (D-314): o que nunca muda entre tentativas fica FORA da fila —
    // formato recusado e ffmpeg que falhou nao sao repetidos; o WebM e
    // convertido uma vez so.
    const prepared = await this.prepareCloudMedia(media);
    return withVia(
      credentials,
      this.queue.run('whatsapp.send_media', () => driver.sendMedia(credentials, phone, prepared, options), {
        attempts: Math.min(this.attempts, CLOUD_API_MEDIA_ATTEMPTS),
      }),
    );
  }

  /** Formato e tamanho da Meta + WebM -> OGG (CRMLAB-140). Lanca sem chamar a Meta. */
  private async prepareCloudMedia(media: OutboundMedia): Promise<OutboundMedia> {
    const rule = cloudApiMediaRule(media.mimeType);
    if (!rule) throw new Error('formato de anexo nao aceito pela API oficial da Meta');
    let prepared = media;
    if (normalizeMediaMimeType(media.mimeType) === 'audio/webm') {
      prepared = {
        ...media,
        buffer: await this.convertAudio(media.buffer),
        mimeType: 'audio/ogg',
        fileName: `${media.fileName.replace(/\.[^./]+$/, '')}.ogg`,
      };
    }
    if (prepared.buffer.byteLength > rule.maxBytes) throw new Error('anexo acima do limite da API oficial da Meta');
    return prepared;
  }

  /** Reacao (CRMLAB-66, D-222) — mesma disciplina de `send`. `emoji: ''` remove. */
  async sendReaction(
    tenantId: string,
    phone: string,
    target: ReactionTarget,
    emoji: string,
  ): Promise<void> {
    const credentials = await this.sendableCredentials(tenantId);
    const driver = this.driverFor(credentials);
    const sendReaction = driver.sendReaction?.bind(driver);
    if (!sendReaction) {
      throw new Error(`driver whatsapp "${driver.name}" nao envia reacao`);
    }
    await this.queue.run(
      'whatsapp.send_reaction',
      () => sendReaction(credentials, phone, target, emoji),
      { attempts: this.attempts },
    );
  }

  /**
   * Presenca da atendente (D-226/D-227). Best-effort: UMA tentativa, sem fila
   * (repetir "digitando" atrasado nao serve para nada). Driver sem presenca
   * (Cloud API) = no-op. Quem chama nao espera nem trata o erro.
   */
  async sendPresence(tenantId: string, phone: string, presence: OutboundPresence): Promise<void> {
    const credentials = await this.sendableCredentials(tenantId);
    const driver = this.driverFor(credentials);
    if (!driver.sendPresence) return;
    await driver.sendPresence(credentials, phone, presence, PRESENCE_DELAY_MS[presence]);
  }

  /**
   * Editar/apagar da autora (CRMLAB-105, D-280). UMA tentativa, sem fila: a
   * atendente esta olhando a tela, e repetir "apagar" apos um timeout que na
   * verdade apagou nao ajuda. Falhou => lanca, e quem chama nao grava nada.
   */
  async editMessage(tenantId: string, phone: string, externalId: string, content: string): Promise<void> {
    const credentials = await this.sendableCredentials(tenantId);
    const driver = this.driverFor(credentials);
    if (!driver.editMessage) {
      throw new Error(`driver whatsapp "${driver.name}" nao edita mensagem`);
    }
    await driver.editMessage(credentials, phone, externalId, content);
  }

  /** "Apagar para todos" (D-280) — mesma disciplina de `editMessage`. */
  async deleteMessage(tenantId: string, phone: string, externalId: string): Promise<void> {
    const credentials = await this.sendableCredentials(tenantId);
    const driver = this.driverFor(credentials);
    if (!driver.deleteMessage) {
      throw new Error(`driver whatsapp "${driver.name}" nao apaga mensagem`);
    }
    await driver.deleteMessage(credentials, phone, externalId);
  }

  /**
   * O canal do tenant oferece editar/apagar (D-280)? E o que a tela usa para
   * mostrar os itens do menu. Qualquer erro (canal sem config, gateway nao
   * configurado) = `false`: na duvida, o item some.
   */
  async canEditMessages(tenantId: string): Promise<boolean> {
    try {
      const driver = this.driverFor(await this.credentials.forTenant(tenantId));
      return Boolean(driver.editMessage && driver.deleteMessage);
    } catch {
      return false;
    }
  }

  /**
   * Pre-checagem ANTES de gravar a mensagem (API_CONTRACTS §2, ordem
   * `CHANNEL_CLOUD_API_NOT_CONFIGURED` -> `WHATSAPP_WINDOW_CLOSED` ->
   * `MESSAGE_SEND_FAILED`): em `cloud_api` sem credencial completa, recusa sem
   * deixar mensagem `failed`. Em `qr` nao checa nada aqui — o QR despareado
   * continua virando `failed` no envio, como antes.
   */
  async assertCloudApiConfigured(tenantId: string): Promise<void> {
    const credentials = await this.credentials.forTenant(tenantId);
    if (credentials.connectionMode === 'qr') return;
    assertChannelConfigured(credentials);
  }

  /**
   * D-074: canal desligado NAO envia. Antes da fila, porque isso nao e falha
   * transitoria — repetir tres vezes so atrasaria o `failed` do atendente.
   * D-073 emendada: token revogado nao volta a sair pelo numero global.
   */
  private async sendableCredentials(tenantId: string): Promise<WhatsAppCredentials> {
    const credentials = await this.credentials.forTenant(tenantId);
    if (!credentials.isActive) {
      throw new Error('canal whatsapp desativado para este laboratorio (isActive: false)');
    }
    if (credentials.apiTokenRevoked) {
      throw new Error('token do canal whatsapp foi revogado por este laboratorio');
    }
    assertChannelConfigured(credentials);
    return credentials;
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
    const values = changeValues(payload);

    for (const value of values) {
      const names = contactNames(value);
      for (const raw of asArray(value.messages)) {
        const message = asRecord(raw);
        if (!message) continue;
        const from = asString(message.from);
        if (!from) continue;
        const parsed = cloudApiContentOf(message);
        if (!parsed) continue;
        out.push({
          phone: from,
          patientName: profileName(names.get(from) ?? null),
          ...parsed,
          externalId: asString(message.id),
          // Resposta citando (D-221): `context.id` e o wamid da citada.
          quotedExternalId: asString(asRecord(message.context)?.id),
        });
      }
    }

    // Formato plano (mock/dev) so quando o corpo NAO e da Meta (sem `entry[]`):
    // um aviso da Meta vazio ou todo descartado pela conferencia do numero nao
    // pode "cair" no formato plano (2a revisao do CRMLAB-139).
    if (out.length === 0 && !isMetaShaped(payload)) {
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

  /** Reacoes do paciente no aviso da Meta (`type: reaction`, D-222). */
  handleReactions(payload: unknown): InboundReactionDTO[] {
    const out: InboundReactionDTO[] = [];
    for (const value of changeValues(payload)) {
      for (const raw of asArray(value.messages)) {
        const message = asRecord(raw);
        if (!message || message.type !== 'reaction') continue;
        const reaction = asRecord(message.reaction);
        const targetExternalId = asString(reaction?.message_id);
        if (!targetExternalId) continue;
        const emoji = typeof reaction?.emoji === 'string' ? reaction.emoji : '';
        out.push({ targetExternalId, emoji });
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
    const values = changeValues(payload);

    for (const value of values) {
      for (const raw of asArray(value.statuses)) {
        const record = asRecord(raw);
        if (!record) continue;
        const externalId = asString(record.id);
        const status = STATUS_MAP[asString(record.status) ?? ''];
        if (externalId && !status) {
          // D-311 item 3: valor fora do mapa (ex.: `deleted`, `warning`) ignorado COM log.
          logger.info('whatsapp.status_unmapped', { externalId, status: asString(record.status) });
        }
        if (externalId && status) {
          out.push({
            externalId,
            status,
            ...(status === 'failed' ? { errorCode: errorCodeOf(record) } : {}),
            pricingCategory: pricingCategoryOf(record, externalId),
          });
        }
      }
    }

    if (out.length === 0 && !isMetaShaped(payload)) {
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
