import type { IsoDateTime, PaginationMeta, PaginationQuery } from './api.types.js';

export type ConversationStatus = 'active' | 'archived' | 'closed';
export type ConversationChannel = 'whatsapp' | 'sms' | 'web' | 'direct';
export type SenderType = 'patient' | 'agent' | 'system';
export type MessageType = 'text' | 'image' | 'audio' | 'pdf' | 'doc';
export type MessageStatus = 'sent' | 'delivered' | 'read' | 'failed';

/** Item da lista de conversas (coluna 1 do inbox). */
export interface Conversation {
  id: string;
  /**
   * Cadastro do paciente por tras da conversa (`patients.id`, D-059) — a porta
   * de entrada da Ficha do Paciente (`/patients/:id`, PAGES.md §3).
   *
   * `null` quando a conversa e anterior ao backfill da migracao 003 e ainda nao
   * passou por `findOrCreateByPhone` (D-072). Nesse caso a UI NAO mostra o link:
   * link quebrado e pior que link ausente (D-079).
   */
  patientId: string | null;
  patientName: string | null;
  patientPhone: string;
  assignedTo: string | null;
  assignedToName: string | null;
  channel: ConversationChannel;
  status: ConversationStatus;
  unreadCount: number;
  lastMessagePreview: string | null;
  lastMessageAt: IsoDateTime | null;
  tags: string[];
  createdAt: IsoDateTime;
}

/** Conversa aberta, com cadastro do paciente (coluna 3 do inbox). */
export interface ConversationDetail extends Conversation {
  patientEmail: string | null;
  customFields: Record<string, string>;
}

export interface Message {
  id: string;
  conversationId: string;
  senderType: SenderType;
  senderId: string | null;
  senderName: string | null;
  content: string;
  messageType: MessageType;
  attachmentUrl: string | null;
  status: MessageStatus;
  readAt: IsoDateTime | null;
  createdAt: IsoDateTime;
}

/**
 * `POST /conversations` — atendimento que nao veio do WhatsApp (ligacao,
 * balcao, site). `whatsapp` fica FORA do enum de propriedade: conversa desse
 * canal so nasce pelo webhook, que dedupe por `externalId`.
 */
export interface CreateConversationRequest {
  patientPhone: string;
  patientName: string;
  patientEmail?: string | null;
  channel: Exclude<ConversationChannel, 'whatsapp'>;
}

/** Conversa criada — ou a que ja existia naquele telefone (dedupe por numero). */
export type CreateConversationResponse = ConversationDetail;

export interface ListConversationsQuery extends PaginationQuery {
  status?: ConversationStatus;
  /** 'mine' = atribuidas ao usuario logado; 'unassigned' = fila livre. */
  scope?: 'mine' | 'unassigned' | 'all';
  search?: string;
}

export interface ListConversationsResponse {
  conversations: Conversation[];
  pagination: PaginationMeta;
  /** Contagens dos chips de filtro — derivadas, nunca contadores separados. */
  counts: { mine: number; unassigned: number };
}

export interface GetConversationResponse {
  conversation: ConversationDetail;
  messages: Message[];
  pagination: PaginationMeta;
}

export interface CreateMessageRequest {
  content: string;
  messageType?: MessageType;
  attachmentUrl?: string | null;
}

export interface UpdateConversationRequest {
  status?: ConversationStatus;
  assignedTo?: string | null;
  tags?: string[];
}

export interface UpdateConversationResponse {
  id: string;
  status: ConversationStatus;
  assignedTo: string | null;
  assignedToName: string | null;
  tags: string[];
}
