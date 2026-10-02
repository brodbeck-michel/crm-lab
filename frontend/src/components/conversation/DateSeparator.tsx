/**
 * Pílula de dia entre mensagens de dias diferentes — CRMLAB-71, D-239.
 *
 * Tudo no fuso do NAVEGADOR (o fio é ISO UTC) e por dia de CALENDÁRIO, não
 * por 24h: 23h59 e 00h01 são dias diferentes, como no WhatsApp Web.
 */

const WEEKDAYS = [
  'Domingo',
  'Segunda-feira',
  'Terça-feira',
  'Quarta-feira',
  'Quinta-feira',
  'Sexta-feira',
  'Sábado',
] as const;

/** Meia-noite local do dia de `date`. */
function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** `true` quando os dois instantes caem no mesmo dia de calendário local. */
export function isSameLocalDay(a: Date, b: Date): boolean {
  return startOfLocalDay(a).getTime() === startOfLocalDay(b).getTime();
}

/**
 * "Hoje", "Ontem", dia da semana de 2 a 6 dias atrás e `dd/mm/aaaa` daí para
 * trás — 7 dias atrás é o mesmo dia da semana de hoje, e o nome seria ambíguo.
 * Data futura (relógio adiantado) também vira `dd/mm/aaaa`.
 */
export function dateSeparatorLabel(date: Date, now: Date): string {
  // `Math.round` absorve o dia de 23h/25h da troca de horário de verão.
  const days = Math.round(
    (startOfLocalDay(now).getTime() - startOfLocalDay(date).getTime()) / 86_400_000,
  );
  if (days === 0) return 'Hoje';
  if (days === 1) return 'Ontem';
  if (days >= 2 && days <= 6) return WEEKDAYS[date.getDay()] ?? '';

  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${date.getFullYear()}`;
}

export interface DateSeparatorProps {
  /** ISO 8601 (UTC no fio) da primeira mensagem do dia. */
  date: string;
  /** Injetável para teste determinístico. */
  now?: Date;
}

export function DateSeparator({ date, now = new Date() }: DateSeparatorProps) {
  const label = dateSeparatorLabel(new Date(date), now);

  return (
    <div
      role="separator"
      aria-label={label}
      data-testid="date-separator"
      className="flex flex-[0_0_auto] justify-center py-xs"
    >
      <span className="rounded-pill border border-neutral-200 bg-surface px-md py-xs font-body text-caption text-neutral-700 shadow-sm">
        {label}
      </span>
    </div>
  );
}
