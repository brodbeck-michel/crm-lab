import type {
  CreateAttachmentRequest,
  CreateConversationRequest,
  CreateConversationResponse,
  CreateMessageRequest,
  GetConversationResponse,
  ListAssigneesResponse,
  ListConversationsQuery,
  ListConversationsResponse,
  Message,
  PaginationQuery,
  StartWhatsAppConversationRequest,
  StartWhatsAppConversationResponse,
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

  /** "Nova conversa" (CRMLAB-50, D-175): cria/reaproveita a conversa do número e envia. */
  startWhatsApp: (body: StartWhatsAppConversationRequest) =>
    http.post<StartWhatsAppConversationResponse>('/conversations/whatsapp', body),

  sendMessage: (id: string, body: CreateMessageRequest) =>
    http.post<Message>(`/conversations/${id}/messages`, body),

  /** Anexo — base64 em JSON, não multipart (Onda 8 §4.3). */
  sendAttachment: (id: string, body: CreateAttachmentRequest) =>
    http.post<Message>(`/conversations/${id}/attachments`, body),

  update: (id: string, body: UpdateConversationRequest) =>
    http.patch<UpdateConversationResponse>(`/conversations/${id}`, body),

  /** Quem pode receber conversa — a lista do menu "Transferir". */
  assignees: () => http.get<ListAssigneesResponse>('/conversations/assignees'),

  /** Atribuir a si mesmo / a outro atendente — `PATCH /conversations/:id`. */
  assign: (id: string, assignedTo: string | null) =>
    http.patch<UpdateConversationResponse>(`/conversations/${id}`, { assignedTo }),

  /** Fixar/desafixar para o usuário logado — o pin é pessoal (Onda 8 §2.3). */
  setPinned: (id: string, pinned: boolean) =>
    pinned
      ? http.post<void>(`/conversations/${id}/pin`, {})
      : http.delete<void>(`/conversations/${id}/pin`),

  /** Encerrar atendimento (D-174) — só dona, gestor ou admin; o backend valida. */
  close: (id: string) =>
    http.patch<UpdateConversationResponse>(`/conversations/${id}`, { status: 'closed' }),
};
