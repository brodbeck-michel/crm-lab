/**
 * Lembrete de contato da proposta parada (CRMLAB-102, D-272). Espelha
 * docs/api/API_CONTRACTS.md §3 (`PUT /proposals/:id/reminder`,
 * `POST /proposals/:id/reminder/resolve`).
 *
 * `isReminderDue` é PURA e usada pelo motor (aviso), pela listagem
 * (`?reminder=due`) e pela tela (selo "Lembrete"): divergir é impossível por
 * construção, no espírito de `isStaleNewBudget`.
 *
 * Dia de referência: Brasília, UTC−3 fixo (a mesma do motor, D-205).
 */
import type { IsoDate, IsoDateTime } from './api.types.js';
import type { LossReason } from './proposal.types.js';

/** `auto`: nasceu da regra das Regras; `manual`: "Agendar lembrete" ou reagendamento. */
export type ProposalReminderOrigin = 'auto' | 'manual';

/**
 * Desfecho. `auto_closed` = a proposta fechou por outro caminho (motor, LIS,
 * mudança de estágio fora do lembrete) e o lembrete se encerrou sozinho.
 */
export type ProposalReminderOutcome = 'won' | 'lost' | 'rescheduled' | 'auto_closed';

export const PROPOSAL_REMINDER_OUTCOMES: readonly ProposalReminderOutcome[] = [
  'won',
  'lost',
  'rescheduled',
  'auto_closed',
] as const;

export const PROPOSAL_REMINDER_OUTCOME_LABELS: Readonly<Record<ProposalReminderOutcome, string>> = {
  won: 'Ganho',
  lost: 'Perdido',
  rescheduled: 'Reagendado',
  auto_closed: 'Encerrado automaticamente',
};

/** `?reminder=` de `GET /proposals`. */
export type ProposalReminderFilter = 'due' | 'open';

export const PROPOSAL_REMINDER_FILTERS: readonly ProposalReminderFilter[] = ['due', 'open'] as const;

/** Tamanho máximo da observação (`note` e `outcomeNote`). */
export const PROPOSAL_REMINDER_NOTE_MAX = 500;

/** Até quantos dias à frente o lembrete pode ser marcado. */
export const PROPOSAL_REMINDER_MAX_DAYS_AHEAD = 365;

/** O lembrete aberto, como vem em `Proposal.reminder`. */
export interface ProposalReminder {
  id: string;
  origin: ProposalReminderOrigin;
  /** Dia do contato em Brasília, `YYYY-MM-DD`. */
  dueDate: IsoDate;
  note: string | null;
  /** `null` no automático. */
  createdBy: string | null;
  createdByName: string | null;
  createdAt: IsoDateTime;
}

/** Um lembrete no histórico do detalhe (`ProposalDetail.reminders`). */
export interface ProposalReminderEntry extends ProposalReminder {
  resolvedAt: IsoDateTime | null;
  /** `null` no aberto e no `auto_closed`. */
  resolvedBy: string | null;
  resolvedByName: string | null;
  /** `null` = aberto. */
  outcome: ProposalReminderOutcome | null;
  outcomeNote: string | null;
}

/** `PUT /proposals/:id/reminder` — cria ou reagenda o aberto. Resposta: `ProposalDetail`. */
export interface ScheduleProposalReminderRequest {
  dueDate: IsoDate;
  /** `null`/vazio = sem observação. */
  note?: string | null;
}

/** `POST /proposals/:id/reminder/resolve`. Resposta: `ProposalDetail`. */
export type ResolveProposalReminderRequest =
  | { outcome: 'won' }
  | { outcome: 'lost'; reasonLost?: LossReason }
  | { outcome: 'rescheduled'; dueDate: IsoDate; note: string };

const DAY_MS = 24 * 60 * 60 * 1000;
/** Brasília = UTC−3. */
const SAO_PAULO_OFFSET_MS = -3 * 60 * 60 * 1000;

/** O dia de hoje em Brasília, `YYYY-MM-DD`. */
export function saoPauloToday(now: Date): IsoDate {
  return new Date(now.getTime() + SAO_PAULO_OFFSET_MS).toISOString().slice(0, 10);
}

/** `day` + `days` dias de calendário, `YYYY-MM-DD`. */
export function addDaysToIsoDate(day: IsoDate, days: number): IsoDate {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` que existe no calendário. */
export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Lembrete vencido (D-272 item 4): existe e o dia dele é hoje ou antes, no dia
 * de Brasília. Comparação de `YYYY-MM-DD` como texto é cronológica.
 */
export function isReminderDue(
  reminder: Pick<ProposalReminder, 'dueDate'> | null | undefined,
  now: Date,
): boolean {
  if (reminder === null || reminder === undefined) return false;
  return reminder.dueDate <= saoPauloToday(now);
}
