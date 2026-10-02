import type {
  CreateAttachmentRequest,
  CreateConversationRequest,
  CreateConversationResponse,
  CreateMessageRequest,
  GetConversationQuery,
  GetConversationResponse,
  ListAssigneesResponse,
  ListConversationsQuery,
  ListConversationsResponse,
  ConversationDetail,
  Message,
  OpenWhatsAppConversationRequest,
  SendPresenceRequest,
  SearchMessagesQuery,
  SearchMessagesResponse,
  SetMessageReactionRequest,
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

  /** `before` = cursor (D-237); `page` segue aceito por compatibilidade. */
  get: (id: string, query: GetConversationQuery = {}) =>
    http.get<GetConversationResponse>(`/conversations/${id}`, query as QueryParams),

  /** Atendimento manual — ligacao, balcao, site (nao vem do WhatsApp). */
  create: (body: CreateConversationRequest) =>
    http.post<CreateConversationResponse>('/conversations', body),

  /** "Nova conversa" (CRMLAB-50, D-175): cria/reaproveita a conversa do número e envia. */
  startWhatsApp: (body: StartWhatsAppConversationRequest) =>
    http.post<StartWhatsAppConversationResponse>('/conversations/whatsapp', body),

  /** "Conversar" do cartão de contato (CRMLAB-70, D-236): abre a existente; 404 = não há. */
  openWhatsApp: (body: OpenWhatsAppConversationRequest) =>
    http.post<ConversationDetail>('/conversations/whatsapp/open', body),

  sendMessage: (id: string, body: CreateMessageRequest) =>
    http.post<Message>(`/conversations/${id}/messages`, body),

  /** Anexo — base64 em JSON, não multipart (Onda 8 §4.3). */
  sendAttachment: (id: string, body: CreateAttachmentRequest) =>
    http.post<Message>(`/conversations/${id}/attachments`, body),

  /** Reação do laboratório (CRMLAB-66, D-222) — substitui a anterior. */
  setReaction: (id: string, messageId: string, body: SetMessageReactionRequest) =>
    http.put<Message>(`/conversations/${id}/messages/${messageId}/reaction`, body),

  /** Tira a reação do laboratório (204, idempotente). */
  removeReaction: (id: string, messageId: string) =>
    http.delete<void>(`/conversations/${id}/messages/${messageId}/reaction`),

  /** "Tentar de novo" (CRMLAB-67, D-227) — reenvia a MESMA mensagem que falhou. */
  retryMessage: (id: string, messageId: string) =>
    http.post<Message>(`/conversations/${id}/messages/${messageId}/retry`, {}),

  /** Presença da atendente (D-226/D-227): `paused` assina, `composing` = digitando. 204. */
  sendPresence: (id: string, body: SendPresenceRequest) =>
    http.post<void>(`/conversations/${id}/presence`, body),

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

  /** Busca pelo conteúdo em todas as conversas visíveis (D-228). */
  searchMessages: (query: SearchMessagesQuery) =>
    http.get<SearchMessagesResponse>(
      '/conversations/search/messages',
      query as unknown as QueryParams,
    ),

  /** Busca dentro de uma conversa (D-228). */
  searchInConversation: (id: string, query: SearchMessagesQuery) =>
    http.get<SearchMessagesResponse>(
      `/conversations/${id}/messages`,
      query as unknown as QueryParams,
    ),

  /** "Marcar como não lida" (D-229) — 204, idempotente. */
  markUnread: (id: string) => http.post<void>(`/conversations/${id}/unread`, {}),

  /** Encerrar atendimento (D-174) — só dona, gestor ou admin; o backend valida. */
  close: (id: string) =>
    http.patch<UpdateConversationResponse>(`/conversations/${id}`, { status: 'closed' }),
};
