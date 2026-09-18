import { Button, Input } from '@/components/ui';

export interface Period {
  startDate: string;
  endDate: string;
}

export interface PeriodFilterProps {
  value: Period;
  onChange: (period: Period) => void;
}

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function firstDayOfMonthIso(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
}

const SHORTCUTS: Array<{ label: string; period: () => Period }> = [
  { label: 'Hoje', period: () => ({ startDate: todayIso(), endDate: todayIso() }) },
  { label: '7 dias', period: () => ({ startDate: isoDaysAgo(6), endDate: todayIso() }) },
  { label: '30 dias', period: () => ({ startDate: isoDaysAgo(29), endDate: todayIso() }) },
  { label: 'Mês atual', period: () => ({ startDate: firstDayOfMonthIso(), endDate: todayIso() }) },
];

function samePeriod(a: Period, b: Period): boolean {
  return a.startDate === b.startDate && a.endDate === b.endDate;
}

/**
 * `PeriodFilter` (`docs/frontend/COMPONENTS.md`) — atalhos comuns + intervalo
 * livre, em UMA linha. O atalho que corresponde ao período em vigor fica
 * `primary`: antes, quem chegava na tela não tinha como saber se estava vendo
 * 7 ou 30 dias sem ler as duas datas. Os campos de data são pílulas curtas com
 * o rótulo DENTRO (`prefix`) — rótulo em cima somava uma linha inteira de
 * altura à barra de filtro de todas as telas do LIS.
 *
 * `endDate < startDate` avisa inline, sem round-trip ao servidor. Usado em
 * `/results`, `/reconciliation`, `/active-search` (valor compartilhado via
 * `useUIStore.lisFilters`, D-117) e `/sales` (período próprio da tela).
 */
export function PeriodFilter({ value, onChange }: PeriodFilterProps) {
  const invalid = value.endDate < value.startDate;

  return (
    <div className="flex flex-wrap items-center gap-md">
      <div className="flex flex-wrap items-center gap-xs">
        {SHORTCUTS.map((shortcut) => {
          const active = samePeriod(value, shortcut.period());
          return (
            <Button
              key={shortcut.label}
              variant={active ? 'primary' : 'secondary'}
              size="sm"
              aria-pressed={active}
              onClick={() => onChange(shortcut.period())}
            >
              {shortcut.label}
            </Button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-sm">
        <div className="w-[164px]">
          <Input
            type="date"
            value={value.startDate}
            onChange={(e) => onChange({ ...value, startDate: e.target.value })}
            aria-label="Data inicial"
            prefix={<span className="font-body text-caption text-neutral-700">De</span>}
          />
        </div>
        <div className="w-[164px]">
          <Input
            type="date"
            value={value.endDate}
            onChange={(e) => onChange({ ...value, endDate: e.target.value })}
            aria-label="Data final"
            prefix={<span className="font-body text-caption text-neutral-700">até</span>}
          />
        </div>
      </div>

      {invalid && (
        <p role="alert" className="font-body text-caption text-accent-700">
          Data final anterior à inicial.
        </p>
      )}
    </div>
  );
}

/**
 * Período imediatamente anterior, de MESMA duração — base do `deltaPct` do
 * cartão "Total Orçado" de `/results` (PAGES.md §14). Calculado no CLIENTE,
 * sem endpoint novo: um segundo fetch de `/lis-budgets/summary` com este
 * período resolve o "vs. período anterior".
 */
export function previousPeriod(period: Period): Period {
  const start = new Date(`${period.startDate}T00:00:00Z`);
  const end = new Date(`${period.endDate}T00:00:00Z`);
  const durationDays = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;

  const previousEnd = new Date(start);
  previousEnd.setUTCDate(previousEnd.getUTCDate() - 1);
  const previousStart = new Date(previousEnd);
  previousStart.setUTCDate(previousStart.getUTCDate() - (durationDays - 1));

  return {
    startDate: previousStart.toISOString().slice(0, 10),
    endDate: previousEnd.toISOString().slice(0, 10),
  };
}

/** Período padrão: últimos 30 dias terminando hoje (mesmo default do servidor). */
export function defaultPeriod(): Period {
  return { startDate: isoDaysAgo(29), endDate: todayIso() };
}
