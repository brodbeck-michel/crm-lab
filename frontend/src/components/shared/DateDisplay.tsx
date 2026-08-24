import { formatDateTime, formatRelativeDate } from '@/lib/format';

export interface DateDisplayProps {
  /** Data ISO 8601 UTC vinda da API. */
  value: string;
  /**
   * `relative` ("há 4 min") em LISTAS · `absolute` (23/08/2026 14:30) em DETALHES.
   * Padrão `relative`.
   */
  variant?: 'relative' | 'absolute';
}

/**
 * Data formatada em pt-BR via lib/format. No modo relativo o valor absoluto
 * fica no `title`, para que o usuário possa conferir a data exata no hover.
 */
export function DateDisplay({ value, variant = 'relative' }: DateDisplayProps) {
  const absolute = formatDateTime(value);

  return (
    <time
      dateTime={value}
      title={variant === 'relative' ? absolute : undefined}
      data-variant={variant}
      className="whitespace-nowrap font-body"
    >
      {variant === 'relative' ? formatRelativeDate(value) : absolute}
    </time>
  );
}
