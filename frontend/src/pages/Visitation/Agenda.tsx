import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isVisitOpen,
  VISIT_STATUSES,
  VISIT_STATUS_LABELS,
  VISIT_TYPES,
  VISIT_TYPE_LABELS,
  type ListVisitsQuery,
  type Visit,
  type VisitDetail,
  type VisitStatus,
  type VisitType,
} from '@crm-lab/shared';
import { visitsApi } from '@/api/visits';
import { doctorsApi } from '@/api/doctors';
import { conversationsApi } from '@/api/conversations';
import { isApiError } from '@/api/client';
import { mapFieldErrors } from '@/api/error-handler';
import { queryKeys, queryScopes } from '@/api/query-keys';
import { useApiErrorHandler, useCurrentUser } from '@/hooks';
import { PageContainer, PageHeader } from '@/components/layout';
import { EmptyState, Modal } from '@/components/shared';
import { Button, Chip, Input, SegmentedControl, Select, TextArea, cn, useToast } from '@/components/ui';
import type { ChipTone } from '@/components/ui';
import {
  FIRST_HOUR,
  LAST_HOUR,
  addDays,
  formatDateTime,
  formatDayMonth,
  formatFullDay,
  formatHour,
  formatTime,
  formatWeekday,
  fromDateTimeInputs,
  gridHour,
  sameDay,
  startOfWeek,
  toDateInput,
  toTimeInput,
  weekDays,
  weekLabel,
  WEEK_DAYS,
} from './agenda-dates';

type View = 'week' | 'list';

const VIEW_OPTIONS: Array<{ value: View; label: string }> = [
  { value: 'week', label: 'Semana' },
  { value: 'list', label: 'Lista' },
];

const STATUS_TONES: Record<VisitStatus, ChipTone> = {
  agendada: 'attention',
  realizada: 'positive',
  cancelada: 'inactive',
  nao_recebeu: 'inactive',
};

const HOURS = Array.from({ length: LAST_HOUR - FIRST_HOUR + 1 }, (_, i) => FIRST_HOUR + i);

/** No celular a lista é a visão padrão (abaixo do `md` do Tailwind). */
function initialView(): View {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'week';
  return window.matchMedia('(max-width: 767px)').matches ? 'list' : 'week';
}

function StatusChip({ status }: { status: VisitStatus }) {
  return <Chip tone={STATUS_TONES[status]}>{VISIT_STATUS_LABELS[status]}</Chip>;
}

/** Abertura do modal: visita existente ou nova (com horário sugerido pela grade). */
type ModalState = { kind: 'visit'; id: string } | { kind: 'new'; at: Date } | null;

/**
 * Agenda de visitas — `/visitation/agenda` (PAGES.md §23 · API_CONTRACTS.md
 * §14 · CRMLAB-87, D-256). Visão semana (grade de horas × dias, clicar no
 * horário agenda) e lista (dias da semana em ordem). As duas mostram a MESMA
 * semana, com os mesmos filtros. Todo papel do laboratório vê e mexe em todas.
 */
export default function Agenda() {
  const [view, setView] = useState<View>(initialView);
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [responsibleId, setResponsibleId] = useState('');
  const [doctorId, setDoctorId] = useState('');
  const [status, setStatus] = useState<VisitStatus | ''>('');
  const [modal, setModal] = useState<ModalState>(null);

  const filters = useMemo<ListVisitsQuery>(
    () => ({
      from: weekStart.toISOString(),
      to: addDays(weekStart, WEEK_DAYS).toISOString(),
      ...(responsibleId ? { responsibleId } : {}),
      ...(doctorId ? { doctorId } : {}),
      ...(status ? { status } : {}),
    }),
    [weekStart, responsibleId, doctorId, status],
  );

  const visitsQuery = useQuery({
    queryKey: queryKeys.visits(filters),
    queryFn: () => visitsApi.list(filters),
  });

  // Usuários ativos do laboratório, qualquer papel (`GET /users` é admin-only).
  const assigneesQuery = useQuery({
    queryKey: queryKeys.conversationAssignees(),
    queryFn: () => conversationsApi.assignees(),
  });
  const assignees = assigneesQuery.data?.assignees ?? [];

  const doctorFilters = { active: true, limit: 100, sortBy: 'name' as const };
  const doctorsQuery = useQuery({
    queryKey: queryKeys.doctors(doctorFilters),
    queryFn: () => doctorsApi.list(doctorFilters),
  });
  const doctors = doctorsQuery.data?.doctors ?? [];

  const visits = visitsQuery.data?.visits ?? [];
  const days = weekDays(weekStart);
  const today = new Date();
  const hasFilters = Boolean(responsibleId || doctorId || status);

  return (
    <PageContainer>
      <PageHeader
        title="Agenda de visitas"
        description="Visitas da equipe aos médicos solicitantes."
        actions={
          <Button variant="primary" onClick={() => setModal({ kind: 'new', at: defaultNewVisitTime(weekStart) })}>
            + Nova visita
          </Button>
        }
      />

      <div className="flex flex-col gap-md md:flex-row md:flex-wrap md:items-center md:justify-between">
        <div className="flex flex-wrap items-center gap-sm">
          <Button variant="secondary" size="sm" onClick={() => setWeekStart(addDays(weekStart, -WEEK_DAYS))}>
            ‹ Anterior
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setWeekStart(startOfWeek(new Date()))}>
            Hoje
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setWeekStart(addDays(weekStart, WEEK_DAYS))}>
            Próxima ›
          </Button>
          <span className="font-heading text-label font-semibold text-text" data-testid="week-label">
            {weekLabel(weekStart)}
          </span>
        </div>
        <SegmentedControl aria-label="Visão da agenda" options={VIEW_OPTIONS} value={view} onChange={setView} />
      </div>

      <div className="grid grid-cols-1 gap-md md:grid-cols-3">
        <Select
          aria-label="Filtrar por responsável"
          value={responsibleId}
          onChange={(event) => setResponsibleId(event.target.value)}
          options={[{ value: '', label: 'Todos os responsáveis' }, ...assignees.map((a) => ({ value: a.id, label: a.name }))]}
        />
        <Select
          aria-label="Filtrar por médico"
          value={doctorId}
          onChange={(event) => setDoctorId(event.target.value)}
          options={[{ value: '', label: 'Todos os médicos' }, ...doctors.map((d) => ({ value: d.id, label: d.name }))]}
        />
        <Select
          aria-label="Filtrar por status"
          value={status}
          onChange={(event) => setStatus(event.target.value as VisitStatus | '')}
          options={[
            { value: '', label: 'Todos os status' },
            ...VISIT_STATUSES.map((s) => ({ value: s, label: VISIT_STATUS_LABELS[s] })),
          ]}
        />
      </div>

      {visitsQuery.data?.truncated && (
        <p className="text-caption text-neutral-600">
          A semana tem visitas demais para mostrar todas. Use os filtros para refinar.
        </p>
      )}

      {visitsQuery.isLoading ? (
        <p className="font-body text-body text-neutral-600">Carregando visitas...</p>
      ) : visitsQuery.isError ? (
        <EmptyState message="Não foi possível carregar as visitas" hint="Verifique a conexão e tente novamente." />
      ) : view === 'week' ? (
        <WeekGrid
          days={days}
          today={today}
          visits={visits}
          onOpen={(visit) => setModal({ kind: 'visit', id: visit.id })}
          onSlot={(at) => setModal({ kind: 'new', at })}
        />
      ) : visits.length === 0 ? (
        <EmptyState
          message="Nenhuma visita nesta semana"
          hint={hasFilters ? 'Ajuste os filtros.' : 'Use "+ Nova visita" para agendar.'}
        />
      ) : (
        <VisitList days={days} visits={visits} onOpen={(visit) => setModal({ kind: 'visit', id: visit.id })} />
      )}

      {modal?.kind === 'new' && (
        <VisitFormModal
          initialAt={modal.at}
          assignees={assignees}
          doctors={doctors}
          onClose={() => setModal(null)}
          onSaved={() => setModal(null)}
        />
      )}
      {modal?.kind === 'visit' && (
        <VisitModal id={modal.id} assignees={assignees} doctors={doctors} onClose={() => setModal(null)} />
      )}
    </PageContainer>
  );
}

/** "+ Nova visita" sem clicar na grade: hoje (se a semana é a atual) ou a segunda, às 9h. */
function defaultNewVisitTime(weekStart: Date): Date {
  const now = new Date();
  const base = sameDay(startOfWeek(now), weekStart) ? now : weekStart;
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), 9, 0);
}

interface WeekGridProps {
  days: Date[];
  today: Date;
  visits: Visit[];
  onOpen: (visit: Visit) => void;
  onSlot: (at: Date) => void;
}

/**
 * Grade horas × dias. A célula toda agenda naquele horário (clique do mouse);
 * o botão "+" da célula faz o mesmo pelo teclado. O cartão da visita abre a
 * visita e não propaga o clique para a célula.
 */
function WeekGrid({ days, today, visits, onOpen, onSlot }: WeekGridProps) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-surface" data-testid="agenda-week">
      <div className="grid min-w-[56rem] grid-cols-[4rem_repeat(7,minmax(0,1fr))]">
        <div className="border-b border-neutral-200" />
        {days.map((day) => (
          <div
            key={day.toISOString()}
            className={cn(
              'border-b border-l border-neutral-200 p-sm text-center',
              sameDay(day, today) && 'bg-accent-100',
            )}
          >
            <div className="text-micro uppercase text-neutral-600">{formatWeekday(day)}</div>
            <div className="font-heading text-label font-semibold text-text">{formatDayMonth(day)}</div>
          </div>
        ))}

        {HOURS.map((hour) => (
          <HourRow key={hour} hour={hour} days={days} visits={visits} onOpen={onOpen} onSlot={onSlot} />
        ))}
      </div>
    </div>
  );
}

function HourRow({
  hour,
  days,
  visits,
  onOpen,
  onSlot,
}: { hour: number } & Pick<WeekGridProps, 'days' | 'visits' | 'onOpen' | 'onSlot'>) {
  return (
    <>
      <div className="border-b border-neutral-200 p-xs text-right text-caption tabular-nums text-neutral-600">
        {formatHour(hour)}
      </div>
      {days.map((day) => {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0);
        const inSlot = visits.filter((visit) => {
          const date = new Date(visit.scheduledAt);
          return sameDay(date, day) && gridHour(date) === hour;
        });
        const slotLabel = `Agendar visita em ${formatWeekday(day)} ${formatDayMonth(day)} às ${formatHour(hour)}`;
        return (
          <div
            key={day.toISOString()}
            className="group relative flex min-h-[3.5rem] cursor-pointer flex-col gap-xs border-b border-l border-neutral-200 p-xs hover:bg-neutral-100"
            onClick={() => onSlot(at)}
          >
            {inSlot.map((visit) => (
              <VisitCard key={visit.id} visit={visit} onOpen={onOpen} />
            ))}
            <button
              type="button"
              aria-label={slotLabel}
              className="absolute right-xs top-xs rounded-sm px-xs text-caption text-neutral-600 opacity-0 focus:opacity-100 group-hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                onSlot(at);
              }}
            >
              +
            </button>
          </div>
        );
      })}
    </>
  );
}

function VisitCard({ visit, onOpen }: { visit: Visit; onOpen: (visit: Visit) => void }) {
  const closed = !isVisitOpen(visit.status);
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen(visit);
      }}
      className={cn(
        'w-full rounded-md border border-accent-200 bg-accent-100 p-xs text-left text-caption shadow-sm',
        'hover:border-accent',
        closed && 'border-neutral-200 bg-neutral-100 text-neutral-600 line-through',
      )}
      aria-label={`${formatTime(visit.scheduledAt)} ${visit.doctor.name} — ${VISIT_STATUS_LABELS[visit.status]}`}
    >
      <div className="font-semibold tabular-nums">{formatTime(visit.scheduledAt)}</div>
      <div className="truncate">{visit.doctor.name}</div>
      {visit.responsible && <div className="truncate text-neutral-600">{visit.responsible.name}</div>}
    </button>
  );
}

function VisitList({ days, visits, onOpen }: { days: Date[]; visits: Visit[]; onOpen: (visit: Visit) => void }) {
  return (
    <div className="flex flex-col gap-lg" data-testid="agenda-list">
      {days.map((day) => {
        const ofDay = visits.filter((visit) => sameDay(new Date(visit.scheduledAt), day));
        if (ofDay.length === 0) return null;
        return (
          <section key={day.toISOString()} className="flex flex-col gap-sm">
            <h2 className="font-heading text-label font-semibold capitalize text-text">{formatFullDay(day)}</h2>
            <ul className="flex flex-col gap-sm">
              {ofDay.map((visit) => (
                <li key={visit.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(visit)}
                    className="flex w-full flex-col gap-xs rounded-lg border border-neutral-200 bg-surface p-md text-left shadow-sm hover:border-accent md:flex-row md:items-center md:gap-lg"
                  >
                    <span className="font-semibold tabular-nums text-text md:w-16">{formatTime(visit.scheduledAt)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold text-text">{visit.doctor.name}</span>
                      <span className="block truncate text-caption text-neutral-600">
                        {[VISIT_TYPE_LABELS[visit.type], visit.responsible?.name, visit.agenda].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <StatusChip status={visit.status} />
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

type Person = { id: string; name: string };

/** Opções de seleção com o valor atual garantido (médico/responsável inativo continua aparecendo). */
function withCurrent(options: Person[], current: Person | null | undefined, suffix: string) {
  const list = options.map((o) => ({ value: o.id, label: o.name }));
  if (current && !options.some((o) => o.id === current.id)) {
    list.push({ value: current.id, label: `${current.name} ${suffix}` });
  }
  return list;
}

function useFieldErrors() {
  const handleApiError = useApiErrorHandler();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  function onError(error: unknown) {
    if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
      const fields = mapFieldErrors(error.details);
      if (Object.keys(fields).length > 0) {
        setFieldErrors(fields);
        return;
      }
    }
    handleApiError(error);
  }
  return { fieldErrors, setFieldErrors, onError };
}

function invalidateVisits(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: queryScopes.visits });
}

interface VisitFormModalProps {
  /** Ausente = nova visita. */
  visit?: VisitDetail;
  initialAt?: Date;
  assignees: Person[];
  doctors: Person[];
  onClose: () => void;
  onSaved: () => void;
}

/** Criar (com data/hora) ou editar (médico, responsável, tipo, pauta — a data muda por "Reagendar"). */
function VisitFormModal({ visit, initialAt, assignees, doctors, onClose, onSaved }: VisitFormModalProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const user = useCurrentUser();
  const { fieldErrors, setFieldErrors, onError } = useFieldErrors();
  const isEdit = visit !== undefined;
  const at = initialAt ?? new Date();

  const [doctorId, setDoctorId] = useState(visit?.doctor.id ?? '');
  const [responsibleId, setResponsibleId] = useState(
    visit ? (visit.responsible?.id ?? '') : assignees.some((a) => a.id === user?.id) ? (user?.id ?? '') : '',
  );
  const [day, setDay] = useState(toDateInput(at));
  const [time, setTime] = useState(toTimeInput(at));
  const [type, setType] = useState<VisitType>(visit?.type ?? 'presencial');
  const [agenda, setAgenda] = useState(visit?.agenda ?? '');

  const save = useMutation({
    mutationFn: () => {
      const agendaValue = agenda.trim().length > 0 ? agenda.trim() : null;
      if (visit) {
        return visitsApi.update(visit.id, {
          doctorId,
          ...(responsibleId ? { responsibleId } : {}),
          type,
          agenda: agendaValue,
        });
      }
      return visitsApi.create({
        doctorId,
        responsibleId,
        scheduledAt: fromDateTimeInputs(day, time) ?? '',
        type,
        agenda: agendaValue,
      });
    },
    onSuccess: () => {
      toast(isEdit ? 'Visita atualizada' : 'Visita agendada', { tone: 'positive' });
      invalidateVisits(queryClient);
      onSaved();
    },
    onError,
  });

  function handleSubmit(event?: React.FormEvent) {
    event?.preventDefault();
    const errors: Record<string, string> = {};
    if (!doctorId) errors.doctorId = 'Escolha o médico';
    if (!isEdit && !responsibleId) errors.responsibleId = 'Escolha o responsável';
    if (!isEdit && fromDateTimeInputs(day, time) === null) errors.scheduledAt = 'Informe data e hora';
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    save.mutate();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? 'Editar visita' : 'Nova visita'}
      footer={
        <div className="ml-auto flex gap-md">
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button variant="primary" onClick={() => handleSubmit()} loading={save.isPending}>
            {isEdit ? 'Salvar' : 'Agendar'}
          </Button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-md md:grid-cols-2" noValidate>
        <div className="md:col-span-2">
          <Select
            label="Médico"
            value={doctorId}
            onChange={(e) => setDoctorId(e.target.value)}
            placeholder="Selecione o médico"
            options={withCurrent(doctors, visit?.doctor, '(inativo)')}
            error={fieldErrors.doctorId}
          />
        </div>
        <Select
          label="Responsável"
          value={responsibleId}
          onChange={(e) => setResponsibleId(e.target.value)}
          placeholder="Selecione o responsável"
          options={withCurrent(assignees, visit?.responsible, '(inativo)')}
          error={fieldErrors.responsibleId}
        />
        <Select
          label="Tipo"
          value={type}
          onChange={(e) => setType(e.target.value as VisitType)}
          options={VISIT_TYPES.map((t) => ({ value: t, label: VISIT_TYPE_LABELS[t] }))}
          error={fieldErrors.type}
        />
        {!isEdit && (
          <>
            <Input
              label="Data"
              type="date"
              value={day}
              onChange={(e) => setDay(e.target.value)}
              error={fieldErrors.scheduledAt}
            />
            <Input label="Hora" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </>
        )}
        <div className="md:col-span-2">
          <TextArea
            label="Objetivo/pauta"
            value={agenda}
            onChange={(e) => setAgenda(e.target.value)}
            error={fieldErrors.agenda}
            rows={3}
          />
        </div>
      </form>
    </Modal>
  );
}

type VisitAction = 'reschedule' | 'cancel' | 'not_received';

const ACTION_TITLES: Record<VisitAction, string> = {
  reschedule: 'Reagendar visita',
  cancel: 'Cancelar visita',
  not_received: 'Médico não recebeu',
};

interface VisitModalProps {
  id: string;
  assignees: Person[];
  doctors: Person[];
  onClose: () => void;
}

/** Visita aberta: detalhe + histórico de datas; ações só enquanto `agendada`. */
function VisitModal({ id, assignees, doctors, onClose }: VisitModalProps) {
  const [mode, setMode] = useState<'view' | 'edit' | VisitAction>('view');
  const visitQuery = useQuery({ queryKey: queryKeys.visit(id), queryFn: () => visitsApi.get(id) });
  const visit = visitQuery.data;

  if (visit && mode === 'edit') {
    return (
      <VisitFormModal
        visit={visit}
        assignees={assignees}
        doctors={doctors}
        onClose={() => setMode('view')}
        onSaved={() => setMode('view')}
      />
    );
  }
  if (visit && (mode === 'reschedule' || mode === 'cancel' || mode === 'not_received')) {
    return <VisitActionModal visit={visit} action={mode} onClose={() => setMode('view')} />;
  }

  const open = visit ? isVisitOpen(visit.status) : false;
  return (
    <Modal
      open
      onClose={onClose}
      title="Visita"
      footer={
        open ? (
          <div className="flex w-full flex-wrap justify-end gap-sm">
            <Button variant="secondary" onClick={() => setMode('not_received')}>
              Médico não recebeu
            </Button>
            <Button variant="secondary" onClick={() => setMode('cancel')}>
              Cancelar visita
            </Button>
            <Button variant="secondary" onClick={() => setMode('reschedule')}>
              Reagendar
            </Button>
            <Button variant="primary" onClick={() => setMode('edit')}>
              Editar
            </Button>
          </div>
        ) : undefined
      }
    >
      {!visit ? (
        <p className="text-body text-neutral-600">{visitQuery.isError ? 'Não foi possível carregar a visita.' : 'Carregando...'}</p>
      ) : (
        <div className="flex flex-col gap-lg">
          <div className="flex flex-wrap items-start justify-between gap-md">
            <div className="min-w-0">
              <div className="font-heading text-section text-text">{visit.doctor.name}</div>
              <div className="text-caption text-neutral-600">
                {[visit.doctor.crm ? `CRM ${visit.doctor.crm}/${visit.doctor.crmUf ?? ''}` : null, visit.doctor.specialty]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            <StatusChip status={visit.status} />
          </div>

          <dl className="grid grid-cols-1 gap-md text-body md:grid-cols-2">
            <Field label="Data/hora prevista" value={formatDateTime(visit.scheduledAt)} />
            <Field label="Tipo" value={VISIT_TYPE_LABELS[visit.type]} />
            <Field label="Responsável" value={visit.responsible?.name ?? '—'} />
            <Field label="Agendada por" value={visit.createdBy?.name ?? '—'} />
            <div className="md:col-span-2">
              <Field label="Objetivo/pauta" value={visit.agenda ?? '—'} />
            </div>
            {visit.statusReason && (
              <div className="md:col-span-2">
                <Field
                  label={`Motivo (${VISIT_STATUS_LABELS[visit.status].toLowerCase()})`}
                  value={`${visit.statusReason}${
                    visit.statusChangedAt
                      ? ` — ${visit.statusChangedBy?.name ?? 'alguém'} em ${formatDateTime(visit.statusChangedAt)}`
                      : ''
                  }`}
                />
              </div>
            )}
          </dl>

          {visit.reschedules.length > 0 && (
            <section className="flex flex-col gap-sm">
              <h3 className="font-heading text-label font-semibold text-text">Histórico de datas</h3>
              <ul className="flex flex-col gap-xs text-caption text-text" data-testid="visit-reschedules">
                {visit.reschedules.map((r) => (
                  <li key={r.id}>
                    {formatDateTime(r.previousScheduledAt)} → {formatDateTime(r.newScheduledAt)}
                    <span className="text-neutral-600">
                      {' '}
                      · {r.changedBy?.name ?? '—'} em {formatDateTime(r.changedAt)}
                      {r.reason ? ` · ${r.reason}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-caption font-semibold text-neutral-700">{label}</dt>
      <dd className="whitespace-pre-wrap text-text">{value}</dd>
    </div>
  );
}

/** Reagendar (nova data/hora + motivo opcional) ou encerrar (motivo obrigatório). */
function VisitActionModal({ visit, action, onClose }: { visit: VisitDetail; action: VisitAction; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { fieldErrors, setFieldErrors, onError } = useFieldErrors();
  const current = new Date(visit.scheduledAt);
  const [day, setDay] = useState(toDateInput(current));
  const [time, setTime] = useState(toTimeInput(current));
  const [reason, setReason] = useState('');

  const run = useMutation({
    mutationFn: () => {
      const trimmed = reason.trim();
      if (action === 'reschedule') {
        return visitsApi.reschedule(visit.id, {
          scheduledAt: fromDateTimeInputs(day, time) ?? '',
          reason: trimmed.length > 0 ? trimmed : null,
        });
      }
      return action === 'cancel'
        ? visitsApi.cancel(visit.id, { reason: trimmed })
        : visitsApi.notReceived(visit.id, { reason: trimmed });
    },
    onSuccess: (updated) => {
      toast(action === 'reschedule' ? 'Visita reagendada' : VISIT_STATUS_LABELS[updated.status], { tone: 'positive' });
      queryClient.setQueryData(queryKeys.visit(visit.id), updated);
      invalidateVisits(queryClient);
      onClose();
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'VISIT_ALREADY_CLOSED') {
        toast('A visita já foi encerrada por outra pessoa.', { tone: 'attention' });
        invalidateVisits(queryClient);
        onClose();
        return;
      }
      onError(error);
    },
  });

  function handleSubmit(event?: React.FormEvent) {
    event?.preventDefault();
    if (action === 'reschedule' && fromDateTimeInputs(day, time) === null) {
      setFieldErrors({ scheduledAt: 'Informe data e hora' });
      return;
    }
    if (action !== 'reschedule' && reason.trim().length === 0) {
      setFieldErrors({ reason: 'Informe o motivo' });
      return;
    }
    run.mutate();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={ACTION_TITLES[action]}
      footer={
        <div className="ml-auto flex gap-md">
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button variant="primary" onClick={() => handleSubmit()} loading={run.isPending}>
            Confirmar
          </Button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-md md:grid-cols-2" noValidate>
        <p className="text-body text-neutral-600 md:col-span-2">
          {visit.doctor.name} · hoje marcada para {formatDateTime(visit.scheduledAt)}
        </p>
        {action === 'reschedule' && (
          <>
            <Input
              label="Nova data"
              type="date"
              value={day}
              onChange={(e) => setDay(e.target.value)}
              error={fieldErrors.scheduledAt}
            />
            <Input label="Nova hora" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </>
        )}
        <div className="md:col-span-2">
          <TextArea
            label={action === 'reschedule' ? 'Motivo (opcional)' : 'Motivo'}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              if (fieldErrors.reason) setFieldErrors({});
            }}
            error={fieldErrors.reason}
            rows={3}
            required={action !== 'reschedule'}
          />
        </div>
      </form>
    </Modal>
  );
}
