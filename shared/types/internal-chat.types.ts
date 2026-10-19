import type { IsoDateTime, PaginationMeta } from './api.types.js';
import type { UserRole } from './auth.types.js';

export interface Channel {
  id: string;
  key: string;
  name: string;
  kind: 'channel' | 'dm';
  /**
   * Mensagens do canal criadas depois de `lastReadAt` e NAO escritas pelo proprio
   * usuario (D-068). Sem estado de leitura, conta todas as mensagens de terceiros.
   * Zera com `POST /internal-chat/channels/:id/read`. Supera D-044 (que servia 0 fixo).
   */
  unreadCount: number;
  /** Ultima leitura DESTE usuario neste canal (`channel_reads`). `null` = nunca abriu. */
  lastReadAt: IsoDateTime | null;
  lastMessageAt: IsoDateTime | null;
  /**
   * So preenchido quando `kind === 'dm'` (D-101): o OUTRO participante, visto por
   * quem pergunta. `name` da linha do canal e um valor interno e nunca e exibido
   * para DM — a tela usa sempre `otherUserName`.
   */
  otherUserId: string | null;
  otherUserName: string | null;
}

/** Item de `GET /internal-chat/users` — diretorio de quem da para abrir DM (D-101). */
export interface ChatDirectoryUser {
  id: string;
  name: string;
  role: UserRole;
}

export interface ListChatDirectoryResponse {
  users: ChatDirectoryUser[];
}

/** `POST /internal-chat/dms` — get-or-create idempotente (D-101). */
export interface CreateDirectChannelRequest {
  userId: string;
}

export interface InternalMessage {
  id: string;
  channelId: string;
  senderId: string | null;
  senderName: string;
  content: string;
  /** Proposta anexada renderiza como ProposalCard clicavel. */
  attachedProposalId: string | null;
  /**
   * Arquivo anexado (CRMLAB-101, D-271) — no maximo um por mensagem. O backend
   * sempre manda (`null` sem anexo); opcional so para fixtures antigas.
   */
  attachment?: InternalMessageAttachment | null;
  isSystem: boolean;
  createdAt: IsoDateTime;
}

export interface ListChannelsResponse {
  channels: Channel[];
}

/**
 * Paginacao do historico (D-069): a pagina 1 e a das mensagens MAIS RECENTES,
 * e os itens dentro dela vem em ordem cronologica crescente. A pagina 2 traz o
 * bloco imediatamente anterior. Mesma convencao de `GET /conversations/:id`.
 * Nao ha `sortBy` nem `order`.
 */
export interface ListInternalMessagesQuery {
  page?: number;
  /** Default 50, maximo 100. */
  limit?: number;
}

export interface ListInternalMessagesResponse {
  messages: InternalMessage[];
  pagination: PaginationMeta;
}

export interface SendInternalMessageRequest {
  content: string;
  attachedProposalId?: string | null;
}

/** Arquivo de uma mensagem do chat interno (CRMLAB-101, D-271, API_CONTRACTS §3b). */
export interface InternalMessageAttachment {
  id: string;
  /** Nome original — so metadado; em disco o arquivo tem o nome do `id`. */
  fileName: string;
  mimeType: string;
  byteSize: number;
  /** `/api/v1/internal-chat/channels/:channelId/attachments/:id` — exige Authorization. */
  url: string;
}

/**
 * `POST /internal-chat/channels/:id/attachments` (D-271) — base64 em JSON, como
 * `CreateAttachmentRequest` do atendimento. Tipo e teto: `ALLOWED_MEDIA_MIME_TYPES`
 * e `MAX_MEDIA_BYTES` (`media.types.ts`), os mesmos do atendimento.
 */
export interface CreateInternalAttachmentRequest {
  fileName: string;
  mimeType: string;
  contentBase64: string;
  /** Texto da mensagem (opcional, ate 4000 caracteres). */
  content?: string | null;
}
