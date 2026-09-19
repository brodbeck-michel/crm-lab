/**
 * Cliente HTTP do gateway Evolution API — WhatsApp por QR self-hosted (Onda 7
 * Bloco B, docs/superpowers/specs/2026-08-30-onda-7-design.md §4).
 *
 * ============================================================================
 * Uma instancia do gateway POR TENANT (`tenant-<uuid>`)
 * ============================================================================
 * Cada laboratorio que conecta o proprio numero por QR vira uma "instance" no
 * Evolution, com apikey PROPRIA (devolvida por `createInstance` e cifrada em
 * `tenant_channels.api_token` pelo chamador, D-076 — este arquivo NUNCA cifra
 * nem decifra, so fala HTTP). `evolutionInstanceName` e o UNICO lugar que
 * decide o nome: `ChannelSettingsService` e `EvolutionWhatsAppDriver` chamam a
 * mesma funcao para nunca divergir.
 *
 * ============================================================================
 * Erro e SEMPRE `Error` simples, nunca `BusinessError`
 * ============================================================================
 * Este arquivo e uma camada de transporte — nao conhece o catalogo de erros da
 * API (`docs/api/API_ERRORS.md`). Quem traduz "gateway respondeu 500" para
 * `CHANNEL_QR_UNAVAILABLE`/`MESSAGE_SEND_FAILED` e o SERVICE, uma camada acima
 * (mesma divisao de `HttpWhatsAppDriver` em `whatsapp.service.ts`).
 */
import { env } from '../config/env.js';
import { withGatewayTimeout } from './fetch-timeout.js';

/**
 * Orcamento de UMA chamada ao gateway (CRMLAB-30, D-135).
 *
 * De onde saem os numeros: o envio roda dentro da fila com 3 tentativas
 * (SERVICES.md §11) e backoff de 200 ms + 400 ms, e o teto duro e o
 * `proxy_read_timeout 60s` do nginx — passar disso troca o `MESSAGE_SEND_FAILED`
 * (502, que a tela explica) por um 504 generico. O orcamento total e
 * `3 * timeout + 0,6 s < 60 s`, ou seja timeout < 19,8 s.
 *
 * - 10 s para o resto: sao chamadas de CONTROLE (criar instancia, ler QR, ler
 *   estado, deslogar) e envio de texto, todas com corpo minusculo contra um
 *   gateway na mesma rede do Compose. Se demorar 10 s, nao e lentidao: e o
 *   gateway doente do incidente de 17/09. Pior caso total ~30,6 s.
 * - 15 s para midia: `sendMedia` sobe ate 15 MB (`MAX_MEDIA_BYTES`) em base64,
 *   ~20 MB de corpo, e o gateway so responde depois de repassar o arquivo ao
 *   WhatsApp. Reusar os 10 s daria timeout em anexo legitimo. Pior caso total
 *   ~45,6 s — ainda abaixo dos 60 s do nginx, com margem.
 */
export const EVOLUTION_TIMEOUT_MS = 10_000;
export const EVOLUTION_MEDIA_TIMEOUT_MS = 15_000;

export interface EvolutionClientOptions {
  /** Timeout das chamadas de controle e de `sendText`. Default: 10 s. */
  timeoutMs?: number;
  /** Timeout de `sendMedia`. Default: 15 s. */
  mediaTimeoutMs?: number;
}

/** Nome da instancia no gateway. Unico ponto de decisao — nao duplique a formula. */
export function evolutionInstanceName(tenantId: string): string {
  return `tenant-${tenantId}`;
}

/**
 * Chave do QR vigente no cache. O webhook `QRCODE_UPDATED` escreve, o
 * `GET /settings/channels/whatsapp/qr` le — assim o polling do modal nao
 * precisa chamar `/instance/connect`, que recria a conexao a cada chamada.
 * Unico ponto de decisao, como `evolutionInstanceName`.
 */
export function evolutionQrCacheKey(tenantId: string): string {
  return `evolution:qr:${tenantId}`;
}

/**
 * TTL do QR em cache. O WhatsApp expira o QR em ~60s e o gateway emite um
 * `QRCODE_UPDATED` novo antes disso; o TTL so garante que um QR morto nao
 * fique sendo servido se o gateway parar de emitir.
 */
export const EVOLUTION_QR_TTL_SECONDS = 70;

export interface EvolutionInstanceHandle {
  instanceName: string;
  apikey: string;
}

export type EvolutionConnectionStatus = 'pairing' | 'connected' | 'disconnected';

export interface EvolutionQrResult {
  /** Base64 PNG (formato que o gateway devolve). `null` quando ja conectado. */
  qrcode: string | null;
  status: EvolutionConnectionStatus;
}

export interface EvolutionStatusResult {
  status: EvolutionConnectionStatus;
  /** Numero do WhatsApp pareado, ja sem o sufixo `@s.whatsapp.net`. `null` se nao conectado. */
  phoneNumber: string | null;
}

export interface EvolutionSendResult {
  externalId: string;
}

/** Mídia a enviar — base64 (o mesmo formato em que o gateway devolve mídia recebida). */
export interface EvolutionMediaPayload {
  base64: string;
  mimeType: string;
  fileName: string;
}

/**
 * Para onde o gateway posta os eventos desta instancia. `token` vai como header
 * `x-evolution-webhook-token` — o MESMO header documentado que
 * `webhook.routes.ts` confere em tempo constante.
 */
export interface EvolutionWebhookConfig {
  url: string;
  token: string;
}

export interface EvolutionClient {
  createInstance(
    instanceName: string,
    webhook?: EvolutionWebhookConfig,
  ): Promise<EvolutionInstanceHandle>;
  getQr(instanceName: string): Promise<EvolutionQrResult>;
  getStatus(instanceName: string): Promise<EvolutionStatusResult>;
  logout(instanceName: string): Promise<void>;
  /**
   * `apikey` e a chave DA INSTANCIA (a mesma que `createInstance` devolveu e
   * `ChannelSettingsService` cifra em `tenant_channels.api_token`, D-076) —
   * NAO a `adminApiKey` deste cliente. Fix do Important 6 da revisao da
   * Task 5: envio com privilegio de administrador do gateway, para uma
   * operacao que so precisa falar com a PROPRIA instancia, era o oposto de
   * privilegio minimo — e deixava a apikey cifrada em repouso sem NENHUM
   * consumidor.
   */
  sendText(
    instanceName: string,
    phone: string,
    text: string,
    apikey: string,
  ): Promise<EvolutionSendResult>;
  /** Mesma disciplina de privilegio minimo do `sendText` — `apikey` da instancia. */
  sendMedia(
    instanceName: string,
    phone: string,
    media: EvolutionMediaPayload,
    apikey: string,
  ): Promise<EvolutionSendResult>;
}

/** `image/jpeg` -> `'image'`. `audio/*` -> `'audio'`. Resto -> `'document'` (contrato do `/message/sendMedia`). */
function evolutionMediaType(mimeType: string): 'image' | 'audio' | 'document' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}

/**
 * Corpo do webhook aceito tanto por `/instance/create` quanto por
 * `/webhook/set`. So os dois eventos que o CRM trata (`webhook.routes.ts`):
 * mensagem que entra e mudanca de estado da conexao.
 */
function webhookBody(webhook: EvolutionWebhookConfig): Record<string, unknown> {
  return {
    url: webhook.url,
    byEvents: false,
    base64: true,
    headers: { 'x-evolution-webhook-token': webhook.token },
    // `QRCODE_UPDATED` entrou na auditoria de 2026-09-17. Sem ele, a unica
    // forma de obter o QR era `GET /instance/connect`, que NAO e uma leitura:
    // cada chamada instancia uma conexao Baileys nova. Com o modal dando
    // polling de 2 em 2 segundos, isso rendeu 169 sockets em 3 minutos e
    // terminou com o WhatsApp invalidando a sessao (401). Recebendo o QR por
    // webhook, o polling le do cache e nao toca no gateway.
    events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'],
  };
}

/**
 * `hash` do `/instance/create` e a apikey em STRING no gateway v2.3.7
 * (`"hash":"38BD..."`). O formato `{apikey}` era o do v1 — aceito aqui so por
 * compatibilidade.
 */
function apikeyOf(hash: unknown): string | null {
  return asString(hash) ?? (isRecord(hash) ? asString(hash.apikey) : null);
}

/**
 * 404 `The "x" instance does not exist` — a instancia sumiu do gateway (reset do
 * container, banco do gateway limpo, admin apagou pelo manager). Nao e "gateway
 * fora do ar": o CHAMADOR trata como canal desconectado, para a tela conseguir
 * reconectar em vez de travar num erro.
 */
export function isInstanceNotFound(error: unknown): boolean {
  return error instanceof Error && /does not exist/i.test(error.message);
}

/**
 * 500 `Connection Closed` no `/instance/logout` — a sessao Baileys morreu (o
 * celular deslogou: `disconnectionReasonCode: 401`) mas o Evolution continua
 * persistindo `connectionStatus: "open"`. Nao ha socket para deslogar, e o
 * `/instance/delete` recusa com 400 enquanto o registro disser `open` — o ciclo
 * so quebra reiniciando o CONTAINER do gateway (`/instance/restart` nao basta:
 * ele mexe no socket sem reavaliar o registro persistido).
 *
 * Distinto de "gateway fora do ar": aqui ele responde normalmente. Verificado
 * em producao contra o v2.3.7 em 2026-09-17.
 */
export function isSessionClosed(error: unknown): boolean {
  return error instanceof Error && /connection closed/i.test(error.message);
}

/** 403 `This name "x" is already in use.` — instancia ja existe, nao e falha. */
function isAlreadyInUse(error: unknown): boolean {
  return error instanceof Error && /already in use/i.test(error.message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `"5511987654321@s.whatsapp.net"` -> `"5511987654321"`. `null` se nao houver telefone. */
function phoneOf(jid: unknown): string | null {
  const raw = asString(jid);
  if (!raw) return null;
  const [phone] = raw.split('@');
  return phone && phone.length > 0 ? phone : null;
}

/** `open` (gateway) -> `connected` (contrato interno); qualquer outro estado -> `disconnected`. */
function statusOf(state: unknown): EvolutionConnectionStatus {
  if (state === 'open') return 'connected';
  if (state === 'connecting') return 'pairing';
  return 'disconnected';
}

/**
 * Cliente HTTP puro (fetch nativo, Node 18+). `baseUrl`/`adminApiKey` sao os de
 * `EVOLUTION_API_URL`/`EVOLUTION_API_KEY` — a chave ADMINISTRATIVA do gateway
 * (cria/gerencia instancias). O envio de mensagem usa a MESMA chave aqui: a
 * apikey por instancia so importa para o proprio Evolution rotear webhooks; o
 * cliente HTTP deste arquivo sempre fala com privilegio de administrador.
 */
export function createEvolutionClient(
  baseUrl: string,
  adminApiKey: string,
  options: EvolutionClientOptions = {},
): EvolutionClient {
  const base = baseUrl.replace(/\/+$/, '');
  const defaultTimeoutMs = options.timeoutMs ?? EVOLUTION_TIMEOUT_MS;
  const mediaTimeoutMs = options.mediaTimeoutMs ?? EVOLUTION_MEDIA_TIMEOUT_MS;

  /**
   * `apikeyOverride` sobrescreve `adminApiKey` — usado so por `sendText` (I6).
   *
   * O `fetch` E a leitura do corpo rodam dentro de `withGatewayTimeout`: o
   * `fetch` resolve nos headers, entao um corpo que nunca termina travaria
   * aqui do mesmo jeito se o signal cobrisse so a primeira metade (D-135).
   * Estourado o prazo, sobe `GatewayTimeoutError`, que a fila retenta.
   */
  async function request(
    path: string,
    init: RequestInit = {},
    apikeyOverride?: string,
    timeoutMs: number = defaultTimeoutMs,
  ): Promise<unknown> {
    // A query string pode carregar nome de instancia — o log fica so com a rota.
    const [route = path] = path.split('?');
    const { ok, status, text } = await withGatewayTimeout(
      { gateway: 'evolution', path: route, timeoutMs },
      async (signal) => {
        const response = await fetch(`${base}${path}`, {
          ...init,
          signal,
          headers: {
            'Content-Type': 'application/json',
            apikey: apikeyOverride ?? adminApiKey,
            ...(init.headers ?? {}),
          },
        });
        return { ok: response.ok, status: response.status, text: await response.text() };
      },
    );

    if (!ok) {
      throw new Error(
        `Evolution API respondeu ${status} em ${path}: ${text.slice(0, 500)}`,
      );
    }
    return text.length > 0 ? safeJsonParse(text) : null;
  }

  /** apikey da instancia ja existente — `token` no `/instance/fetchInstances`. */
  async function fetchInstanceToken(instanceName: string): Promise<string> {
    const body = await request(
      `/instance/fetchInstances?instanceName=${encodeURIComponent(instanceName)}`,
      { method: 'GET' },
    );
    const first = Array.isArray(body) && isRecord(body[0]) ? body[0] : null;
    const apikey = first ? asString(first.token) : null;
    if (!apikey) {
      throw new Error(`Evolution API nao devolveu token da instancia ${instanceName}`);
    }
    return apikey;
  }

  async function setWebhook(instanceName: string, webhook: EvolutionWebhookConfig): Promise<void> {
    await request(`/webhook/set/${encodeURIComponent(instanceName)}`, {
      method: 'POST',
      body: JSON.stringify({ webhook: { enabled: true, ...webhookBody(webhook) } }),
    });
  }

  return {
    async createInstance(
      instanceName: string,
      webhook?: EvolutionWebhookConfig,
    ): Promise<EvolutionInstanceHandle> {
      let body: unknown;
      try {
        body = await request('/instance/create', {
          method: 'POST',
          body: JSON.stringify({
            instanceName,
            qrcode: true,
            integration: 'WHATSAPP-BAILEYS',
            ...(webhook ? { webhook: webhookBody(webhook) } : {}),
          }),
        });
      } catch (error) {
        // `/instance/create` NAO e idempotente: a segunda chamada com o mesmo
        // nome responde 403 `already in use` (verificado contra o v2.3.7). Toda
        // RECONEXAO cai aqui — sem esta adocao, so o primeiro pareamento de
        // cada tenant funcionava.
        if (!isAlreadyInUse(error)) throw error;
        const apikey = await fetchInstanceToken(instanceName);
        if (webhook) await setWebhook(instanceName, webhook);
        return { instanceName, apikey };
      }
      const record = isRecord(body) ? body : {};
      const instance = isRecord(record.instance) ? record.instance : {};
      const name = asString(instance.instanceName) ?? instanceName;
      const apikey = apikeyOf(record.hash);
      if (!apikey) {
        throw new Error('Evolution API nao devolveu apikey da instancia em /instance/create');
      }
      return { instanceName: name, apikey };
    },

    async getQr(instanceName: string): Promise<EvolutionQrResult> {
      const body = await request(`/instance/connect/${encodeURIComponent(instanceName)}`, {
        method: 'GET',
      });
      const record = isRecord(body) ? body : {};
      const qrcode = asString(record.base64);
      // Fix do Minor 7 da revisao da Task 5: `/instance/connect` do Evolution
      // real NAO devolve `status` — devolve `{pairingCode, code, base64, ...}`
      // enquanto pareando e `{instance: {instanceName, state: "open"}}` quando
      // JA CONECTADO (sem `base64`). O cast antigo em `record.status` nunca
      // batia contra um gateway de verdade e caia sempre no fallback; agora a
      // instancia ja conectada e detectada por `record.instance.state` via
      // `statusOf` (a MESMA funcao de `getStatus`, nao um cast solto), e so
      // na ausencia de `instance` o `qrcode` decide entre pairing/disconnected.
      const instance = isRecord(record.instance) ? record.instance : null;
      const status: EvolutionConnectionStatus = instance
        ? statusOf(instance.state)
        : qrcode
          ? 'pairing'
          : 'disconnected';
      return { qrcode, status };
    },

    async getStatus(instanceName: string): Promise<EvolutionStatusResult> {
      const body = await request(
        `/instance/connectionState/${encodeURIComponent(instanceName)}`,
        { method: 'GET' },
      );
      const record = isRecord(body) ? body : {};
      const instance = isRecord(record.instance) ? record.instance : {};
      const status = statusOf(instance.state);
      const phoneNumber = status === 'connected' ? phoneOf(instance.owner) : null;
      return { status, phoneNumber };
    },

    async logout(instanceName: string): Promise<void> {
      await request(`/instance/logout/${encodeURIComponent(instanceName)}`, {
        method: 'DELETE',
      });
    },

    async sendText(
      instanceName: string,
      phone: string,
      text: string,
      apikey: string,
    ): Promise<EvolutionSendResult> {
      const body = await request(
        `/message/sendText/${encodeURIComponent(instanceName)}`,
        { method: 'POST', body: JSON.stringify({ number: phone, text }) },
        apikey,
      );
      const record = isRecord(body) ? body : {};
      const key = isRecord(record.key) ? record.key : {};
      const externalId = asString(key.id);
      if (!externalId) {
        throw new Error('Evolution API nao devolveu id da mensagem em /message/sendText');
      }
      return { externalId };
    },

    async sendMedia(
      instanceName: string,
      phone: string,
      media: EvolutionMediaPayload,
      apikey: string,
    ): Promise<EvolutionSendResult> {
      const body = await request(
        `/message/sendMedia/${encodeURIComponent(instanceName)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            number: phone,
            mediatype: evolutionMediaType(media.mimeType),
            mimetype: media.mimeType,
            fileName: media.fileName,
            media: media.base64,
          }),
        },
        apikey,
        // Unica chamada com corpo grande — orcamento proprio (D-135).
        mediaTimeoutMs,
      );
      const record = isRecord(body) ? body : {};
      const key = isRecord(record.key) ? record.key : {};
      const externalId = asString(key.id);
      if (!externalId) {
        throw new Error('Evolution API nao devolveu id da mensagem em /message/sendMedia');
      }
      return { externalId };
    },
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Cliente default de producao: `undefined` quando `EVOLUTION_API_URL`/
 * `EVOLUTION_API_KEY` nao estao configuradas — o CHAMADOR (services) e quem
 * decide o que fazer com a ausencia (D-turn: opcional, nunca crash de boot).
 */
export function createDefaultEvolutionClient(): EvolutionClient | undefined {
  const url = env.EVOLUTION_API_URL;
  const key = env.EVOLUTION_API_KEY;
  if (!url || url.trim().length === 0 || !key || key.trim().length === 0) return undefined;
  return createEvolutionClient(url, key);
}
