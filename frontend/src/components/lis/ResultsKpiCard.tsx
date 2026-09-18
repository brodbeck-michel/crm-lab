import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

export type ResultsKpiIcon = 'wallet' | 'money' | 'trend' | 'people';

const ICON_PATH: Record<ResultsKpiIcon, string> = {
  wallet: 'M3 7h15a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7zM16 12h3',
  money: 'M12 3v18M8 7.5h5.5a2.5 2.5 0 010 5H9a2.5 2.5 0 000 5h6',
  trend: 'M4 17l5-5 4 4 7-8M16 8h4v4',
  people: 'M8 11a3 3 0 100-6 3 3 0 000 6zM2 20c0-3 3-5 6-5s6 2 6 5M17 11a3 3 0 100-6M16 15c3 0 6 2 6 5',
};

function Icon({ name, tone }: { name: ResultsKpiIcon; tone: 'onDark' | 'onLight' }) {
  return (
    <span
      className={cn(
        'inline-flex h-8 w-8 flex-none items-center justify-center rounded-md',
        tone === 'onDark' ? 'bg-accent2-700 text-bg' : 'bg-accent2-200 text-accent2-800',
      )}
    >
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d={ICON_PATH[name]} />
      </svg>
    </span>
  );
}

export interface ResultsKpiCardProps {
  icon: ResultsKpiIcon;
  label: string;
  value: ReactNode;
  caption?: ReactNode;
  /** Variação vs. período anterior, em pontos percentuais. Só o 1º cartão usa. */
  deltaPct?: number;
  /** O que o `deltaPct` compara — ex.: "vs. período anterior". */
  deltaLabel?: string;
  /** Destaque visual (fundo escuro) — reservado ao cartão âncora "Total Orçado". */
  highlight?: boolean;
  /** Barra de progresso 0-100 (cartão "Recebido" — taxa de conversão). */
  progress?: number;
  progressLabel?: string;
}

/**
 * Cartão de KPI da tela `/results` (PAGES.md §14).
 *
 * O número é o herói da tela: fica em `text-metric` (30px), maior que o próprio
 * título da página (21px em `size="compact"`). O rótulo vem em caixa normal —
 * caixa alta espaçada custa legibilidade e não acrescenta hierarquia nenhuma
 * quando o valor já é três vezes maior.
 *
 * Distinto do `KpiCard` genérico (usado em Busca Ativa): aqui cada cartão tem
 * forma própria (destaque, variação, barra de progresso), não uma grade uniforme.
 */
export function ResultsKpiCard({
  icon,
  label,
  value,
  caption,
  deltaPct,
  deltaLabel,
  highlight = false,
  progress,
  progressLabel,
}: ResultsKpiCardProps) {
  return (
    <div
      className={cn(
        'flex h-full flex-col gap-md rounded-lg p-lg',
        highlight
          ? 'bg-accent2-800 text-bg shadow-md'
          : 'bg-neutral-100 border border-neutral-200 shadow-sm',
      )}
    >
      <div className="flex items-start justify-between gap-sm">
        <div className="flex min-w-0 items-center gap-sm">
          <Icon name={icon} tone={highlight ? 'onDark' : 'onLight'} />
          <p
            className={cn(
              'font-body text-caption font-semibold',
              highlight ? 'text-bg' : 'text-neutral-700',
            )}
          >
            {label}
          </p>
        </div>

        {deltaPct !== undefined && (
          <span
            title={deltaLabel}
            className={cn(
              'inline-flex flex-none items-center gap-xs rounded-pill px-sm py-xs font-body text-caption font-semibold',
              highlight
                ? 'bg-accent2-700 text-bg'
                : deltaPct < 0
                  ? 'bg-accent-200 text-accent-800'
                  : 'bg-accent2-200 text-accent2-800',
            )}
          >
            <span aria-hidden="true">{deltaPct >= 0 ? '↑' : '↓'}</span>
            {Math.abs(deltaPct).toFixed(1)}%
          </span>
        )}
      </div>

      <div className="mt-auto">
        <p className="font-heading text-metric">{value}</p>
        {caption && (
          <p
            className={cn(
              'mt-xs font-body text-caption',
              highlight ? 'text-bg' : 'text-neutral-600',
            )}
          >
            {caption}
          </p>
        )}
        {deltaPct !== undefined && deltaLabel && (
          <p
            className={cn(
              'mt-xs font-body text-caption',
              highlight ? 'text-bg' : 'text-neutral-600',
            )}
          >
            {deltaLabel}
          </p>
        )}
      </div>

      {progress !== undefined && (
        <div>
          {progressLabel && (
            <div
              className={cn(
                'mb-xs flex justify-between font-body text-caption',
                highlight ? 'text-bg' : 'text-neutral-600',
              )}
            >
              <span>{progressLabel}</span>
              <span className="font-semibold tabular-nums">{progress.toFixed(1)}%</span>
            </div>
          )}
          <div className="h-[6px] w-full overflow-hidden rounded-pill bg-neutral-200">
            <div
              className="h-full rounded-pill bg-accent2"
              style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
