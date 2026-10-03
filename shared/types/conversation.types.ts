import type { IsoDateTime, PaginationMeta, PaginationQuery } from './api.types.js';
import type { UserRole } from './auth.types.js';

/**
 * `closed` = atendimento encerrado (D-174): fora da fila, composer travado,
 * reabre sozinho quando o paciente escreve. `archived` deixou de existir.
 */
export type ConversationStatus = 'active' | 'closed';
export type ConversationChannel = 'whatsapp' | 'sms' | 'web' | 'direct';
export type SenderType = 'patient' | 'agent' | 'system';
/** `video`, `sticker`, `location` e `contact` entraram no CRMLAB-70 (D-234). */
export type MessageType =
  | 'text'
  | 'image'
  | 'audio'
  | 'pdf'
  | 'doc'
  | 'video'
  | 'sticker'
  | 'location'
  | 'contact';

/** Lista canonica — valor fora dela, na leitura, vira `text`. */
export const MESSAGE_TYPES: readonly MessageType[] = [
  'text',
  'image',
  'audio',
  'pdf',
  'doc',
  'video',
  'sticker',
  'location',
  'contact',
] as const;

/**
 * Fatos do arquivo e do que o WhatsApp mandou junto (D-234). Nome, tamanho e
 * MIME vem de `message_media`; o resto de `messages.metadata`.
 */
export interface MessageMediaInfo {
  fileName: string;
  /** Bytes. */
  fileSize: number;
  mimeType: string;
  /** Video e audio. */
  durationSec: number | null;
  /** PDF, quando o WhatsApp informa. */
  pageCount: number | null;
  /** Miniatura JPEG do video em base64 (sem o prefixo `data:`). */
  thumbnail: string | null;
}

/** Localizacao compartilhada (D-235 item 4). */
export interface MessageLocation {
  latitude: number;
  longitude: number;
  name: string | null;
  address: string | null;
}

/** Cartao de contato compartilhado (D-235 item 5). `phone` em `+<digitos>`. */
export interface MessageContact {
  name: string;
  phone: string | null;
}
/**
 * `pending` = enviando (relogio), antes de o gateway devolver o id (D-225).
 * Ordem que nunca rebaixa: pending < sent < delivered < read; `failed` so a
 * partir de pending/sent — `MESSAGE_STATUS_RANK`.
 */
export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

/** Posicao de cada status na ordem de D-225. `failed` fica fora da escada. */
export const MESSAGE_STATUS_RANK: Readonly<Record<Exclude<MessageStatus, 'failed'>, number>> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

/**
 * `true` quando `next` pode substituir `current` (D-225 item 2): so sobe na
 * escada; `failed` so a partir de pending/sent; de `failed` so sai pelo reenvio
 * (que nao passa por aqui).
 */
export function canAdvanceMessageStatus(current: MessageStatus, next: MessageStatus): boolean {
  if (current === 'failed') return false;
  if (next === 'failed') return current === 'pending' || current === 'sent';
  return MESSAGE_STATUS_RANK[next] > MESSAGE_STATUS_RANK[current];
}

/**
 * Presenca do paciente no WhatsApp (D-226) — efemera, nunca gravada.
 * `typing` = digitando, `recording` = gravando audio.
 */
export type PatientPresence = 'typing' | 'recording' | 'online' | 'offline';

/**
 * `POST /conversations/:id/presence` (D-226/D-227). `paused` assina a presenca
 * do paciente sem mostrar nada a ele; `composing` mostra "digitando…".
 */
export interface SendPresenceRequest {
  presence: 'paused' | 'composing';
}

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
  /**
   * Alerta de tempo de resposta (CRMLAB-84, D-254): hora da PRIMEIRA mensagem
   * do paciente depois da última resposta de pessoa do laboratório
   * (`sender_type = 'agent'` e `automation` nulo — CRM ou celular). `null` =
   * ninguém esperando (a atendente falou por último, ou só houve mensagem
   * automática/de sistema sem paciente antes) ou conversa encerrada.
   * Opcional no tipo (AGENTS.md); o backend sempre preenche.
   */
  awaitingReplySince?: IsoDateTime | null;
}

/** Conversa aberta, com cadastro do paciente (coluna 3 do inbox). */
export interface ConversationDetail extends Conversation {
  patientEmail: string | null;
  customFields: Record<string, string>;
}

/**
 * Lado de quem reage (D-222): para o paciente o laboratorio e UM numero, entao
 * existe no maximo uma reacao por lado em cada mensagem.
 */
export type ReactorType = 'patient' | 'agent';

export interface MessageReaction {
  emoji: string;
  reactorType: ReactorType;
  /** Atendente que reagiu pelo CRM. `null` para o paciente e para o celular do laboratorio. */
  userId: string | null;
  userName: string | null;
  reactedAt: IsoDateTime;
}

/** Tamanho maximo de `QuotedMessageSummary.preview` (D-221). */
export const QUOTED_PREVIEW_MAX = 160;

/** Resumo da mensagem citada — o bloco em cima do balao (D-221). */
export interface QuotedMessageSummary {
  /** `null` = a original nao esta no CRM (anterior a conversa). */
  id: string | null;
  senderType: SenderType | null;
  senderName: string | null;
  /** Ate `QUOTED_PREVIEW_MAX` caracteres; `''` quando apagada ou indisponivel. */
  preview: string;
  messageType: MessageType | null;
  /** A original foi apagada pelo remetente (D-220). */
  deleted: boolean;
}

/** Barra rapida de reacoes da tela (D-222). A API aceita qualquer emoji. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

export interface Message {
  id: string;
  conversationId: string;
  senderType: SenderType;
  senderId: string | null;
  senderName: string | null;
  /** `''` quando `deletedAt` esta preenchido — a API nunca devolve o conteudo escondido (D-220). */
  content: string;
  messageType: MessageType;
  /** `null` quando apagada (D-220). */
  attachmentUrl: string | null;
  status: MessageStatus;
  readAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  /*
   * CRMLAB-66: os cinco campos abaixo sao OPCIONAIS no tipo (AGENTS.md: campo
   * novo e opcional ate os dois lados suportarem), mas o backend SEMPRE os
   * preenche. Ausente = `null`/`[]`.
   */
  /** Mensagem citada, quando ela esta no CRM (D-221). */
  quotedMessageId?: string | null;
  /** `null` = nao e resposta (ou a mensagem foi apagada). */
  quoted?: QuotedMessageSummary | null;
  /** No maximo uma por lado; `patient` antes de `agent`. `[]` quando apagada. */
  reactions?: MessageReaction[];
  /** O remetente editou no WhatsApp; `content` ja e o texto novo (D-220). */
  editedAt?: IsoDateTime | null;
  /** O remetente apagou "para todos": a tela mostra "Mensagem apagada" (D-220). */
  deletedAt?: IsoDateTime | null;
  /*
   * CRMLAB-70 (D-234): opcionais no tipo, o backend sempre manda. Apagada =
   * `null`/`null`/`[]`.
   */
  /** `null` sem anexo, com URL externa ou anexo apagado/anonimizado. */
  media?: MessageMediaInfo | null;
  /** So em `messageType: 'location'`. */
  location?: MessageLocation | null;
  /** So em `messageType: 'contact'`. */
  contacts?: MessageContact[];
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
 * `POST /conversations/whatsapp/open` (CRMLAB-70, D-236) — "Conversar" do
 * cartao de contato: abre a conversa que JA existe com o numero, sem enviar
 * nada. Numero sem conversa -> 404 (a tela cai na Nova conversa). Resposta:
 * `ConversationDetail` cru.
 */
export interface OpenWhatsAppConversationRequest {
  phone: string;
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
  /** So conversas com `unreadCount > 0` (CRMLAB-68, D-229) — recorte como o `scope`. */
  unread?: boolean;
}

export interface ListConversationsResponse {
  conversations: Conversation[];
  pagination: PaginationMeta;
  /**
   * Contagens dos chips de filtro — derivadas, nunca contadores separados.
   * `unread` (chip "Nao lidas", D-229) e opcional no tipo; o backend sempre manda.
   */
  counts: { mine: number; unassigned: number; unread?: number };
}

/**
 * `GET /conversations/:id` — API_CONTRACTS.md §2.
 * `before`/`after`/`around` (cursores, D-237/D-230) e `page` sao excludentes entre si.
 */
export interface GetConversationQuery {
  messageLimit?: number;
  page?: number;
  /** Id da mensagem: devolve as `messageLimit` anteriores a ela, na ordem `(createdAt, id)`. */
  before?: string;
  /** Id da mensagem: as `messageLimit` imediatamente posteriores a ela (D-230). */
  after?: string;
  /** Id da mensagem: a janela em volta dela — "ir ate a mensagem" da busca (D-230). */
  around?: string;
}

/** Cursores do historico (D-237/D-230). `null` = nao ha mais nada naquela direcao. */
export interface MessageCursors {
  /** Id da mensagem mais antiga da pagina quando ainda ha historico anterior. */
  before: string | null;
  /** Id da mensagem mais nova da pagina quando ainda ha mensagens mais novas (D-230). */
  after: string | null;
}

/**
 * `GET /conversations/search/messages` e `GET /conversations/:id/messages`
 * (CRMLAB-68, D-228). `q`: 2 a 120 caracteres; ignora acento e caixa.
 */
export interface SearchMessagesQuery {
  q: string;
  page?: number;
  limit?: number;
}

/** Uma mensagem achada pela busca. `content` vem inteiro: o trecho e da tela (D-228). */
export interface MessageSearchHit {
  messageId: string;
  conversationId: string;
  patientName: string | null;
  patientPhone: string;
  senderType: SenderType;
  senderName: string | null;
  messageType: MessageType;
  content: string;
  createdAt: IsoDateTime;
}

export interface SearchMessagesResponse {
  results: MessageSearchHit[];
  pagination: PaginationMeta;
}

export interface GetConversationResponse {
  conversation: ConversationDetail;
  messages: Message[];
  pagination: PaginationMeta;
  cursors: MessageCursors;
}

export interface CreateMessageRequest {
  content: string;
  messageType?: MessageType;
  attachmentUrl?: string | null;
  /** Responder citando (CRMLAB-66, D-221): mensagem DESTA conversa, nao apagada. */
  quotedMessageId?: string | null;
}

/** `PUT /conversations/:id/messages/:messageId/reaction` (D-222). */
export interface SetMessageReactionRequest {
  emoji: string;
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
