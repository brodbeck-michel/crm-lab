/**
 * Gestao da Operacao — tela /settings/operation (PAGES.md §10).
 * Espelha docs/api/API_CONTRACTS.md §7. Decisao D-067.
 *
 * TUDO e derivado de `conversations` + `proposals` (BUSINESS_RULES.md §5):
 * nenhuma tabela nova, nenhum numero digitado, nenhum contador materializado.
 * Tempos sao inteiros de SEGUNDOS calculados dentro do SQL, em UTC (D-021).
 */
import type { IsoDateTime, PaginationMeta } from './api.types.js';
import type { ConversationChannel } from './conversation.types.js';
import type { ProposalStatus } from './proposal.types.js';
import type { UserRole } from './auth.types.js';

/**
 * Por que a conversa esta na fila:
 * - `unassigned` — ativa e sem `assigned_to`
 * - `waiting`    — ativa, atribuida e com `unreadCount > 0` (paciente esperando resposta)
 */
export type QueueReason = 'unassigned' | 'waiting';

export interface QueueItem {
  conversationId: string;
  patientId: string | null;
  patientName: string | null;
  channel: ConversationChannel;
  reason: QueueReason;
  assignedTo: string | null;
  assignedToName: string | null;
  unreadCount: number;
  /** Segundos desde `COALESCE(last_message_at, created_at)`, calculado em UTC no SQL. */
  waitingSeconds: number;
  lastMessageAt: IsoDateTime | null;
}

export interface OperationQueue {
  unassigned: number;
  waiting: number;
  /** Maior espera da fila inteira (nao apenas dos itens listados). `null` se a fila esta vazia. */
  oldestWaitSeconds: number | null;
  /** Ordenado por `waitingSeconds DESC`. Recortado por `?queueLimit` (default 25, max 100). */
  items: QueueItem[];
}

/** Carga de um atendente. Usuario ativo sem carga aparece zerado, nao some. */
export interface WorkloadRow {
  userId: string;
  name: string;
  role: UserRole;
  activeConversations: number;
  /** Soma de `unread_count` das conversas ativas atribuidas a ele. */
  unreadMessages: number;
  /** Propostas em estagio NAO terminal criadas por ele. */
  openProposals: number;
  /** Propostas dele aguardando decisao de alcada. */
  pendingApprovals: number;
}

export interface PendingDecisionItem {
  proposalId: string;
  patientName: string | null;
  createdBy: string;
  createdByName: string;
  status: ProposalStatus;
  discountPercent: number;
  totalPrice: number;
  createdAt: IsoDateTime;
  /** Segundos desde `created_at`, calculado em UTC no SQL. */
  waitingSeconds: number;
}

export interface OperationPendingDecisions {
  total: number;
  /** Ordenado por `createdAt ASC` (o mais antigo primeiro). Recorte de `?decisionsLimit`. */
  items: PendingDecisionItem[];
  pagination: PaginationMeta;
}

/** Resposta unica da tela (D-067): os tres blocos saem do mesmo instante. */
export interface OperationOverviewResponse {
  /** Instante do retrato, em UTC. A tela mostra "atualizado ha X". */
  generatedAt: IsoDateTime;
  queue: OperationQueue;
  workload: WorkloadRow[];
  pendingDecisions: OperationPendingDecisions;
}

export interface OperationOverviewQuery {
  /** Itens da fila devolvidos. Default 25, maximo 100. */
  queueLimit?: number;
  /** Decisoes pendentes devolvidas. Default 25, maximo 100. */
  decisionsLimit?: number;
}
