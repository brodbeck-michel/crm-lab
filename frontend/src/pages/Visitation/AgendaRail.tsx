import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  VISIT_STATUS_LABELS,
  VISIT_TYPE_LABELS,
  visitDurationMinutes,
  type Visit,
  type VisitStatus,
} from '@crm-lab/shared';
import { visitsApi } from '@/api/visits';
import { queryKeys } from '@/api/query-keys';
import { cn } from '@/components/ui';
import { formatMinutes } from '@/lib/format';
import { formatDayLabel, formatTime } from './agenda-dates';
import {
  AgendaButton,
  PersonAvatar,
  STATUS_ORDER,
  STATUS_STYLES,
  StatusBadge,
  StatusDot,
} from './agenda-ui';
import { returnPrefill, useVisitCheck, type ReturnVisitPrefill } from './VisitRecord';

export type RailAction = 'reschedule' | 'cancel' | 'not_received';

interface AgendaRailProps {
  /** Semana inteira, sem filtro — o resumo ignora os filtros. */
  weekVisits: Visit[];
  /** Visitas de hoje, já filtradas. */
  todayVisits: Visit[];
  today: Date;
  selected: Visit | null;
  onSelect: (visit: Visit) => void;
  onCloseDetail: () => void;
  onOpenFull: (visit: Visit) => void;
  onAction: (visit: Visit, action: RailAction) => void;
  onScheduleReturn: (prefill: ReturnVisitPrefill) => void;
}

/**
 * Coluna de resumo (≥ 1280px, CRMLAB-92, D-262): resumo da semana no topo e,
 * embaixo, "Hoje" ou o detalhe da visita escolhida com as ações do estado.
 */
export function AgendaRail(props: AgendaRailProps) {
  const { weekVisits, todayVisits, today, selected, onSelect } = props;
  return (
    <aside
      aria-label="Resumo da agenda"
      className="flex w-[280px] shrink-0 flex-col gap-[20px] overflow-y-auto border-l border-agenda-line bg-agenda-rail px-[20px] py-xl"
      data-testid="agenda-rail"
    >
      <WeekSummary visits={weekVisits} />
      <div className="h-px shrink-0 bg-agenda-line" />
      {selected ? (
        <VisitDetailPanel key={selected.id} {...props} selected={selected} />
      ) : (
        <TodayPanel visits={todayVisits} today={today} onSelect={onSelect} />
      )}
    </aside>
  );
}

function Overline({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-caption font-bold uppercase tracking-[0.06em] text-agenda-muted">
      {children}
    </h2>
  );
}

function WeekSummary({ visits }: { visits: Visit[] }) {
  const counts = countByStatus(visits);
  const total = visits.length;
  return (
    <section className="flex flex-col gap-md" data-testid="week-summary">
      <Overline>Resumo da semana</Overline>
      <p className="flex items-baseline gap-sm">
        <span className="text-[34px] font-bold leading-none tracking-[-0.02em] tabular-nums text-agenda-ink">
          {total}
        </span>
        <span className="text-[14px] text-agenda-muted">{total === 1 ? 'visita' : 'visitas'}</span>
      </p>
      <div
        className="flex h-2 overflow-hidden rounded-sm bg-agenda-line-soft"
        role="img"
        aria-label={STATUS_ORDER.map(
          (status) => `${VISIT_STATUS_LABELS[status]}: ${counts[status]}`,
        ).join(', ')}
      >
        {total > 0 &&
          STATUS_ORDER.map((status) =>
            counts[status] > 0 ? (
              <span
                key={status}
                className={STATUS_STYLES[status].dot}
                style={{ width: `${(counts[status] / total) * 100}%` }}
              />
            ) : null,
          )}
      </div>
    </section>
  );
}

export function countByStatus(visits: Visit[]): Record<VisitStatus, number> {
  const counts: Record<VisitStatus, number> = {
    agendada: 0,
    realizada: 0,
    nao_recebeu: 0,
    cancelada: 0,
  };
  for (const visit of visits) counts[visit.status] += 1;
  return counts;
}

function TodayPanel({
  visits,
  today,
  onSelect,
}: {
  visits: Visit[];
  today: Date;
  onSelect: (visit: Visit) => void;
}) {
  return (
    <section className="flex flex-col gap-md" data-testid="today-panel">
      <Overline>Hoje · {formatDayLabel(today)}</Overline>
      {visits.length === 0 ? (
        <p className="text-[14px] text-agenda-muted">Sem visitas hoje.</p>
      ) : (
        <ul className="flex flex-col gap-md">
          {visits.map((visit) => (
            <li key={visit.id}>
              <button
                type="button"
                onClick={() => onSelect(visit)}
                className="flex w-full gap-md rounded-md border border-agenda-line bg-bg p-[10px] text-left hover:border-agenda-line-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <span className="w-[44px] shrink-0 text-body font-bold tabular-nums text-agenda-ink">
                  {formatTime(visit.scheduledAt)}
                </span>
                <span className="flex min-w-0 flex-col gap-[2px]">
                  <span className="truncate text-[14px] font-semibold text-agenda-ink">
                    {visit.doctor.name}
                  </span>
                  <span className="truncate text-caption text-agenda-muted">
                    {[visit.doctor.specialty, visit.responsible?.name]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </span>
                  <span
                    className={cn(
                      'flex items-center gap-[6px] text-caption font-semibold',
                      STATUS_STYLES[visit.status].ink,
                    )}
                  >
                    <StatusDot status={visit.status} />
                    {VISIT_STATUS_LABELS[visit.status]}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function VisitDetailPanel({
  selected,
  onCloseDetail,
  onOpenFull,
  onAction,
  onScheduleReturn,
}: AgendaRailProps & { selected: Visit }) {
  // O detalhe busca a visita: o check-in/out do painel atualiza este cache na hora.
  const detailQuery = useQuery({
    queryKey: queryKeys.visit(selected.id),
    queryFn: () => visitsApi.get(selected.id),
  });
  const visit: Visit = detailQuery.data ?? selected;
  const { checkIn, checkOut } = useVisitCheck(visit.id);
  const scheduled = new Date(visit.scheduledAt);
  const duration = visitDurationMinutes(visit);
  const open = visit.status === 'agendada';

  return (
    <section className="flex flex-col gap-lg" data-testid="visit-detail-panel">
      <div className="flex items-center justify-between">
        <Overline>Detalhes da visita</Overline>
        <button
          type="button"
          aria-label="Fechar detalhes"
          onClick={onCloseDetail}
          className="rounded-sm px-xs text-[18px] leading-none text-agenda-muted hover:text-agenda-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          ×
        </button>
      </div>

      <div className="flex flex-col gap-sm">
        <span>
          <StatusBadge status={visit.status} />
        </span>
        <div>
          <p className="text-[20px] font-semibold leading-[1.2] text-agenda-ink">
            {visit.doctor.name}
          </p>
          {visit.doctor.specialty && (
            <p className="text-[14px] text-agenda-muted">{visit.doctor.specialty}</p>
          )}
        </div>
      </div>

      <dl className="grid grid-cols-[84px_1fr] gap-x-sm gap-y-[10px] text-[14px]">
        <dt className="text-agenda-muted">Quando</dt>
        <dd className="font-semibold text-agenda-ink">{formatDayLabel(scheduled)}</dd>
        <dt className="text-agenda-muted">Horário</dt>
        <dd className="font-semibold tabular-nums text-agenda-ink">
          {visit.checkInAt
            ? [
                `Cheguei ${formatTime(visit.checkInAt)}`,
                visit.checkOutAt ? `Saí ${formatTime(visit.checkOutAt)}` : null,
                duration !== null ? `(${formatMinutes(duration)})` : null,
              ]
                .filter(Boolean)
                .join(' · ')
            : formatTime(visit.scheduledAt)}
        </dd>
        <dt className="text-agenda-muted">Tipo</dt>
        <dd className="text-agenda-ink">{VISIT_TYPE_LABELS[visit.type]}</dd>
        {visit.doctor.clinic && (
          <>
            <dt className="text-agenda-muted">Local</dt>
            <dd className="text-agenda-ink">{visit.doctor.clinic}</dd>
          </>
        )}
        <dt className="text-agenda-muted">Responsável</dt>
        <dd className="flex min-w-0 items-center gap-sm text-agenda-ink">
          <PersonAvatar person={visit.responsible} size={20} />
          <span className="truncate">{visit.responsible?.name ?? '—'}</span>
        </dd>
        {visit.statusReason && (
          <>
            <dt className="text-agenda-muted">Motivo</dt>
            <dd className="whitespace-pre-wrap text-agenda-ink">{visit.statusReason}</dd>
          </>
        )}
      </dl>

      <div className="flex flex-col gap-sm">
        {open && visit.checkInAt === null && (
          <>
            <AgendaButton
              variant="primary"
              onClick={() => checkIn.mutate()}
              loading={checkIn.isPending}
            >
              Cheguei
            </AgendaButton>
            <div className="grid grid-cols-2 gap-sm">
              <AgendaButton onClick={() => onAction(visit, 'reschedule')}>Reagendar</AgendaButton>
              <AgendaButton variant="danger" onClick={() => onAction(visit, 'cancel')}>
                Cancelar
              </AgendaButton>
            </div>
          </>
        )}
        {open && visit.checkInAt !== null && (
          <>
            {/* Depois do check-in a data não muda mais (D-258 item 4). */}
            <AgendaButton
              variant="primary"
              onClick={() => checkOut.mutate()}
              loading={checkOut.isPending}
            >
              Saí
            </AgendaButton>
            <AgendaButton variant="danger" onClick={() => onAction(visit, 'cancel')}>
              Cancelar
            </AgendaButton>
          </>
        )}
        {visit.status === 'realizada' && (
          <>
            <AgendaButton variant="primary" onClick={() => onOpenFull(visit)}>
              Registrar relato
            </AgendaButton>
            {visit.nextVisitDate && (
              <AgendaButton
                onClick={() => onScheduleReturn(returnPrefill(visit, visit.nextVisitDate ?? ''))}
              >
                Agendar retorno
              </AgendaButton>
            )}
          </>
        )}
        <div className="flex flex-wrap justify-between gap-sm pt-xs">
          <LinkButton onClick={() => onOpenFull(visit)}>Abrir visita completa</LinkButton>
          {open && (
            <LinkButton onClick={() => onAction(visit, 'not_received')}>
              Médico não recebeu
            </LinkButton>
          )}
        </div>
      </div>
    </section>
  );
}

function LinkButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-body font-semibold text-accent-700 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {children}
    </button>
  );
}
