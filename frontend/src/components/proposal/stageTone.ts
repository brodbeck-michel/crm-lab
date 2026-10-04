import type { ProposalStatus } from '@crm-lab/shared';

/**
 * Identidade de cor de cada estágio do pipeline (CRMLAB-91, D-260) — fonte
 * única para coluna, cartão e selo. Classes LITERAIS de propósito: o Tailwind
 * só gera o que acha escrito por inteiro no código, então nada de montar
 * `bg-stage-${x}` em tempo de execução.
 *
 * A cor nunca é a única pista: o nome do estágio continua no título da coluna
 * e no selo do cartão.
 */
export interface StageTone {
  /** Fundo levemente tingido + faixa no topo da coluna. */
  column: string;
  /** Ponto ao lado do título da coluna. */
  dot: string;
  /** Texto do título da coluna. */
  title: string;
  /** Pílula de contagem e selo de estágio do cartão. */
  badge: string;
  /** Borda esquerda do cartão. */
  cardEdge: string;
}

export const STAGE_TONES: Readonly<Record<ProposalStatus, StageTone>> = {
  novo_contato: {
    column: 'bg-stage-novo-tint border-stage-novo',
    dot: 'bg-stage-novo',
    title: 'text-stage-novo-ink',
    badge: 'bg-stage-novo-soft text-stage-novo-ink',
    cardEdge: 'border-l-stage-novo',
  },
  orcamento_enviado: {
    column: 'bg-stage-enviado-tint border-stage-enviado',
    dot: 'bg-stage-enviado',
    title: 'text-stage-enviado-ink',
    badge: 'bg-stage-enviado-soft text-stage-enviado-ink',
    cardEdge: 'border-l-stage-enviado',
  },
  follow_up: {
    column: 'bg-stage-followup-tint border-stage-followup',
    dot: 'bg-stage-followup',
    title: 'text-stage-followup-ink',
    badge: 'bg-stage-followup-soft text-stage-followup-ink',
    cardEdge: 'border-l-stage-followup',
  },
  negociacao: {
    column: 'bg-stage-negociacao-tint border-stage-negociacao',
    dot: 'bg-stage-negociacao',
    title: 'text-stage-negociacao-ink',
    badge: 'bg-stage-negociacao-soft text-stage-negociacao-ink',
    cardEdge: 'border-l-stage-negociacao',
  },
  ganho: {
    column: 'bg-stage-ganho-tint border-stage-ganho',
    dot: 'bg-stage-ganho',
    title: 'text-stage-ganho-ink',
    badge: 'bg-stage-ganho-soft text-stage-ganho-ink',
    cardEdge: 'border-l-stage-ganho',
  },
  perdido: {
    column: 'bg-stage-perdido-tint border-stage-perdido',
    dot: 'bg-stage-perdido',
    title: 'text-stage-perdido-ink',
    badge: 'bg-stage-perdido-soft text-stage-perdido-ink',
    cardEdge: 'border-l-stage-perdido',
  },
};
