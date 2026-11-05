/**
 * Canais & Equipe — tela /settings/channels (PAGES.md §10).
 * Espelha docs/api/API_CONTRACTS.md §6. Decisoes D-064, D-065 e D-066.
 *
 * REGRA DE SEGREDO: `apiToken` e `webhookSecret` NUNCA voltam na resposta.
 * A leitura expressa presenca/prefixo (`apiTokenMasked`, `webhookSecretSet`);
 * a escrita e write-only (`UpdateTenantChannelInput`).
 */
import type { IsoDateTime } from './api.types.js';
import type { ConversationChannel } from './conversation.types.js';
import type { UserRole } from './auth.types.js';

/** Canal conectado do laboratorio. Um por `channel` (UNIQUE (tenant_id, channel)). */
export interface TenantChannel {
  id: string;
  channel: ConversationChannel;
  /** Nome exibido na tela ("WhatsApp do Vida"). */
  displayName: string | null;
  /** Identificador publico do numero no provedor (Meta `phone_number_id`). */
  phoneNumberId: string | null;
  /** Numero em exibicao, como o provedor devolve. */
  phoneNumber: string | null;
  isActive: boolean;
  /**
   * Mascara do token: `'••••••••' + ultimos 4 caracteres`, ou `null` se nao ha token.
   * O valor em claro nunca sai do backend.
   */
  apiTokenMasked: string | null;
  /** Presenca do segredo do webhook. NAO ha previa: o segredo e curto e valida HMAC. */
  webhookSecretSet: boolean;
  /** Quando o canal foi conectado (primeiro token gravado). */
  connectedAt: IsoDateTime | null;
  updatedAt: IsoDateTime;
  /**
   * Como o canal fala com o provedor. `cloud_api` = API oficial da Meta (token/segredo desta
   * interface); `qr` = número próprio pareado via QR code, sem API oficial (Onda 7, Bloco B).
   */
  connectionMode: 'cloud_api' | 'qr';
  /** Id da conta WhatsApp Business (Meta), só `cloud_api`. Não é segredo (CRMLAB-138). */
  wabaId: string | null;
  /** Quando o termo de risco do QR foi aceito. `null` = nunca aceito. Só relevante para `qr`. */
  acceptedTermsAt: IsoDateTime | null;
}

/** Corpo de `POST /settings/channels/whatsapp/connect` quando o aceite ainda não foi dado. */
export interface WhatsAppQrConnectRequest {
  acceptTerms: true;
}

export type WhatsAppConnectionStatus = 'pairing' | 'connected' | 'disconnected';

/** Resposta de `POST /settings/channels/whatsapp/connect` e `GET .../whatsapp/qr`. */
export interface WhatsAppQrResponse {
  /** Base64 PNG. `null` quando já conectado. */
  qrcode: string | null;
  status: WhatsAppConnectionStatus;
  /** `null` quando não há QR pendente (ex.: já conectado). */
  expiresInSeconds: number | null;
}

/** Resposta de `GET /settings/channels/whatsapp/status` — status do canal, sem QR. */
export interface WhatsAppStatusResponse {
  status: WhatsAppConnectionStatus;
  phoneNumber: string | null;
  connectedAt: IsoDateTime | null;
  /**
   * Última queda gravada (CRMLAB-134, D-307). `null` quando conectado ou sem
   * registro. Opcional no tipo (AGENTS.md); o backend sempre preenche.
   */
  lastDisconnect?: WhatsAppDisconnectInfo | null;
}

/**
 * Por que o WhatsApp por QR caiu (D-307): `logged_out` = o gateway fechou com
 * 401 (desvinculado no celular, removido pelo WhatsApp ou conta restringida);
 * `manual` = "Desconectar" da tela; `other` = qualquer outro `close`.
 */
export type WhatsAppDisconnectReason = 'manual' | 'logged_out' | 'other';

export interface WhatsAppDisconnectInfo {
  at: IsoDateTime;
  reason: WhatsAppDisconnectReason;
  statusCode: number | null;
}

/** Como a conversa nova (fila) chega ao atendente. */
export type DistributionMode = 'manual' | 'round_robin';

/** Mensagem automatica. Texto vazio com `enabled: true` e VALIDATION_ERROR. */
export interface AutoMessage {
  enabled: boolean;
  /** 1..1000 caracteres quando `enabled`. */
  message: string | null;
}

export interface AutoMessagesSettings {
  /** Saudacao na primeira mensagem de uma conversa nova. */
  greeting: AutoMessage;
  /** Resposta fora do horario de atendimento (usa `businessHours`). */
  offHours: AutoMessage;
}

export type WeekDay = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** Faixa de atendimento de um dia. `'HH:MM'` em 24h, no `timezone` declarado. */
export interface BusinessHoursRange {
  start: string;
  end: string;
}

export interface BusinessHours {
  /** IANA tz. Default 'America/Sao_Paulo'. */
  timezone: string;
  /** Dia ausente ou `null` = fechado. */
  days: Partial<Record<WeekDay, BusinessHoursRange | null>>;
}

/**
 * Membro da equipe exibido na tela. Recorte deliberadamente minimo (D-066):
 * sem e-mail e sem alcada — o gestor le a tela sem precisar de `GET /users` (admin).
 */
export interface ChannelTeamMember {
  id: string;
  name: string;
  role: UserRole;
  isActive: boolean;
}

export interface ChannelSettingsResponse {
  channels: TenantChannel[];
  distributionMode: DistributionMode;
  autoMessages: AutoMessagesSettings;
  businessHours: BusinessHours;
  team: ChannelTeamMember[];
}

/**
 * Upsert de um canal, identificado por `channel` (nao por id).
 * Segredos: campo ausente PRESERVA o valor guardado; `null` APAGA; string grava o novo.
 */
export interface UpdateTenantChannelInput {
  channel: ConversationChannel;
  displayName?: string | null;
  phoneNumberId?: string | null;
  phoneNumber?: string | null;
  isActive?: boolean;
  /** Write-only. Nunca volta na resposta. 10..500 caracteres. */
  apiToken?: string | null;
  /** Write-only. Nunca volta na resposta. 16..255 caracteres. */
  webhookSecret?: string | null;
  /** Só `whatsapp`. Id da conta WhatsApp Business (Meta). Máx. 64 caracteres. Não é segredo. */
  wabaId?: string | null;
}

/** Corpo de `PUT /settings/channels/whatsapp/mode` (CRMLAB-135, D-308). */
export interface UpdateWhatsAppModeRequest {
  mode: 'cloud_api' | 'qr';
}

/** Resposta de `PUT /settings/channels/whatsapp/mode`. */
export interface UpdateWhatsAppModeResponse {
  connectionMode: 'cloud_api' | 'qr';
  /** `true` quando `phoneNumberId`, `wabaId` e token existem na linha do canal. */
  cloudApiConfigured: boolean;
}

/** PATCH parcial (admin). Corpo vazio → VALIDATION_ERROR. */
export interface UpdateChannelSettingsRequest {
  channels?: UpdateTenantChannelInput[];
  distributionMode?: DistributionMode;
  autoMessages?: Partial<AutoMessagesSettings>;
  businessHours?: BusinessHours;
}
