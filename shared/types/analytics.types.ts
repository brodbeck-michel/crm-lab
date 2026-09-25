import type { IsoDate } from './api.types.js';
import type { LossReason, ProposalStatus } from './proposal.types.js';

export interface FunnelReport {
  period: { startDate: IsoDate; endDate: IsoDate };
  funnel: {
    novoContato: number;
    orcamentoEnviado: number;
    followUp: number;
    negociacao: number;
    ganho: number;
    perdido: number;
    /** ganhos / total criadas no periodo, em pontos percentuais. */
    conversionRate: number;
  };
  lossReasons: Record<LossReason, number>;
  /** Receita do periodo: soma dos totalPrice das propostas ganhas. Numero, nunca string. */
  revenue: number;
  averageTicket: number;
  topPerformers: Array<{
    userId: string;
    name: string;
    conversions: number;
    revenue: number;
  }>;
  /** true quando o usuario e atendente e ve apenas as proprias metricas. */
  partial: boolean;
  /**
   * O que o LIS confirma, separado do que a atendente marcou (CRMLAB-52, D-119 item 9).
   * `wonFromLis` por `closedAt` no periodo; `paidCount`/`paidValue` por `lis_paid_on`.
   */
  realized: { wonFromLis: number; paidCount: number; paidValue: number };
}

export interface PipelineSnapshot {
  byStatus: Record<ProposalStatus, { count: number; value: number }>;
  totalValue: number;
  averageTicket: number;
  openCount: number;
  oldestProposal: { id: string; daysOpen: number; status: ProposalStatus } | null;
}

export interface AnalyticsQuery {
  startDate?: IsoDate;
  endDate?: IsoDate;
  groupBy?: 'daily' | 'weekly' | 'monthly';
}

/**
 * Desempenho de UM atendente no periodo (linha da tabela "desempenho por
 * atendente" de PAGES.md §8). Todos os campos derivam de `proposals` —
 * BUSINESS_RULES.md §5.
 */
export interface TeamMemberPerformance {
  userId: string;
  name: string;
  /** Propostas CRIADAS pelo usuario no periodo (janela por `createdAt`). */
  created: number;
  /** Propostas GANHAS no periodo (janela por `closedAt`). */
  won: number;
  /** Propostas PERDIDAS no periodo (janela por `closedAt`). */
  lost: number;
  /** `won / created * 100`, em pontos percentuais. 0 quando nao criou nada. */
  conversionRate: number;
  /** Numero, nunca string formatada (FRONTEND_BACKEND.md "Datas e Dinheiro"). */
  revenue: number;
  /** `revenue / won`. 0 quando nao houve ganho — nunca divide por zero. */
  averageTicket: number;
}

/** `GET /analytics/team` — gestor/admin (SERVICES.md §9). */
export interface TeamReport {
  period: { startDate: IsoDate; endDate: IsoDate };
  members: TeamMemberPerformance[];
  totals: {
    created: number;
    won: number;
    lost: number;
    conversionRate: number;
    revenue: number;
    averageTicket: number;
  };
}
