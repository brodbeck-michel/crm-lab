import { VISIT_TYPE_LABELS, type Visit } from '@crm-lab/shared';
import { cn } from '@/components/ui';
import { formatDayLabel, formatTime, sameDay } from './agenda-dates';
import { PersonAvatar, StatusBadge, visitPlace } from './agenda-ui';

interface AgendaListProps {
  days: Date[];
  now: Date;
  /** Já filtradas. */
  visits: Visit[];
  selectedId: string | null;
  onOpen: (visit: Visit) => void;
}

/**
 * Visão Lista (CRMLAB-92, D-262): um grupo por dia (cabeçalho fixo ao rolar),
 * linha em colunas Horário · Médico · Local · Responsável · Status. Dias sem
 * visita ficam de fora; a lista vazia é tratada por quem chama.
 */
export function AgendaList({ days, now, visits, selectedId, onOpen }: AgendaListProps) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-auto rounded-lg border border-agenda-line bg-bg"
      data-testid="agenda-list"
    >
      {days.map((day) => {
        const ofDay = visits.filter((visit) => sameDay(new Date(visit.scheduledAt), day));
        if (ofDay.length === 0) return null;
        const today = sameDay(day, now);
        return (
          <section key={day.toISOString()} aria-label={formatDayLabel(day)}>
            <h2 className="sticky top-0 z-10 flex items-baseline gap-sm border-b border-agenda-line bg-agenda-alt px-lg py-[10px]">
              <span
                className={cn('text-body font-bold', today ? 'text-accent' : 'text-agenda-ink')}
              >
                {formatDayLabel(day)}
                {today ? ' · Hoje' : ''}
              </span>
              <span className="text-caption text-agenda-muted-2">
                {ofDay.length === 1 ? '1 visita' : `${ofDay.length} visitas`}
              </span>
            </h2>
            <ul>
              {ofDay.map((visit) => (
                <li key={visit.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(visit)}
                    aria-pressed={visit.id === selectedId}
                    className={cn(
                      'grid w-full grid-cols-1 items-center gap-xs border-b border-agenda-line-soft px-lg py-md text-left',
                      'md:grid-cols-[110px_1.4fr_1fr_1fr_140px] md:gap-lg',
                      'hover:bg-agenda-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
                      visit.id === selectedId && 'bg-agenda-selected hover:bg-agenda-selected',
                    )}
                  >
                    <span className="text-[14px] font-semibold tabular-nums text-agenda-ink">
                      {formatTime(visit.scheduledAt)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] font-semibold text-agenda-ink">
                        {visit.doctor.name}
                      </span>
                      {visit.doctor.specialty && (
                        <span className="block truncate text-body text-agenda-muted">
                          {visit.doctor.specialty}
                        </span>
                      )}
                    </span>
                    <span className="truncate text-body text-agenda-ink-2">
                      {visitPlace(visit, VISIT_TYPE_LABELS[visit.type])}
                    </span>
                    <span className="flex min-w-0 items-center gap-sm text-body text-agenda-ink-2">
                      <PersonAvatar person={visit.responsible} size={22} />
                      <span className="truncate">{visit.responsible?.name ?? '—'}</span>
                    </span>
                    <span>
                      <StatusBadge status={visit.status} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
