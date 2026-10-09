/**
 * Motor de tempo do funil (CRMLAB-59, D-205..D-209). SERVICES.md §27.
 *
 * Funcoes PURAS, usadas pelo backend (o motor decide quem anda) e pelo
 * frontend (o selo "Parado há N h" e o rótulo "movido pela regra"): divergir
 * é impossível por construção, no espírito de `checkTransition`.
 *
 * Relógio de referência: Brasília, UTC−3 fixo (sem horário de verão desde
 * 2019), a mesma referência do Bitlab (D-187). Feriados ficam fora (D-205).
 */
import type { DayCounting, StaleNewBudgetAlertRule } from './funnel-rules.types.js';
import type { IsoDateTime } from './api.types.js';
import type { ProposalStatus } from './proposal.types.js';

/** As regras de prazo em dias que movem cartão. */
export type TimerRuleKey = 'sentToFollowUp' | 'negotiationToFollowUp' | 'followUpToLost';

export interface TimerStep {
  rule: TimerRuleKey;
  from: ProposalStatus;
  to: ProposalStatus;
}

/** Os três passos do motor (D-205), na ordem em que o tique os percorre. */
export const TIMER_STEPS: readonly TimerStep[] = [
  { rule: 'sentToFollowUp', from: 'orcamento_enviado', to: 'follow_up' },
  { rule: 'negotiationToFollowUp', from: 'negociacao', to: 'follow_up' },
  { rule: 'followUpToLost', from: 'follow_up', to: 'perdido' },
] as const;

/**
 * Gravado em `proposal_status_history.automation` quando o motor move o
 * cartão (D-208) e exposto em `history[].automation`. O prazo e a contagem
 * são os VIGENTES na hora da transição.
 */
export interface StageAutomation {
  rule: TimerRuleKey;
  days: number;
  dayCounting: DayCounting;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Brasília = UTC−3. */
const SAO_PAULO_OFFSET_MS = -3 * HOUR_MS;

/** 0 = domingo, 6 = sábado, no relógio de Brasília. */
function saoPauloWeekday(localMs: number): number {
  return new Date(localMs).getUTCDay();
}

function isWeekend(localMs: number): boolean {
  const day = saoPauloWeekday(localMs);
  return day === 0 || day === 6;
}

/**
 * Instante em que o prazo de `days` vence para um cartão que entrou no
 * estágio em `enteredAt` (D-205 itens 2 e 3).
 * - `calendar`: `enteredAt + days × 24 h`.
 * - `business`: seg–sex em Brasília. Entrada no fim de semana começa a contar
 *   na segunda 00:00; cada dia útil soma 24 h pulando sábado e domingo.
 */
export function timerDeadline(enteredAt: Date, days: number, counting: DayCounting): Date {
  if (counting === 'calendar') return new Date(enteredAt.getTime() + days * DAY_MS);

  // Trabalha no "relógio de parede" de Brasília representado em UTC.
  let local = enteredAt.getTime() + SAO_PAULO_OFFSET_MS;
  if (isWeekend(local)) {
    const midnight = local - (local % DAY_MS);
    local = midnight;
    while (isWeekend(local)) local += DAY_MS;
  }
  for (let i = 0; i < days; i += 1) {
    local += DAY_MS;
    while (isWeekend(local)) local += DAY_MS;
  }
  return new Date(local - SAO_PAULO_OFFSET_MS);
}

/** O prazo de `days` já venceu em `now`? */
export function isDelayElapsed(
  enteredAt: Date,
  now: Date,
  days: number,
  counting: DayCounting,
): boolean {
  return now.getTime() >= timerDeadline(enteredAt, days, counting).getTime();
}

/** Horas INTEIRAS desde `enteredAt` (horas corridas, D-207). */
export function hoursSince(enteredAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - enteredAt.getTime()) / HOUR_MS));
}

/** Minutos INTEIROS desde `enteredAt` (corridos, D-267). */
export function minutesSince(enteredAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - enteredAt.getTime()) / MINUTE_MS));
}

/**
 * Duração do selo/toast de cartão parado (D-267): `"N min"` abaixo de 1 h,
 * `"N h"` (horas inteiras) daí em diante.
 */
export function formatStaleDuration(minutes: number): string {
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
}

/**
 * Cartão de "Novo orçamento" parado (D-207/D-267): regra ligada, estágio
 * `novo_contato` e há `rule.minutes` minutos corridos ou mais na coluna. O
 * motor usa para alertar; o front, para o selo "Parado há N min/h".
 */
export function isStaleNewBudget(
  status: ProposalStatus,
  stageEnteredAt: IsoDateTime | null | undefined,
  rule: StaleNewBudgetAlertRule,
  now: Date,
): boolean {
  if (!rule.enabled || status !== 'novo_contato') return false;
  if (stageEnteredAt === null || stageEnteredAt === undefined) return false;
  const entered = new Date(stageEnteredAt);
  if (Number.isNaN(entered.getTime())) return false;
  return now.getTime() - entered.getTime() >= rule.minutes * MINUTE_MS;
}

function daysLabel(days: number, counting: DayCounting): string {
  const unit = days === 1 ? 'dia' : 'dias';
  const kind = counting === 'business' ? (days === 1 ? ' útil' : ' úteis') : '';
  return `${days} ${unit}${kind}`;
}

/**
 * Texto de "movido pela regra: …" no histórico do modal (D-208), ex.:
 * `"Enviado há 3 dias"`, `"Negociação sem pagamento há 7 dias úteis"`.
 */
export function describeStageAutomation(automation: StageAutomation): string {
  const span = daysLabel(automation.days, automation.dayCounting);
  switch (automation.rule) {
    case 'sentToFollowUp':
      return `Enviado há ${span}`;
    case 'negotiationToFollowUp':
      return `Negociação sem pagamento há ${span}`;
    case 'followUpToLost':
      return `Follow-up há ${span} (Silêncio)`;
  }
}
