/**
 * Alerta de tempo de resposta (CRMLAB-84, D-254). Espelha
 * docs/api/API_CONTRACTS.md §6c (regra `responseAlert`), §6e
 * (`GET /settings/business-calendar`) e §2 (`Conversation.awaitingReplySince`).
 *
 * Tudo aqui é PURO: a lista de conversas decide no navegador, com o relógio
 * local, sem recarregar. O tempo conta só no expediente do laboratório
 * (`tenant_settings.business_hours`) e pula os feriados — os nacionais de
 * `nationalHolidays` e os cadastrados, que chegam pelo calendário.
 */
import type { IsoDate, IsoDateTime } from './api.types.js';
import type { ConversationStatus } from './conversation.types.js';
import type { ResponseAlertRules } from './funnel-rules.types.js';
import { hasBusinessHours, isHoliday, localDateOf, zonedToUtc } from './reengagement.types.js';
import type { BusinessHours, WeekDay } from './settings.types.js';

export const RESPONSE_ALERT_MINUTES_MIN = 1;
export const RESPONSE_ALERT_MINUTES_MAX = 1440;

/**
 * Até quantos dias para trás o relógio olha (D-254 item 4). Espera mais antiga
 * conta só os últimos 14 dias — já passa de qualquer limite (1440 min úteis
 * cabem em 14 dias com 4 h de expediente por dia útil) e mantém o cálculo
 * barato num tique a cada 30 s. É também a janela dos feriados do calendário.
 */
export const BUSINESS_CALENDAR_LOOKBACK_DAYS = 14;

/**
 * `GET /settings/business-calendar` — o que o navegador precisa para contar
 * minutos úteis. Lido por QUALQUER perfil de laboratório (a atendente não lê
 * `/settings/channels`).
 */
export interface BusinessCalendarResponse {
  businessHours: BusinessHours;
  /** Feriados cadastrados de `from` a `to` (inclusive). Os nacionais não vêm: são calculados. */
  customHolidays: IsoDate[];
  from: IsoDate;
  to: IsoDate;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const WEEKDAY_BY_UTC_DAY: readonly WeekDay[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** Trava de segurança do laço de dias (a janela real é limitada por quem chama). */
const MAX_DAYS = 400;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Minutos inteiros de expediente entre `from` e `to`. Dia de feriado (nacional
 * ou em `customHolidays`) não conta; dia sem faixa, também. Laboratório sem
 * nenhum dia configurado é "sempre aberto" (D-212 item 1): conta o dia inteiro,
 * menos os feriados.
 */
export function businessMinutesBetween(
  from: Date,
  to: Date,
  hours: BusinessHours,
  customHolidays: ReadonlySet<IsoDate>,
): number {
  if (!(to.getTime() > from.getTime())) return 0;
  const tz = hours.timezone;
  const alwaysOpen = !hasBusinessHours(hours);
  const lastDate = localDateOf(to, tz);
  const [y, m, d] = localDateOf(from, tz).split('-').map(Number);
  let total = 0;

  for (let offset = 0; offset < MAX_DAYS; offset += 1) {
    // Aritmética de calendário em UTC: só o dia local importa aqui, sem fuso.
    const cal = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + offset));
    const year = cal.getUTCFullYear();
    const month = cal.getUTCMonth() + 1;
    const day = cal.getUTCDate();
    const date = `${year}-${pad2(month)}-${pad2(day)}`;
    if (date > lastDate) break;
    if (isHoliday(date, customHolidays)) continue;

    let start: Date;
    let end: Date;
    if (alwaysOpen) {
      start = zonedToUtc(year, month, day, '00:00', tz);
      const next = new Date(cal.getTime() + DAY_MS);
      end = zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), '00:00', tz);
    } else {
      const range = hours.days[WEEKDAY_BY_UTC_DAY[cal.getUTCDay()] ?? 'mon'];
      if (!range) continue;
      start = zonedToUtc(year, month, day, range.start, tz);
      end = zonedToUtc(year, month, day, range.end, tz);
    }
    const s = Math.max(start.getTime(), from.getTime());
    const e = Math.min(end.getTime(), to.getTime());
    if (e > s) total += e - s;
  }
  return Math.floor(total / MINUTE_MS);
}

/** O recorte da conversa que o alerta olha. */
export interface ResponseAlertConversation {
  status: ConversationStatus;
  /** Ausente = backend antigo; trata como "não está esperando". */
  awaitingReplySince?: IsoDateTime | null;
}

/** Calendário já pronto para o cálculo (feriados num `Set`). */
export interface ResponseAlertCalendar {
  businessHours: BusinessHours;
  customHolidays: ReadonlySet<IsoDate>;
}

/**
 * Minutos úteis de espera quando a conversa está EM ALERTA; `null` quando não
 * está (regra desligada, encerrada, sem espera ou abaixo do limite). Entra com
 * `minutos >= rule.minutes`.
 */
export function responseAlertMinutes(
  conversation: ResponseAlertConversation,
  rule: ResponseAlertRules,
  calendar: ResponseAlertCalendar,
  now: Date,
): number | null {
  if (!rule.enabled || conversation.status !== 'active') return null;
  const raw = conversation.awaitingReplySince;
  if (raw === undefined || raw === null) return null;
  const since = new Date(raw);
  if (Number.isNaN(since.getTime())) return null;
  const floor = now.getTime() - BUSINESS_CALENDAR_LOOKBACK_DAYS * DAY_MS;
  const from = new Date(Math.max(since.getTime(), floor));
  const minutes = businessMinutesBetween(from, now, calendar.businessHours, calendar.customHolidays);
  return minutes >= rule.minutes ? minutes : null;
}
