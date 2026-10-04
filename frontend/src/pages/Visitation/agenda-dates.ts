/**
 * Datas da Agenda de visitas (CRMLAB-87, D-256). Tudo no fuso do NAVEGADOR:
 * a semana começa na segunda 00:00 local; o fio continua em ISO UTC.
 */

export const WEEK_DAYS = 7;
/** Faixa de horas da grade da semana; visita fora dela cai na primeira/última linha. */
export const FIRST_HOUR = 7;
export const LAST_HOUR = 20;

/** Segunda-feira 00:00 (local) da semana de `date`. */
export function startOfWeek(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = (start.getDay() + 6) % 7; // domingo = 6
  start.setDate(start.getDate() - offset);
  return start;
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function weekDays(weekStart: Date): Date[] {
  return Array.from({ length: WEEK_DAYS }, (_, i) => addDays(weekStart, i));
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Linha da grade para o horário (presa entre `FIRST_HOUR` e `LAST_HOUR`). */
export function gridHour(date: Date): number {
  return Math.min(Math.max(date.getHours(), FIRST_HOUR), LAST_HOUR);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `YYYY-MM-DD` local — valor do `<input type="date">`. */
export function toDateInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `HH:mm` local — valor do `<input type="time">`. */
export function toTimeInput(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Data + hora digitadas (local) → ISO UTC. `null` se faltar algo ou for inválido. */
export function fromDateTimeInputs(day: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const date = new Date(`${day}T${time}:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const dayMonth = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' });
const weekday = new Intl.DateTimeFormat('pt-BR', { weekday: 'short' });
const fullDay = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
  day: '2-digit',
  month: 'long',
});
const weekdayLong = new Intl.DateTimeFormat('pt-BR', { weekday: 'long' });
const time = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dateTime = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const MONTHS = [
  'jan.',
  'fev.',
  'mar.',
  'abr.',
  'mai.',
  'jun.',
  'jul.',
  'ago.',
  'set.',
  'out.',
  'nov.',
  'dez.',
];

/** "05 – 11 de out. 2026" (ou cruzando mês: "28 set. – 04 out. 2026"). */
export function weekLabel(weekStart: Date): string {
  const end = addDays(weekStart, WEEK_DAYS - 1);
  const endLabel = `${pad(end.getDate())} ${MONTHS[end.getMonth()]} ${end.getFullYear()}`;
  if (weekStart.getMonth() === end.getMonth())
    return `${pad(weekStart.getDate())} – ${pad(end.getDate())} de ${MONTHS[end.getMonth()]} ${end.getFullYear()}`;
  return `${pad(weekStart.getDate())} ${MONTHS[weekStart.getMonth()]} – ${endLabel}`;
}

/** "Quinta, 01 de out." — cabeçalho de dia da lista, do painel e do celular. */
export function formatDayLabel(date: Date): string {
  const name = weekdayLong.format(date).replace('-feira', '');
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}, ${pad(date.getDate())} de ${MONTHS[date.getMonth()]}`;
}

/** "out." / "set. – out." — meses da semana (cabeçalho do celular). */
export function weekMonths(weekStart: Date): string {
  const end = addDays(weekStart, WEEK_DAYS - 1);
  const first = MONTHS[weekStart.getMonth()] ?? '';
  return weekStart.getMonth() === end.getMonth()
    ? `${first} ${end.getFullYear()}`
    : `${first} – ${MONTHS[end.getMonth()]} ${end.getFullYear()}`;
}

export function formatWeekday(date: Date): string {
  return weekday.format(date).replace('.', '');
}

export function formatDayMonth(date: Date): string {
  return dayMonth.format(date);
}

export function formatFullDay(date: Date): string {
  return fullDay.format(date);
}

export function formatTime(iso: string | Date): string {
  return time.format(typeof iso === 'string' ? new Date(iso) : iso);
}

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

export function formatHour(hour: number): string {
  return `${pad(hour)}:00`;
}

/** Minutos desde a meia-noite (local) — posição vertical na grade. */
export function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}
