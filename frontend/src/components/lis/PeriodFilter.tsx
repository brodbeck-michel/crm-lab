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

/**
 * `PeriodFilter` (`docs/frontend/COMPONENTS.md`) — atalhos comuns + intervalo
 * livre. `endDate < startDate` desabilita [Aplicar] sem round-trip ao
 * servidor. Usado em `/results`, `/reconciliation`, `/active-search` (valor
 * compartilhado via `useUIStore.lisFilters`, D-117) e `/sales` (período
 * próprio da tela).
 */
export function PeriodFilter({ value, onChange }: PeriodFilterProps) {
  const invalid = value.endDate < value.startDate;

  return (
    <div className="flex flex-wrap items-end gap-md">
      <div className="flex flex-wrap gap-sm">
        {SHORTCUTS.map((shortcut) => (
          <Button
            key={shortcut.label}
            variant="secondary"
            size="sm"
            onClick={() => onChange(shortcut.period())}
          >
            {shortcut.label}
          </Button>
        ))}
      </div>
      <Input
        type="date"
        label="De"
        value={value.startDate}
        onChange={(e) => onChange({ ...value, startDate: e.target.value })}
        aria-label="Data inicial"
      />
      <Input
        type="date"
        label="Até"
        value={value.endDate}
        onChange={(e) => onChange({ ...value, endDate: e.target.value })}
        aria-label="Data final"
      />
      {invalid && (
        <p role="alert" className="font-body text-caption text-accent-700">
          Data final anterior à inicial.
        </p>
      )}
    </div>
  );
}

/** Período padrão: últimos 30 dias terminando hoje (mesmo default do servidor). */
export function defaultPeriod(): Period {
  return { startDate: isoDaysAgo(29), endDate: todayIso() };
}
