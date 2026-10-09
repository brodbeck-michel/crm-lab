/**
 * Mensagem fora do horário e boas-vindas (CRMLAB-94, D-264).
 *
 * PURO, sobre a mesma régua do reingajamento (D-212/D-213): `nextOpening`,
 * `isHoliday` e `localDateOf`. O `AutoReplyService` do backend decide com
 * `offHoursReopening`.
 */
import type { IsoDate } from './api.types.js';
import { hasBusinessHours, isHoliday, localDateOf, nextOpening, zonedToUtc } from './reengagement.types.js';
import type { BusinessHours } from './settings.types.js';

/** Tipo da resposta automática disparada pela mensagem do paciente. */
export type AutoReplyKind = 'offhours' | 'greeting';

/** Até quantos dias à frente se procura a reabertura (D-264 item 3). */
export const AUTO_REPLY_REOPENING_SEARCH_DAYS = 31;

/** Início (00:00 local) do dia seguinte a `date` no fuso do laboratório. */
function startOfNextDay(date: IsoDate, timezone: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  return zonedToUtc(year ?? 1970, month ?? 1, (day ?? 1) + 1, '00:00', timezone);
}

/**
 * Reabertura do laboratório: o primeiro instante `>= at` dentro do expediente
 * e fora de feriado (nacional ou de `customHolidays`). Identifica o PERÍODO
 * FECHADO — todas as mensagens da mesma noite têm a mesma reabertura.
 *
 * `null` = o laboratório está ABERTO em `at`, ou não tem nenhum dia de
 * expediente (sempre aberto, D-212 item 1 — inclusive em feriado), ou não
 * reabre em `AUTO_REPLY_REOPENING_SEARCH_DAYS` dias (não envia).
 */
export function offHoursReopening(
  at: Date,
  hours: BusinessHours,
  customHolidays: ReadonlySet<IsoDate>,
): Date | null {
  if (!hasBusinessHours(hours)) return null;
  const limit = at.getTime() + AUTO_REPLY_REOPENING_SEARCH_DAYS * 24 * 60 * 60 * 1000;
  let cursor = at;
  while (cursor.getTime() <= limit) {
    const opening = nextOpening(cursor, hours);
    const day = localDateOf(opening, hours.timezone);
    if (!isHoliday(day, customHolidays)) {
      return opening.getTime() === at.getTime() ? null : opening;
    }
    cursor = startOfNextDay(day, hours.timezone);
  }
  return null;
}
