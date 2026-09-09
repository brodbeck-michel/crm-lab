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
 *
 * `orcamento_enviado`/`follow_up`/`negociacao` tambem voltam UM passo (D-105):
 * atendente clicou "Enviar orçamento" errado, ou a negociação esfriou e
 * precisa voltar para follow-up. `ganho`/`perdido` continuam TERMINAIS —
 * `ProposalService.updateStatus` recusa qualquer transição a partir deles
 * ANTES de consultar esta matriz (`isTerminal`), voltar não reabre proposta
 * fechada.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  novo_contato: ['orcamento_enviado', 'perdido'],
  orcamento_enviado: ['novo_contato', 'follow_up', 'negociacao', 'ganho', 'perdido'],
  follow_up: ['orcamento_enviado', 'negociacao', 'ganho', 'perdido'],
  negociacao: ['follow_up', 'ganho', 'perdido'],
  ganho: [],
  perdido: [],
} as const;

export function isTransitionAllowed(from: ProposalStatus, to: ProposalStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Próximo estágio da sequência PRINCIPAL, sem pular (D-105) — o que o botão
 * "Avançar para X" do modal usa. Diferente de `ALLOWED_TRANSITIONS`, que
 * também permite pular estágios (ex: `orcamento_enviado` -> `ganho` direto,
 * pelo seletor "Mudar estágio"). Sem entrada para `novo_contato` (a
 * transição de saída dele é "Enviar orçamento", que já é seu próprio botão)
 * nem para `negociacao`/`ganho`/`perdido` (dali a decisão é Ganho ou
 * Perdido, com motivo — não um "próximo passo" automático).
 */
export const NEXT_STAGE: Readonly<Partial<Record<ProposalStatus, ProposalStatus>>> = {
  orcamento_enviado: 'follow_up',
  follow_up: 'negociacao',
};

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
  /** Numero sequencial POR TENANT, para rastreamento (citavel por telefone/WhatsApp). */
  proposalNumber: number;
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

/**
 * `POST /proposals` devolve `ProposalDetail` cru. Onda 7 removeu o campo
 * `message` opcional (texto de UX pt-BR do backend) — i18n é do frontend, e
 * `approvalStatus` já diz o que houve (mesma razão de `PATCH .../approve` e
 * `.../reject`, Onda 6).
 */
export type CreateProposalResponse = ProposalDetail;

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
  /** Busca por nome do paciente (`conversations.patient_name`), case-insensitive. */
  search?: string;
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

/**
 * `123` -> `"#000123"` — 6 digitos com zero a esquerda: citavel por telefone
 * sem ambiguidade, e do mesmo jeito que numero de nota/pedido.
 */
export function formatProposalNumber(proposalNumber: number): string {
  return `#${String(proposalNumber).padStart(6, '0')}`;
}

export function calculateTotal(
  items: Array<{ unitPrice: number; quantity: number }>,
  discountPercent: number,
): number {
  const subtotalCents = Math.round(calculateSubtotal(items) * 100);
  const totalCents = Math.round(subtotalCents * (1 - discountPercent / 100));
  return totalCents / 100;
}
