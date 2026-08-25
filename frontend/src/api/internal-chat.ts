import type {
  ListChannelsResponse,
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
};
