import { VISIT_STATUS_LABELS, VISIT_TYPE_LABELS, type Visit } from '@crm-lab/shared';
import { cn } from '@/components/ui';
import { formatDayLabel, formatTime, formatWeekday, sameDay, weekMonths } from './agenda-dates';
import { PersonAvatar, STATUS_STYLES, StatusDot, isStruck, visitPlace } from './agenda-ui';

interface AgendaMobileProps {
  weekStart: Date;
  days: Date[];
  now: Date;
  selectedDay: Date;
  /** Já filtradas. */
  visits: Visit[];
  activeFilters: number;
  onSelectDay: (day: Date) => void;
  onPrevWeek: () => void;
  onNextWeek: () => void;
  onOpenFilters: () => void;
  onNew: () => void;
  onOpen: (visit: Visit) => void;
}

/**
 * Celular (< 768px, CRMLAB-92, D-262): foco no DIA. Faixa da semana com
 * ponto nos dias que têm visita, título do dia e a lista daquele dia. Tocar
 * abre a visita completa (modal em tela cheia).
 */
export function AgendaMobile(props: AgendaMobileProps) {
  const { weekStart, days, now, selectedDay, visits, activeFilters } = props;
  const ofDay = visits.filter((visit) => sameDay(new Date(visit.scheduledAt), selectedDay));

  return (
    <div className="flex flex-col bg-bg" data-testid="agenda-mobile">
      <header className="flex items-end justify-between gap-md border-b border-agenda-line px-[20px] pb-md pt-[18px]">
        <div>
          <p className="text-caption text-agenda-muted">{weekMonths(weekStart)}</p>
          <h1 className="text-[22px] font-bold leading-tight text-agenda-ink">Agenda</h1>
        </div>
        <div className="flex items-center gap-sm">
          <button
            type="button"
            onClick={props.onOpenFilters}
            aria-label={activeFilters > 0 ? `Filtros (${activeFilters} ativos)` : 'Filtros'}
            className="relative inline-flex h-11 w-11 items-center justify-center rounded-md border border-agenda-line-control text-agenda-ink-2"
          >
            <svg
              viewBox="0 0 20 20"
              width="20"
              height="20"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            >
              <path d="M3 5h14M6 10h8M8.5 15h3" strokeLinecap="round" />
            </svg>
            {activeFilters > 0 && (
              <span className="absolute -right-1 -top-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-pill bg-accent px-[4px] text-[11px] font-bold text-bg">
                {activeFilters}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={props.onNew}
            aria-label="Nova visita"
            className="inline-flex h-11 w-11 items-center justify-center rounded-md bg-accent text-[22px] leading-none text-bg"
          >
            +
          </button>
        </div>
      </header>

      <div className="flex items-center gap-xs px-sm pt-md">
        <button
          type="button"
          aria-label="Semana anterior"
          onClick={props.onPrevWeek}
          className="h-11 w-6 shrink-0 text-[18px] text-agenda-ink-2"
        >
          ‹
        </button>
        <div className="grid flex-1 grid-cols-7 gap-xs" role="tablist" aria-label="Dias da semana">
          {days.map((day) => {
            const selected = sameDay(day, selectedDay);
            const today = sameDay(day, now);
            const has = visits.some((visit) => sameDay(new Date(visit.scheduledAt), day));
            return (
              <button
                key={day.toISOString()}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-label={`${formatDayLabel(day)}${has ? ', com visitas' : ''}`}
                onClick={() => props.onSelectDay(day)}
                className={cn(
                  'flex min-h-[60px] flex-col items-center justify-center gap-[2px] rounded-lg',
                  selected
                    ? 'bg-accent text-bg'
                    : today
                      ? 'bg-agenda-brand-tint text-accent'
                      : 'text-agenda-ink',
                )}
              >
                <span className="text-[10px] font-bold uppercase">{formatWeekday(day)}</span>
                <span className="text-[17px] font-bold tabular-nums leading-none">
                  {String(day.getDate()).padStart(2, '0')}
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    'h-[5px] w-[5px] rounded-pill',
                    has ? (selected ? 'bg-bg' : 'bg-accent') : 'bg-transparent',
                  )}
                />
              </button>
            );
          })}
        </div>
        <button
          type="button"
          aria-label="Próxima semana"
          onClick={props.onNextWeek}
          className="h-11 w-6 shrink-0 text-[18px] text-agenda-ink-2"
        >
          ›
        </button>
      </div>

      <div className="flex items-baseline gap-sm px-[20px] pb-sm pt-lg">
        <h2 className="text-[16px] font-bold text-agenda-ink">{formatDayLabel(selectedDay)}</h2>
        <span className="text-body text-agenda-muted">
          {ofDay.length === 1 ? '1 visita' : `${ofDay.length} visitas`}
        </span>
      </div>

      {ofDay.length === 0 ? (
        <p className="px-[20px] py-xl text-center text-[14px] text-agenda-muted">
          Nenhuma visita neste dia.
        </p>
      ) : (
        <ul
          className="flex flex-col gap-[10px] px-[20px] pb-[20px] pt-xs"
          data-testid="agenda-day-list"
        >
          {ofDay.map((visit) => (
            <li key={visit.id} className="flex gap-md">
              <span className="flex w-[46px] shrink-0 flex-col pt-md tabular-nums">
                <span className="text-[14px] font-bold text-agenda-ink">
                  {formatTime(visit.scheduledAt)}
                </span>
                {visit.checkOutAt && (
                  <span className="text-caption text-agenda-muted-2">
                    {formatTime(visit.checkOutAt)}
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => props.onOpen(visit)}
                aria-label={`${formatTime(visit.scheduledAt)} ${visit.doctor.name} — ${VISIT_STATUS_LABELS[visit.status]}`}
                className={cn(
                  'flex min-w-0 flex-1 flex-col gap-[3px] rounded-lg px-[14px] py-md text-left',
                  STATUS_STYLES[visit.status].bg,
                  STATUS_STYLES[visit.status].ink,
                )}
              >
                <span className="flex items-center gap-[6px] text-[11px] font-bold uppercase tracking-[0.06em]">
                  <StatusDot status={visit.status} />
                  {VISIT_STATUS_LABELS[visit.status]}
                </span>
                <span
                  className={cn(
                    'truncate text-[15px] font-bold',
                    isStruck(visit.status) && 'line-through',
                  )}
                >
                  {visit.doctor.name}
                </span>
                <span className="truncate text-body">
                  {[visit.doctor.specialty, visitPlace(visit, VISIT_TYPE_LABELS[visit.type])]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <span className="flex items-center gap-[6px] text-caption">
                  <PersonAvatar person={visit.responsible} size={20} />
                  <span className="truncate">{visit.responsible?.name ?? '—'}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
