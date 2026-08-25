import type { IsoDateTime, PaginationMeta } from './api.types.js';

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
}

export interface InternalMessage {
  id: string;
  channelId: string;
  senderId: string | null;
  senderName: string;
  content: string;
  /** Proposta anexada renderiza como ProposalCard clicavel. */
  attachedProposalId: string | null;
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
