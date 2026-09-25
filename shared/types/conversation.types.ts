import type { IsoDateTime, PaginationMeta, PaginationQuery } from './api.types.js';
import type { UserRole } from './auth.types.js';

/**
 * `closed` = atendimento encerrado (D-174): fora da fila, composer travado,
 * reabre sozinho quando o paciente escreve. `archived` deixou de existir.
 */
export type ConversationStatus = 'active' | 'closed';
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
  /**
   * Fixada no topo da lista **por quem pediu** (Onda 8 §2.3). A MESMA conversa
   * vem `true` para quem fixou e `false` para as colegas: pin e pessoal, nao
   * estado compartilhado da conversa.
   */
  pinned: boolean;
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
 * canal nasce pelo webhook ou por `POST /conversations/whatsapp` (D-175).
 */
export interface CreateConversationRequest {
  patientPhone: string;
  patientName: string;
  patientEmail?: string | null;
  channel: Exclude<ConversationChannel, 'whatsapp'>;
}

/** Conversa criada — ou a que ja existia naquele telefone (dedupe por numero). */
export type CreateConversationResponse = ConversationDetail;

/**
 * `POST /conversations/whatsapp` (CRMLAB-50, D-175) — botao "Nova conversa":
 * o atendente manda a PRIMEIRA mensagem de WhatsApp para um numero. Telefone
 * que ja tem conversa no laboratorio reaproveita a conversa (e o paciente);
 * so numero novo cria. `phone` e validado por `normalizeBrazilianPhone`.
 */
export interface StartWhatsAppConversationRequest {
  phone: string;
  content: string;
}

export interface StartWhatsAppConversationResponse {
  conversation: ConversationDetail;
  message: Message;
}

/**
 * Telefone brasileiro digitado -> E.164 (`+55` + DDD + numero), ou `null`
 * quando nao e um numero BR valido (D-175). Fonte unica: o formulario do front
 * e o zod do backend chamam ESTA funcao, entao "valido na tela" e "valido na
 * API" nao divergem.
 *
 * Aceita com ou sem mascara e com ou sem o `55`: DDD (dois digitos de 1 a 9)
 * + 9 digitos comecando por 9 (celular) ou 8 digitos comecando de 2 a 9 (fixo,
 * ou celular no formato antigo que o WhatsApp ainda usa em alguns numeros).
 */
export function normalizeBrazilianPhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  const national =
    (digits.length === 12 || digits.length === 13) && digits.startsWith('55')
      ? digits.slice(2)
      : digits;
  if (national.length !== 10 && national.length !== 11) return null;
  if (!/^[1-9]{2}/.test(national)) return null;
  const local = national.slice(2);
  if (local.length === 9 && !local.startsWith('9')) return null;
  if (local.length === 8 && !/^[2-9]/.test(local)) return null;
  return `+55${national}`;
}

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

/**
 * Quem pode receber uma conversa — `GET /conversations/assignees`.
 * So id, nome e papel: a lista alimenta o menu "Transferir", nao a tela de
 * usuarios (que continua admin-only em `GET /users`).
 */
export interface ConversationAssignee {
  id: string;
  name: string;
  role: Exclude<UserRole, 'platform_operator'>;
}

export interface ListAssigneesResponse {
  assignees: ConversationAssignee[];
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
