import { useState } from 'react';
import { VISIT_STATUS_LABELS, type Visit } from '@crm-lab/shared';
import { cn } from '@/components/ui';
import { formatDayLabel, formatTime, formatWeekday, sameDay, withDay } from './agenda-dates';
import { PURPOSE_STYLES, PersonAvatar, StatusIcon, isStruck } from './agenda-ui';
import { isVisitDrag, readVisitDrag, startVisitDrag } from './agenda-drag';

/** Cartões que cabem no dia; com mais, mostra `MAX_CARDS - 1` e o "+N". */
export const MAX_MONTH_CARDS = 3;

interface AgendaMonthProps {
  /** Dia 1 do mês na tela. */
  monthStart: Date;
  /** Grade seg–dom (`monthGridDays`). */
  days: Date[];
  now: Date;
  /** Já filtradas. */
  visits: Visit[];
  selectedId: string | null;
  emptyState: 'none' | 'week' | 'filtered';
  onOpen: (visit: Visit) => void;
  /** Clique no vazio do dia: nova visita nele (às 09:00). */
  onSlot: (at: Date) => void;
  /** Número do dia ou "+N": vai para a Semana daquele dia (D-331 item 3). */
  onShowDay: (day: Date) => void;
  onClearFilters: () => void;
  canDrag: (visit: Visit) => boolean;
  onMoveVisit: (visit: Visit, at: Date) => void;
}

const WEEKDAY_HEADERS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'];

/**
 * Visão Mês (CRMLAB-191, D-331): grade seg–dom com as semanas que tocam o mês;
 * até 3 cartões por dia na cor da finalidade, "+N" quando não cabe. Soltar um
 * cartão em outro dia reagenda mantendo a hora.
 */
export function AgendaMonth({
  monthStart,
  days,
  now,
  visits,
  selectedId,
  emptyState,
  onOpen,
  onSlot,
  onShowDay,
  onClearFilters,
  canDrag,
  onMoveVisit,
}: AgendaMonthProps) {
  const sorted = [...visits].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));

  function dropOn(id: string, day: Date) {
    const visit = visits.find((v) => v.id === id);
    if (visit && canDrag(visit)) onMoveVisit(visit, withDay(new Date(visit.scheduledAt), day));
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col overflow-auto rounded-lg border border-agenda-line bg-bg"
      data-testid="agenda-month"
    >
      <div className="grid grid-cols-7 border-b border-agenda-line bg-agenda-alt">
        {WEEKDAY_HEADERS.map((name) => (
          <div
            key={name}
            className="border-l border-agenda-line-soft px-sm py-[8px] text-[11px] font-bold uppercase tracking-[0.06em] text-agenda-muted first:border-l-0"
          >
            {name}
          </div>
        ))}
      </div>
      <div className="grid flex-1 auto-rows-[minmax(7rem,1fr)] grid-cols-7">
        {days.map((day) => (
          <MonthDay
            key={day.toISOString()}
            day={day}
            inMonth={day.getMonth() === monthStart.getMonth()}
            today={sameDay(day, now)}
            visits={sorted.filter((visit) => sameDay(new Date(visit.scheduledAt), day))}
            selectedId={selectedId}
            onOpen={onOpen}
            onSlot={onSlot}
            onShowDay={onShowDay}
            canDrag={canDrag}
            onDropOn={dropOn}
          />
        ))}
      </div>

      {emptyState !== 'none' && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-lg">
          <div className="pointer-events-auto flex flex-col items-center gap-xs rounded-lg border border-agenda-line bg-bg px-xl py-[20px] text-center shadow-sm">
            <p className="text-[14px] font-semibold text-agenda-ink">
              {emptyState === 'filtered'
                ? 'Nenhuma visita com esses filtros'
                : 'Nenhuma visita neste mês'}
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
                Use “+ Nova visita” ou clique num dia para agendar.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface MonthDayProps {
  day: Date;
  inMonth: boolean;
  today: boolean;
  visits: Visit[];
  selectedId: string | null;
  onOpen: (visit: Visit) => void;
  onSlot: (at: Date) => void;
  onShowDay: (day: Date) => void;
  canDrag: (visit: Visit) => boolean;
  onDropOn: (id: string, day: Date) => void;
}

function MonthDay({
  day,
  inMonth,
  today,
  visits,
  selectedId,
  onOpen,
  onSlot,
  onShowDay,
  canDrag,
  onDropOn,
}: MonthDayProps) {
  const [over, setOver] = useState(false);
  const weekend = day.getDay() === 0 || day.getDay() === 6;
  const overflow = visits.length > MAX_MONTH_CARDS;
  const shown = overflow ? visits.slice(0, MAX_MONTH_CARDS - 1) : visits;
  const hiddenCount = visits.length - shown.length;
  const label = formatDayLabel(day);

  return (
    <div
      className={cn(
        'flex min-w-0 cursor-pointer flex-col gap-[3px] border-l border-t border-agenda-line-soft p-xs',
        today ? 'bg-agenda-brand-col' : weekend ? 'bg-agenda-weekend' : 'bg-bg',
        over && 'bg-agenda-brand-tint',
      )}
      onClick={() => onSlot(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0))}
      onDragOver={(event) => {
        if (!isVisitDrag(event)) return;
        // Sem o preventDefault o navegador recusa o drop (HTML5 drag-and-drop).
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (!over) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        const payload = readVisitDrag(event);
        if (!payload) return;
        event.preventDefault();
        onDropOn(payload.id, day);
      }}
      data-testid="month-day"
      data-day={day.toISOString()}
      data-in-month={inMonth}
      aria-current={today ? 'date' : undefined}
    >
      <button
        type="button"
        aria-label={`Ver a semana de ${label}`}
        title={`${formatWeekday(day)} — ver a semana`}
        onClick={(event) => {
          event.stopPropagation();
          onShowDay(day);
        }}
        className={cn(
          'inline-flex h-6 min-w-[1.5rem] items-center justify-center self-start rounded-pill px-[5px] text-caption font-bold tabular-nums',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          today
            ? 'bg-accent text-bg'
            : inMonth
              ? 'text-agenda-ink hover:bg-agenda-press'
              : 'text-agenda-muted-2 hover:bg-agenda-press',
        )}
      >
        {day.getDate()}
      </button>

      {shown.map((visit) => (
        <MonthCard
          key={visit.id}
          visit={visit}
          dimmed={!inMonth}
          selected={visit.id === selectedId}
          draggable={canDrag(visit)}
          onOpen={onOpen}
        />
      ))}

      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onShowDay(day);
          }}
          aria-label={`Mais ${hiddenCount} ${hiddenCount === 1 ? 'visita' : 'visitas'} em ${label} — ver a semana`}
          className="self-start rounded-sm px-xs text-caption font-semibold text-agenda-muted hover:text-agenda-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="month-more"
        >
          +{hiddenCount}
        </button>
      )}
    </div>
  );
}

interface MonthCardProps {
  visit: Visit;
  dimmed: boolean;
  selected: boolean;
  draggable: boolean;
  onOpen: (visit: Visit) => void;
}

/** Cartão do dia: ícone de status + "HH:MM Médico" + avatar do responsável, na cor da finalidade. */
function MonthCard({ visit, dimmed, selected, draggable, onOpen }: MonthCardProps) {
  const style = PURPOSE_STYLES[visit.purpose.color];
  const struck = isStruck(visit.status);
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen(visit);
      }}
      aria-label={`${formatTime(visit.scheduledAt)} ${visit.doctor.name} — ${VISIT_STATUS_LABELS[visit.status]} · ${visit.purpose.name}`}
      aria-pressed={selected}
      title={`${visit.purpose.name} · ${VISIT_STATUS_LABELS[visit.status]}${visit.responsible ? ` · ${visit.responsible.name}` : ''}`}
      draggable={draggable}
      onDragStart={draggable ? (event) => startVisitDrag(event, visit) : undefined}
      className={cn(
        'flex min-w-0 items-center gap-[4px] rounded-sm px-[5px] py-[2px] text-left text-[11px] font-semibold leading-tight',
        'hover:brightness-[.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
        style.bg,
        style.ink,
        draggable && 'cursor-grab active:cursor-grabbing',
        (struck || dimmed) && 'opacity-60',
        selected && 'shadow-[0_0_0_2px_var(--color-agenda-ink)]',
      )}
      data-testid="month-card"
      data-purpose-color={visit.purpose.color}
      data-status={visit.status}
    >
      <StatusIcon status={visit.status} size={10} />
      <span className="shrink-0 tabular-nums">{formatTime(visit.scheduledAt)}</span>
      <span className={cn('min-w-0 flex-1 truncate', struck && 'line-through')}>
        {visit.doctor.name}
      </span>
      <PersonAvatar person={visit.responsible} size={16} />
    </button>
  );
}
