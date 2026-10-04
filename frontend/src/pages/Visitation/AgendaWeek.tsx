import type { Visit } from '@crm-lab/shared';
import { VISIT_STATUS_LABELS } from '@crm-lab/shared';
import { cn } from '@/components/ui';
import {
  FIRST_HOUR,
  formatDayLabel,
  formatHour,
  formatTime,
  formatWeekday,
  minutesOfDay,
  sameDay,
} from './agenda-dates';
import {
  BLOCK_MINUTES,
  GRID_HEIGHT,
  GRID_ROWS,
  HOUR_PX,
  PersonAvatar,
  STATUS_STYLES,
  StatusDot,
  isStruck,
  placeVisits,
} from './agenda-ui';

const HOURS = Array.from({ length: GRID_ROWS }, (_, i) => FIRST_HOUR + i);
const COLUMNS = 'grid-cols-[56px_repeat(7,minmax(0,1fr))]';

interface AgendaWeekProps {
  days: Date[];
  now: Date;
  /** Já filtradas. */
  visits: Visit[];
  selectedId: string | null;
  /** Semana sem visita nenhuma (antes dos filtros) × filtros esconderam tudo. */
  emptyState: 'none' | 'week' | 'filtered';
  onOpen: (visit: Visit) => void;
  onSlot: (at: Date) => void;
  onClearFilters: () => void;
}

/**
 * Grade semanal (CRMLAB-92, D-262): eixo 07–20h, 1 h = 64px, blocos com
 * posição absoluta pela hora de início e altura fixa de 1 h (a visita não tem
 * duração prevista). Clicar no vazio agenda naquela hora/meia hora; o "+" de
 * cada hora faz o mesmo pelo teclado.
 */
export function AgendaWeek({
  days,
  now,
  visits,
  selectedId,
  emptyState,
  onOpen,
  onSlot,
  onClearFilters,
}: AgendaWeekProps) {
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col overflow-auto rounded-lg border border-agenda-line bg-bg"
      data-testid="agenda-week"
    >
      <div className="min-w-[48rem]">
        <div
          className={cn(
            'sticky top-0 z-20 grid border-b border-agenda-line bg-agenda-alt',
            COLUMNS,
          )}
        >
          <div />
          {days.map((day) => (
            <DayHeader
              key={day.toISOString()}
              day={day}
              today={sameDay(day, now)}
              count={countOn(visits, day)}
            />
          ))}
        </div>

        <div className={cn('relative grid', COLUMNS)} style={{ height: GRID_HEIGHT }}>
          {/* Rótulo da hora na própria linha (a visita das 08:30 fica a meio caminho). */}
          <div aria-hidden="true" className="relative">
            {HOURS.map((hour, index) => (
              <span
                key={hour}
                className={cn(
                  'absolute right-sm text-[11px] tabular-nums leading-none text-agenda-muted-2',
                  index > 0 && '-translate-y-1/2',
                )}
                style={{ top: index === 0 ? 4 : index * HOUR_PX }}
              >
                {formatHour(hour)}
              </span>
            ))}
          </div>
          {days.map((day) => (
            <DayColumn
              key={day.toISOString()}
              day={day}
              now={now}
              visits={visits.filter((visit) => sameDay(new Date(visit.scheduledAt), day))}
              selectedId={selectedId}
              onOpen={onOpen}
              onSlot={onSlot}
            />
          ))}
        </div>
      </div>

      {emptyState !== 'none' && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-lg">
          <div className="pointer-events-auto flex flex-col items-center gap-xs rounded-lg border border-agenda-line bg-bg px-xl py-[20px] text-center shadow-sm">
            <p className="text-[14px] font-semibold text-agenda-ink">
              {emptyState === 'filtered'
                ? 'Nenhuma visita com esses filtros'
                : 'Nenhuma visita nesta semana'}
            </p>
            {emptyState === 'filtered' ? (
              <button
                type="button"
                className="text-body font-semibold text-accent underline-offset-2 hover:underline"
                onClick={onClearFilters}
              >
                Limpar filtros
              </button>
            ) : (
              <p className="text-body text-agenda-muted">
                Use “+ Nova visita” ou clique num horário para agendar.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function countOn(visits: Visit[], day: Date): number {
  return visits.filter((visit) => sameDay(new Date(visit.scheduledAt), day)).length;
}

function DayHeader({ day, today, count }: { day: Date; today: boolean; count: number }) {
  const weekend = day.getDay() === 0 || day.getDay() === 6;
  return (
    <div
      className={cn(
        'flex items-center gap-sm border-l border-agenda-line-soft px-sm py-[10px]',
        today && 'bg-agenda-brand-tint',
        !today && weekend && 'bg-agenda-weekend',
      )}
      aria-current={today ? 'date' : undefined}
    >
      <span
        className={cn(
          'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-pill text-[16px] font-bold tabular-nums',
          today ? 'bg-accent text-bg' : 'text-agenda-ink',
        )}
      >
        {String(day.getDate()).padStart(2, '0')}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span
          className={cn(
            'text-[11px] font-bold uppercase tracking-[0.06em]',
            today ? 'text-accent' : 'text-agenda-muted',
          )}
        >
          {formatWeekday(day)}
        </span>
        <span className="truncate text-[11px] text-agenda-muted-2">
          {count === 0 ? 'sem visitas' : count === 1 ? '1 visita' : `${count} visitas`}
        </span>
      </span>
    </div>
  );
}

interface DayColumnProps {
  day: Date;
  now: Date;
  visits: Visit[];
  selectedId: string | null;
  onOpen: (visit: Visit) => void;
  onSlot: (at: Date) => void;
}

function DayColumn({ day, now, visits, selectedId, onOpen, onSlot }: DayColumnProps) {
  const today = sameDay(day, now);
  const weekend = day.getDay() === 0 || day.getDay() === 6;
  const nowTop = ((minutesOfDay(now) - FIRST_HOUR * 60) / 60) * HOUR_PX;

  /** Hora cheia ou meia hora, pela altura do clique. */
  function slotAt(offsetY: number): Date {
    const halfHours = Math.max(0, Math.floor(offsetY / (HOUR_PX / 2)));
    const minutes = FIRST_HOUR * 60 + Math.min(halfHours, GRID_ROWS * 2 - 1) * 30;
    return new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      Math.floor(minutes / 60),
      minutes % 60,
    );
  }

  return (
    <div
      className={cn(
        'group/day relative cursor-pointer border-l border-agenda-line-soft',
        today ? 'bg-agenda-brand-col' : weekend ? 'bg-agenda-weekend' : 'bg-bg',
      )}
      style={{
        backgroundImage:
          'linear-gradient(to bottom, var(--color-agenda-line-soft) 1px, transparent 1px)',
        backgroundSize: `100% ${HOUR_PX}px`,
      }}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onSlot(slotAt(event.clientY - rect.top));
      }}
      data-testid="agenda-day"
    >
      {HOURS.map((hour, index) => (
        <button
          key={hour}
          type="button"
          aria-label={`Agendar visita em ${formatDayLabel(day)} às ${formatHour(hour)}`}
          className="absolute right-xs z-0 rounded-sm px-xs text-caption text-agenda-muted opacity-0 focus:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          style={{ top: index * HOUR_PX + 2 }}
          onClick={(event) => {
            event.stopPropagation();
            onSlot(new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0));
          }}
        >
          +
        </button>
      ))}

      {placeVisits(visits).map(({ visit, top, lane }) => (
        <VisitBlock
          key={visit.id}
          visit={visit}
          top={top}
          lane={lane}
          selected={visit.id === selectedId}
          onOpen={onOpen}
        />
      ))}

      {today && nowTop >= 0 && nowTop <= GRID_HEIGHT && (
        <div
          aria-hidden="true"
          data-testid="agenda-now"
          className="pointer-events-none absolute inset-x-0 z-10 h-[2px] bg-agenda-now"
          style={{ top: nowTop }}
        >
          <span className="absolute -left-[4px] -top-[3px] h-2 w-2 rounded-pill bg-agenda-now" />
        </div>
      )}
    </div>
  );
}

interface VisitBlockProps {
  visit: Visit;
  top: number;
  lane: number;
  selected: boolean;
  onOpen: (visit: Visit) => void;
}

function VisitBlock({ visit, top, lane, selected, onOpen }: VisitBlockProps) {
  const style = STATUS_STYLES[visit.status];
  const inset = lane * 28;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen(visit);
      }}
      aria-label={`${formatTime(visit.scheduledAt)} ${visit.doctor.name} — ${VISIT_STATUS_LABELS[visit.status]}`}
      aria-pressed={selected}
      className={cn(
        'absolute z-[1] flex flex-col gap-[2px] overflow-hidden rounded-md px-[7px] py-xs text-left transition-[filter]',
        'hover:brightness-[.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        style.bg,
        style.ink,
        lane > 0 && 'shadow-[0_0_0_1.5px_var(--color-bg),0_2px_6px_rgba(0,0,0,.12)]',
        selected && 'shadow-[0_0_0_2px_var(--color-agenda-ink)]',
      )}
      style={{
        top: top + 1,
        height: (BLOCK_MINUTES / 60) * HOUR_PX - 3,
        left: `calc(${inset}% + 3px)`,
        width: `calc(100% - ${inset}% - 6px)`,
        zIndex: 1 + lane,
      }}
      data-testid="visit-block"
    >
      <span className="flex items-center gap-[5px] text-[11px] font-semibold tabular-nums leading-tight">
        <StatusDot status={visit.status} />
        {formatTime(visit.scheduledAt)}
      </span>
      <span
        className={cn(
          'truncate text-caption font-semibold leading-tight',
          isStruck(visit.status) && 'line-through',
        )}
      >
        {visit.doctor.name}
      </span>
      <span className="flex min-w-0 items-center gap-[5px] text-[11px] leading-tight opacity-[.85]">
        <PersonAvatar person={visit.responsible} size={16} />
        <span className="truncate">{visit.doctor.specialty ?? visit.responsible?.name ?? ''}</span>
      </span>
    </button>
  );
}
