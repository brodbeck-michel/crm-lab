/**
 * Reingajamento da conversa e feriados (CRMLAB-62, D-211..D-214).
 * Espelha docs/api/API_CONTRACTS.md §6c (regras) e §6d (feriados).
 *
 * Tudo aqui é PURO: o motor de tempo (`reengagement.service.ts`) decide com
 * estas funções, e a página de Regras mostra os feriados nacionais com a mesma
 * `nationalHolidays`.
 */
import type { IsoDate } from './api.types.js';
import type { ReengagementRules } from './funnel-rules.types.js';
import type { BusinessHours, WeekDay } from './settings.types.js';

// ---------------------------------------------------------------------------
// Feriados (D-213)
// ---------------------------------------------------------------------------

export type HolidaySource = 'national' | 'custom';

export interface Holiday {
  /** `null` nos nacionais (calculados, não gravados). */
  id: string | null;
  date: IsoDate;
  description: string;
  source: HolidaySource;
}

/** `GET /settings/holidays?year=AAAA`. */
export interface HolidaysResponse {
  year: number;
  national: Holiday[];
  custom: Holiday[];
}

/** `POST /settings/holidays`. */
export interface CreateHolidayRequest {
  date: IsoDate;
  description: string;
}

export const HOLIDAY_DESCRIPTION_MAX = 100;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function isoDate(year: number, month: number, day: number): IsoDate {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Domingo de Páscoa (algoritmo gregoriano anônimo, Meeus/Jones/Butcher). */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

const FIXED_NATIONAL_HOLIDAYS: readonly { month: number; day: number; description: string }[] = [
  { month: 1, day: 1, description: 'Confraternização Universal' },
  { month: 4, day: 21, description: 'Tiradentes' },
  { month: 5, day: 1, description: 'Dia do Trabalho' },
  { month: 9, day: 7, description: 'Independência do Brasil' },
  { month: 10, day: 12, description: 'Nossa Senhora Aparecida' },
  { month: 11, day: 2, description: 'Finados' },
  { month: 11, day: 15, description: 'Proclamação da República' },
  { month: 11, day: 20, description: 'Dia Nacional de Zumbi e da Consciência Negra' },
  { month: 12, day: 25, description: 'Natal' },
];

/** Deslocamentos a partir do domingo de Páscoa. Carnaval e Corpus Christi entram (D-213 item 1). */
const EASTER_HOLIDAYS: readonly { offset: number; description: string }[] = [
  { offset: -48, description: 'Carnaval (segunda-feira)' },
  { offset: -47, description: 'Carnaval (terça-feira)' },
  { offset: -2, description: 'Sexta-feira Santa' },
  { offset: 60, description: 'Corpus Christi' },
];

/** Feriados nacionais do ano, em ordem de data. */
export function nationalHolidays(year: number): Holiday[] {
  const easter = easterSunday(year);
  const easterMs = Date.UTC(year, easter.month - 1, easter.day);
  const out: Holiday[] = FIXED_NATIONAL_HOLIDAYS.map((h) => ({
    id: null,
    date: isoDate(year, h.month, h.day),
    description: h.description,
    source: 'national',
  }));
  for (const h of EASTER_HOLIDAYS) {
    const date = new Date(easterMs + h.offset * 24 * 60 * 60 * 1000);
    out.push({
      id: null,
      date: isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()),
      description: h.description,
      source: 'national',
    });
  }
  return out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
}

/** `true` se `date` é feriado nacional ou está em `customDates`. */
export function isHoliday(date: IsoDate, customDates: ReadonlySet<IsoDate>): boolean {
  if (customDates.has(date)) return true;
  const year = Number(date.slice(0, 4));
  return nationalHolidays(year).some((h) => h.date === date);
}

// ---------------------------------------------------------------------------
// Relógio local do laboratório
// ---------------------------------------------------------------------------

const WEEKDAY_KEYS: Readonly<Record<string, WeekDay>> = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun',
};

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: WeekDay;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

function localParts(instant: Date, timezone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(timezone).formatToParts(instant)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAY_KEYS[parts.weekday ?? ''] ?? 'mon',
  };
}

/** Data local (`YYYY-MM-DD`) de `instant` no fuso do laboratório. */
export function localDateOf(instant: Date, timezone: string): IsoDate {
  const p = localParts(instant, timezone);
  return isoDate(p.year, p.month, p.day);
}

/**
 * Instante UTC da hora de parede `hh:mm` do dia local `year-month-day` em `timezone`.
 * Exportada para os minutos úteis do alerta de tempo de resposta (CRMLAB-84).
 */
export function zonedToUtc(year: number, month: number, day: number, hhmm: string, timezone: string): Date {
  const [hh, mm] = hhmm.split(':').map(Number);
  const wall = Date.UTC(year, month - 1, day, hh ?? 0, mm ?? 0);
  // Duas passadas acertam a diferença do fuso mesmo perto de uma troca de horário.
  let guess = wall;
  for (let i = 0; i < 2; i += 1) {
    const p = localParts(new Date(guess), timezone);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += wall - seen;
  }
  return new Date(guess);
}

/** Algum dia tem faixa de atendimento? Sem nenhum = sempre aberto (D-212 item 1). */
export function hasBusinessHours(hours: BusinessHours): boolean {
  return Object.values(hours.days).some((range) => range !== null && range !== undefined);
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Mais que uma semana sem nenhuma faixa só acontece sem faixa nenhuma, tratado antes. */
const OPENING_SEARCH_DAYS = 8;

/**
 * Primeiro instante `>= due` em que o laboratório está aberto (D-212 item 2).
 * Só olha o dia da semana: feriado é conferido à parte, e descarta.
 */
export function nextOpening(due: Date, hours: BusinessHours): Date {
  if (!hasBusinessHours(hours)) return due;
  const tz = hours.timezone;
  for (let offset = 0; offset < OPENING_SEARCH_DAYS; offset += 1) {
    const p = localParts(new Date(due.getTime() + offset * DAY_MS), tz);
    const range = hours.days[p.weekday];
    if (!range) continue;
    const start = zonedToUtc(p.year, p.month, p.day, range.start, tz);
    const end = zonedToUtc(p.year, p.month, p.day, range.end, tz);
    if (due.getTime() >= end.getTime()) continue;
    return due.getTime() > start.getTime() ? due : start;
  }
  return due;
}

// ---------------------------------------------------------------------------
// Decisão do reingajamento (D-212)
// ---------------------------------------------------------------------------

export type ReengagementStep = 'first' | 'second';

export type ReengagementOutcome = 'sent' | 'discarded' | 'failed';

/**
 * Por que foi descartado:
 * - `holiday`: a hora de sair cai num feriado (nacional ou do laboratório);
 * - `stale`: a hora de sair passou há mais de `REENGAGEMENT_STALE_GRACE_MS`
 *   (sistema fora do ar, regra recém-ligada, canal que voltou para QR).
 */
export type ReengagementDiscardReason = 'holiday' | 'stale';

/** Atraso máximo aceito entre a hora de sair e o tique que envia (D-212 item 4). */
export const REENGAGEMENT_STALE_GRACE_MS = 2 * 60 * 60 * 1000;

/** Até quantos dias antes do prazo o motor ainda olha um silêncio (D-212 item 5). */
export const REENGAGEMENT_LOOKBACK_DAYS = 8;

export interface ReengagementState {
  /** Última mensagem de pessoa do laboratório (CRM ou celular) — início do silêncio. */
  anchorAt: Date;
  /** O 1º deste silêncio, se já decidido. */
  first: { outcome: ReengagementOutcome; decidedAt: Date } | null;
  /** O 2º deste silêncio já foi decidido? */
  secondDecided: boolean;
}

export type ReengagementAction =
  | { kind: 'none' }
  | { kind: 'wait'; step: ReengagementStep; sendAt: Date }
  | { kind: 'send'; step: ReengagementStep }
  | { kind: 'discard'; step: ReengagementStep; reason: ReengagementDiscardReason };

const HOUR_MS = 60 * 60 * 1000;

function decideStep(
  step: ReengagementStep,
  due: Date,
  now: Date,
  hours: BusinessHours,
  customHolidays: ReadonlySet<IsoDate>,
): ReengagementAction {
  if (now.getTime() < due.getTime()) return { kind: 'wait', step, sendAt: due };
  const sendAt = nextOpening(due, hours);
  if (isHoliday(localDateOf(sendAt, hours.timezone), customHolidays)) {
    return { kind: 'discard', step, reason: 'holiday' };
  }
  if (now.getTime() < sendAt.getTime()) return { kind: 'wait', step, sendAt };
  if (now.getTime() - sendAt.getTime() > REENGAGEMENT_STALE_GRACE_MS) {
    return { kind: 'discard', step, reason: 'stale' };
  }
  return { kind: 'send', step };
}

/**
 * O que fazer com um silêncio agora. Quem chama já garantiu que a conversa
 * está ativa, é de WhatsApp por QR e o paciente não respondeu depois da
 * âncora. O 2º só existe depois de um 1º ENVIADO (D-211 item 4).
 */
export function planReengagement(
  state: ReengagementState,
  rules: ReengagementRules,
  now: Date,
  hours: BusinessHours,
  customHolidays: ReadonlySet<IsoDate>,
): ReengagementAction {
  if (state.first === null) {
    if (!rules.first.enabled) return { kind: 'none' };
    const due = new Date(state.anchorAt.getTime() + rules.first.hours * HOUR_MS);
    return decideStep('first', due, now, hours, customHolidays);
  }
  if (state.first.outcome !== 'sent' || state.secondDecided) return { kind: 'none' };
  if (!rules.first.enabled || !rules.second.enabled) return { kind: 'none' };
  const due = new Date(state.first.decidedAt.getTime() + rules.second.hours * HOUR_MS);
  return decideStep('second', due, now, hours, customHolidays);
}
