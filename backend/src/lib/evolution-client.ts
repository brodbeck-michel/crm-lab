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

/** Nome da instancia no gateway. Unico ponto de decisao — nao duplique a formula. */
export function evolutionInstanceName(tenantId: string): string {
  return `tenant-${tenantId}`;
}

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
    events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
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
export function createEvolutionClient(baseUrl: string, adminApiKey: string): EvolutionClient {
  const base = baseUrl.replace(/\/+$/, '');

  /** `apikeyOverride` sobrescreve `adminApiKey` — usado so por `sendText` (I6). */
  async function request(
    path: string,
    init: RequestInit = {},
    apikeyOverride?: string,
  ): Promise<unknown> {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        apikey: apikeyOverride ?? adminApiKey,
        ...(init.headers ?? {}),
      },
    });

    const text = await response.text();
    const body: unknown = text.length > 0 ? safeJsonParse(text) : null;

    if (!response.ok) {
      throw new Error(
        `Evolution API respondeu ${response.status} em ${path}: ${text.slice(0, 500)}`,
      );
    }
    return body;
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
