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
        'inline-flex h-9 w-9 items-center justify-center rounded-md',
        tone === 'onDark' ? 'bg-accent2-700 text-bg' : 'bg-accent2-200 text-accent2-800',
      )}
    >
      <svg
        width="18"
        height="18"
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
  /** Destaque visual (fundo escuro) — reservado ao cartão âncora "Total Orçado". */
  highlight?: boolean;
  /** Barra de progresso 0-100 (cartão "Recebido" — taxa de conversão). */
  progress?: number;
  progressLabel?: string;
}

/**
 * Cartão de KPI da tela `/results` (PAGES.md §14) — layout rico com ícone,
 * variação e legenda, fiel à referência visual real do produto. Distinto do
 * `KpiCard` genérico (usado em Busca Ativa): aqui cada cartão tem forma
 * própria (destaque, barra de progresso), não uma grade uniforme.
 */
export function ResultsKpiCard({
  icon,
  label,
  value,
  caption,
  deltaPct,
  highlight = false,
  progress,
  progressLabel,
}: ResultsKpiCardProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-md rounded-md p-lg shadow-sm',
        highlight ? 'bg-accent2-800 text-bg' : 'bg-neutral-100 border border-neutral-200',
      )}
    >
      <div className="flex items-center justify-between">
        <Icon name={icon} tone={highlight ? 'onDark' : 'onLight'} />
        {deltaPct !== undefined && (
          <span
            className={cn(
              'font-body text-caption font-semibold',
              highlight ? 'text-bg' : deltaPct < 0 ? 'text-accent-700' : 'text-accent2-700',
            )}
          >
            {deltaPct >= 0 ? '↗' : '↘'} {Math.abs(deltaPct).toFixed(1)}%
          </span>
        )}
      </div>

      <div>
        <p
          className={cn(
            'font-body text-micro font-semibold uppercase',
            highlight ? 'text-bg' : 'text-neutral-600',
          )}
        >
          {label}
        </p>
        <p className="font-heading text-section mt-xs">{value}</p>
        {caption && (
          <p className={cn('font-body text-caption mt-xs', highlight ? 'text-bg' : 'text-neutral-600')}>
            {caption}
          </p>
        )}
      </div>

      {progress !== undefined && (
        <div>
          {progressLabel && (
            <div className="flex justify-between font-body text-micro font-semibold uppercase text-neutral-600 mb-xs">
              <span>{progressLabel}</span>
              <span>{progress.toFixed(1)}%</span>
            </div>
          )}
          <div className="h-[6px] w-full rounded-pill bg-neutral-200 overflow-hidden">
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
