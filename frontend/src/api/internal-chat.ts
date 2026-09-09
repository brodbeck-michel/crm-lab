import type {
  Channel,
  CreateDirectChannelRequest,
  ListChannelsResponse,
  ListChatDirectoryResponse,
  ListInternalMessagesResponse,
  InternalMessage,
  PaginationQuery,
  SendInternalMessageRequest,
} from '@crm-lab/shared';
import { http } from './client';
import type { QueryParams } from './client';

/**
 * docs/domain/WORKFLOWS.md §6 — Chat Interno.
 * Mensagem pode anexar `attachedProposalId`, que a tela renderiza como
 * `ProposalCard` clicável (abre o Modal da Proposta).
 */
export const internalChatApi = {
  channels: () => http.get<ListChannelsResponse>('/internal-chat/channels'),

  /**
   * `POST /internal-chat/channels/:id/read` — 204, sem corpo, idempotente.
   * É o que zera `Channel.unreadCount` (D-068). A tela chama ao ABRIR o canal:
   * `messages` abaixo NÃO marca como lido de propósito (ler página antiga do
   * histórico não é ter visto a mensagem nova).
   */
  markRead: (channelId: string) =>
    http.post<void>(`/internal-chat/channels/${channelId}/read`),

  messages: (channelId: string, query: PaginationQuery = {}) =>
    http.get<ListInternalMessagesResponse>(
      `/internal-chat/channels/${channelId}/messages`,
      query as QueryParams,
    ),

  send: (channelId: string, body: SendInternalMessageRequest) =>
    http.post<InternalMessage>(`/internal-chat/channels/${channelId}/messages`, body),

  /** Diretório de quem dá para abrir DM (D-101) — exclui o próprio usuário e inativos. */
  directory: () => http.get<ListChatDirectoryResponse>('/internal-chat/users'),

  /**
   * `POST /internal-chat/dms` — get-or-create idempotente (D-101, 200 não 201).
   * Clicar num usuário com quem já existe DM só devolve o mesmo canal de novo.
   */
  startDirectChannel: (body: CreateDirectChannelRequest) =>
    http.post<Channel>('/internal-chat/dms', body),
};
