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

export interface EvolutionClient {
  createInstance(instanceName: string): Promise<EvolutionInstanceHandle>;
  getQr(instanceName: string): Promise<EvolutionQrResult>;
  getStatus(instanceName: string): Promise<EvolutionStatusResult>;
  logout(instanceName: string): Promise<void>;
  sendText(instanceName: string, phone: string, text: string): Promise<EvolutionSendResult>;
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

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        apikey: adminApiKey,
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

  return {
    async createInstance(instanceName: string): Promise<EvolutionInstanceHandle> {
      const body = await request('/instance/create', {
        method: 'POST',
        body: JSON.stringify({ instanceName, qrcode: true, integration: 'WHATSAPP-BAILEYS' }),
      });
      const record = isRecord(body) ? body : {};
      const instance = isRecord(record.instance) ? record.instance : {};
      const hash = isRecord(record.hash) ? record.hash : {};
      const name = asString(instance.instanceName) ?? instanceName;
      const apikey = asString(hash.apikey);
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
      const status =
        typeof record.status === 'string'
          ? (record.status as EvolutionConnectionStatus)
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
    ): Promise<EvolutionSendResult> {
      const body = await request(`/message/sendText/${encodeURIComponent(instanceName)}`, {
        method: 'POST',
        body: JSON.stringify({ number: phone, text }),
      });
      const record = isRecord(body) ? body : {};
      const key = isRecord(record.key) ? record.key : {};
      const externalId = asString(key.id);
      if (!externalId) {
        throw new Error('Evolution API nao devolveu id da mensagem em /message/sendText');
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
