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

  messages: (channelId: string, query: PaginationQuery = {}) =>
    http.get<ListInternalMessagesResponse>(
      `/internal-chat/channels/${channelId}/messages`,
      query as QueryParams,
    ),

  send: (channelId: string, body: SendInternalMessageRequest) =>
    http.post<InternalMessage>(`/internal-chat/channels/${channelId}/messages`, body),
};
