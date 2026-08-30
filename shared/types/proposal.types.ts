import type { IsoDateTime, PaginationMeta, PaginationQuery } from './api.types.js';

/** Os 6 estagios. BUSINESS_RULES.md §3. */
export type ProposalStatus =
  | 'novo_contato'
  | 'orcamento_enviado'
  | 'follow_up'
  | 'negociacao'
  | 'ganho'
  | 'perdido';

export type LossReason = 'preco' | 'silencio' | 'exame_indisponivel' | 'prazo' | 'outro';

export type ApprovalStatus = 'none' | 'pending' | 'approved' | 'rejected';

export const PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  'novo_contato',
  'orcamento_enviado',
  'follow_up',
  'negociacao',
  'ganho',
  'perdido',
] as const;

export const LOSS_REASONS: readonly LossReason[] = [
  'preco',
  'silencio',
  'exame_indisponivel',
  'prazo',
  'outro',
] as const;

/** Estagios terminais: nenhuma transicao posterior (SERVICES.md §4). */
export const TERMINAL_STATUSES: readonly ProposalStatus[] = ['ganho', 'perdido'] as const;

/**
 * Matriz de transicoes validas. WORKFLOWS.md §4.
 * Front e back leem DESTA constante — divergencia e impossivel por construcao.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  novo_contato: ['orcamento_enviado', 'perdido'],
  orcamento_enviado: ['follow_up', 'negociacao', 'ganho', 'perdido'],
  follow_up: ['negociacao', 'ganho', 'perdido'],
  negociacao: ['ganho', 'perdido'],
  ganho: [],
  perdido: [],
} as const;

export function isTransitionAllowed(from: ProposalStatus, to: ProposalStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Rotulos pt-BR dos estagios — unico lugar que os define. */
export const PROPOSAL_STATUS_LABELS: Readonly<Record<ProposalStatus, string>> = {
  novo_contato: 'Novo contato',
  orcamento_enviado: 'Orçamento enviado',
  follow_up: 'Follow-up',
  negociacao: 'Negociação',
  ganho: 'Ganho',
  perdido: 'Perdido',
};

export const LOSS_REASON_LABELS: Readonly<Record<LossReason, string>> = {
  preco: 'Preço',
  silencio: 'Silêncio',
  exame_indisponivel: 'Exame indisponível',
  prazo: 'Prazo',
  outro: 'Outro',
};

export interface ProposalItem {
  id: string;
  examId: string;
  /** Snapshot do nome no momento da criacao (D-004). */
  examName: string;
  quantity: number;
  /** Snapshot do preco no momento da criacao (D-004). */
  unitPrice: number;
  /** Origem do `unitPrice`, snapshot no momento da criacao (Onda 7 — fallback nunca bloqueia). */
  priceSource: 'insurance' | 'private';
}

/** Proposta na listagem / pipeline. */
export interface Proposal {
  id: string;
  conversationId: string;
  patientName: string | null;
  status: ProposalStatus;
  discountPercent: number;
  /** SEMPRE calculado pelo backend a partir de items + desconto (D-003). */
  totalPrice: number;
  createdBy: string;
  createdByName: string;
  approvalStatus: ApprovalStatus;
  reasonLost: LossReason | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  closedAt: IsoDateTime | null;
  /** Convênio da proposta. `null` = particular (Onda 7). Imutável após a criação. */
  insuranceId: string | null;
}

export interface ProposalStageHistoryEntry {
  status: ProposalStatus;
  changedAt: IsoDateTime;
  changedBy: string | null;
  changedByName: string | null;
}

export interface ProposalDetail extends Proposal {
  patientPhone: string;
  items: ProposalItem[];
  /** Soma dos itens antes do desconto — derivado, exposto por conveniencia de exibicao. */
  subtotal: number;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: IsoDateTime | null;
  rejectionReason: string | null;
  sentAt: IsoDateTime | null;
  history: ProposalStageHistoryEntry[];
}

export interface CreateProposalItemInput {
  examId: string;
  quantity: number;
}

/** O cliente NUNCA envia precos nem totalPrice (FRONTEND_BACKEND.md §5). */
export interface CreateProposalRequest {
  conversationId: string;
  items: CreateProposalItemInput[];
  discountPercent?: number;
  /** Convênio da proposta. `null`/ausente = particular (Onda 7). Imutável após a criação —
   * `PATCH` não permite trocar (re-precificaria itens com snapshot, D-004). */
  insuranceId?: string | null;
}

export interface CreateProposalResponse extends ProposalDetail {
  /** Mensagem de UX quando a proposta cai em aprovacao. */
  message?: string;
}

export interface UpdateProposalStatusRequest {
  status: ProposalStatus;
  reasonLost?: LossReason;
}

export interface UpdateProposalDiscountRequest {
  discountPercent: number;
}

export interface RejectProposalRequest {
  reason: string;
}

export interface ListProposalsQuery extends PaginationQuery {
  /** Lista separada por virgula na query string. */
  status?: string;
  conversationId?: string;
  /**
   * Propostas do paciente (via `conversations.patient_id`). E como a ficha do
   * paciente lista as propostas dele — sem endpoint proprio, reusando a
   * visibilidade por papel de D-042 (D-060).
   */
  patientId?: string;
  createdBy?: string;
  startDate?: string;
  endDate?: string;
}

export interface ListProposalsResponse {
  proposals: Proposal[];
  pagination: PaginationMeta;
}

/**
 * Calculo canonico do total. BUSINESS_RULES.md §1.
 * Backend e frontend chamam ESTA funcao — um numero, uma origem.
 */
export function calculateSubtotal(items: Array<{ unitPrice: number; quantity: number }>): number {
  const cents = items.reduce(
    (sum, item) => sum + Math.round(item.unitPrice * 100) * item.quantity,
    0,
  );
  return cents / 100;
}

export function calculateTotal(
  items: Array<{ unitPrice: number; quantity: number }>,
  discountPercent: number,
): number {
  const subtotalCents = Math.round(calculateSubtotal(items) * 100);
  const totalCents = Math.round(subtotalCents * (1 - discountPercent / 100));
  return totalCents / 100;
}
