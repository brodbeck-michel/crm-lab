import type {
  CreateConversationRequest,
  CreateConversationResponse,
  CreateMessageRequest,
  GetConversationResponse,
  ListConversationsQuery,
  ListConversationsResponse,
  Message,
  PaginationQuery,
  UpdateConversationRequest,
  UpdateConversationResponse,
} from '@crm-lab/shared';
import { http } from './client';
import type { QueryParams } from './client';

/** docs/api/API_CONTRACTS.md §2 — Conversations. */
export const conversationsApi = {
  list: (query: ListConversationsQuery = {}) =>
    http.get<ListConversationsResponse>('/conversations', query as QueryParams),

  get: (id: string, query: PaginationQuery = {}) =>
    http.get<GetConversationResponse>(`/conversations/${id}`, query as QueryParams),

  /** Atendimento manual — ligacao, balcao, site (nao vem do WhatsApp). */
  create: (body: CreateConversationRequest) =>
    http.post<CreateConversationResponse>('/conversations', body),

  sendMessage: (id: string, body: CreateMessageRequest) =>
    http.post<Message>(`/conversations/${id}/messages`, body),

  update: (id: string, body: UpdateConversationRequest) =>
    http.patch<UpdateConversationResponse>(`/conversations/${id}`, body),

  /** Atribuir a si mesmo / a outro atendente — `PATCH /conversations/:id`. */
  assign: (id: string, assignedTo: string | null) =>
    http.patch<UpdateConversationResponse>(`/conversations/${id}`, { assignedTo }),

  archive: (id: string) =>
    http.patch<UpdateConversationResponse>(`/conversations/${id}`, { status: 'archived' }),
};
