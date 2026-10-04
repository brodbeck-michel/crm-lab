import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  isVisitOpen,
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
import { PageHeader } from '@/components/layout';
import { EmptyState, Modal } from '@/components/shared';
import { Button, Input, Select, TextArea, cn, useToast } from '@/components/ui';
import {
  WEEK_DAYS,
  addDays,
  formatDateTime,
  fromDateTimeInputs,
  sameDay,
  startOfWeek,
  toDateInput,
  toTimeInput,
  weekDays,
  weekLabel,
} from './agenda-dates';
import {
  AgendaButton,
  PersonAvatar,
  STATUS_ORDER,
  STATUS_SHORT_LABELS,
  STATUS_STYLES,
  StatusBadge,
  StatusDot,
  firstName,
  useMediaQuery,
  useNow,
} from './agenda-ui';
import { AgendaWeek } from './AgendaWeek';
import { AgendaList } from './AgendaList';
import { AgendaRail, countByStatus, type RailAction } from './AgendaRail';
import { AgendaMobile } from './AgendaMobile';
import {
  VisitAttachmentsSection,
  VisitCheckSection,
  VisitReportSection,
  type ReturnVisitPrefill,
} from './VisitRecord';

type View = 'week' | 'list';

const VIEW_OPTIONS: Array<{ value: View; label: string }> = [
  { value: 'week', label: 'Semana' },
  { value: 'list', label: 'Lista' },
];

/** Responsáveis como chips até este número; acima, um seletor. */
const MAX_RESPONSIBLE_CHIPS = 6;

/**
 * Abertura de modal: visita completa, nova visita (com horário sugerido pela
 * grade ou, no "Agendar retorno" do CRMLAB-88, médico/responsável/tipo da
 * anterior) ou uma ação do painel lateral (reagendar/cancelar/não recebeu).
 */
type ModalState =
  | { kind: 'visit'; id: string }
  | { kind: 'new'; at: Date; prefill?: Omit<ReturnVisitPrefill, 'at'> }
  | { kind: 'action'; id: string; action: RailAction }
  | null;

/** Filtros da tela — todos aplicados no cliente sobre a semana inteira (D-262). */
interface Filters {
  responsibleId: string;
  doctorId: string;
  /** Chips de status desligados. Vazio = todos ligados. */
  hidden: VisitStatus[];
}

const NO_FILTERS: Filters = { responsibleId: '', doctorId: '', hidden: [] };

function applyFilters(visits: Visit[], filters: Filters): Visit[] {
  return visits.filter(
    (visit) =>
      (!filters.responsibleId || visit.responsible?.id === filters.responsibleId) &&
      (!filters.doctorId || visit.doctor.id === filters.doctorId) &&
      !filters.hidden.includes(visit.status),
  );
}

function activeFilterCount(filters: Filters): number {
  return (
    (filters.responsibleId ? 1 : 0) +
    (filters.doctorId ? 1 : 0) +
    (filters.hidden.length > 0 ? 1 : 0)
  );
}

function weekRange(weekStart: Date): ListVisitsQuery {
  return { from: weekStart.toISOString(), to: addDays(weekStart, WEEK_DAYS).toISOString() };
}

/**
 * Agenda de visitas — `/visitation/agenda` (PAGES.md §23 · API_CONTRACTS.md
 * §14 · CRMLAB-87, D-256 · repaginada no CRMLAB-92, D-262). Desktop: grade
 * semanal ou lista + coluna de resumo (≥ 1280px). Celular: um dia por vez.
 * A semana vem inteira do `GET /visits`; filtros e contagens saem dela.
 * Todo papel do laboratório vê e mexe em todas.
 */
export default function Agenda() {
  const isMobile = useMediaQuery('(max-width: 767px)');
  const isWide = useMediaQuery('(min-width: 1280px)');
  const now = useNow();
  const [view, setView] = useState<View>('week');
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [selectedDay, setSelectedDay] = useState(() => new Date());
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // `?visit=<id>` abre a visita direto — é o "Abrir visita" da ficha do médico (CRMLAB-89).
  // Com a coluna de resumo, a visita é selecionada nela; sem, abre o modal.
  const [searchParams, setSearchParams] = useSearchParams();
  const linkedVisitId = searchParams.get('visit');
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    isWide && !isMobile ? linkedVisitId : null,
  );
  const [modal, setModal] = useState<ModalState>(() =>
    linkedVisitId && !(isWide && !isMobile) ? { kind: 'visit', id: linkedVisitId } : null,
  );
  const [followLinked, setFollowLinked] = useState(Boolean(linkedVisitId));

  function clearLink() {
    if (searchParams.has('visit')) {
      const next = new URLSearchParams(searchParams);
      next.delete('visit');
      setSearchParams(next, { replace: true });
    }
  }

  /** Fechar a visita que veio pelo link também limpa o `?visit=`, para o voltar/recarregar não reabrir. */
  function closeModal() {
    setModal(null);
    clearLink();
  }

  function closeDetail() {
    setSelectedId(null);
    clearLink();
  }

  function goToWeek(start: Date) {
    setWeekStart(start);
    setSelectedId(null);
    setFollowLinked(false);
    setSelectedDay(sameDay(startOfWeek(now), start) ? now : start);
  }

  const range = useMemo(() => weekRange(weekStart), [weekStart]);
  const visitsQuery = useQuery({
    queryKey: queryKeys.visits(range),
    queryFn: () => visitsApi.list(range),
  });
  const weekVisits = useMemo(() => visitsQuery.data?.visits ?? [], [visitsQuery.data]);

  // "Hoje" no painel: se a semana na tela não é a atual, busca o dia à parte.
  const todayInWeek = sameDay(startOfWeek(now), weekStart);
  const todayKey = toDateInput(now); // muda só na virada do dia
  const todayRange = useMemo<ListVisitsQuery>(() => {
    const start = new Date(`${todayKey}T00:00:00`);
    return { from: start.toISOString(), to: addDays(start, 1).toISOString() };
  }, [todayKey]);
  const todayQuery = useQuery({
    queryKey: queryKeys.visits(todayRange),
    queryFn: () => visitsApi.list(todayRange),
    enabled: isWide && !isMobile && !todayInWeek,
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

  const visible = useMemo(() => applyFilters(weekVisits, filters), [weekVisits, filters]);
  const todayVisits = useMemo(
    () =>
      applyFilters(
        todayInWeek
          ? weekVisits.filter((visit) => sameDay(new Date(visit.scheduledAt), now))
          : (todayQuery.data?.visits ?? []),
        filters,
      ),
    [todayInWeek, weekVisits, todayQuery.data, filters, now],
  );
  const counts = useMemo(() => countByStatus(weekVisits), [weekVisits]);

  // Visita selecionada: da semana, de "Hoje" ou (link de outra semana) buscada à parte.
  const listed = selectedId
    ? (weekVisits.find((v) => v.id === selectedId) ??
      todayQuery.data?.visits.find((v) => v.id === selectedId) ??
      null)
    : null;
  const selectedQuery = useQuery({
    queryKey: queryKeys.visit(selectedId ?? ''),
    queryFn: () => visitsApi.get(selectedId ?? ''),
    enabled: Boolean(selectedId) && !listed,
  });
  const selected: Visit | null = listed ?? (selectedId ? (selectedQuery.data ?? null) : null);

  // O link de uma visita de outra semana leva a grade até ela (uma vez).
  if (followLinked && selected && selectedId === linkedVisitId) {
    const start = startOfWeek(new Date(selected.scheduledAt));
    setFollowLinked(false);
    if (!sameDay(start, weekStart)) {
      setWeekStart(start);
      setSelectedDay(new Date(selected.scheduledAt));
    }
  }

  function openVisit(visit: Visit) {
    if (isWide && !isMobile) {
      setSelectedId(visit.id);
      const start = startOfWeek(new Date(visit.scheduledAt));
      if (!sameDay(start, weekStart)) {
        setWeekStart(start);
        setSelectedDay(new Date(visit.scheduledAt));
      }
    } else {
      setModal({ kind: 'visit', id: visit.id });
    }
  }

  const newVisit = () => setModal({ kind: 'new', at: defaultNewVisitTime(weekStart) });
  const days = weekDays(weekStart);
  const emptyState: 'none' | 'week' | 'filtered' =
    weekVisits.length === 0 ? 'week' : visible.length === 0 ? 'filtered' : 'none';

  const filterBar = (
    <FilterBar
      filters={filters}
      counts={counts}
      assignees={assignees}
      doctors={doctors}
      onChange={setFilters}
      stacked={isMobile}
    />
  );

  const modals = (
    <>
      {modal?.kind === 'new' && (
        <VisitFormModal
          initialAt={modal.at}
          prefill={modal.prefill}
          assignees={assignees}
          doctors={doctors}
          onClose={closeModal}
          onSaved={closeModal}
        />
      )}
      {modal?.kind === 'visit' && (
        <VisitModal
          id={modal.id}
          assignees={assignees}
          doctors={doctors}
          onClose={closeModal}
          onScheduleReturn={({ at, ...prefill }) => setModal({ kind: 'new', at, prefill })}
        />
      )}
      {modal?.kind === 'action' && (
        <VisitActionById id={modal.id} action={modal.action} onClose={() => setModal(null)} />
      )}
      {filtersOpen && (
        <Modal open onClose={() => setFiltersOpen(false)} title="Filtros">
          <div className="flex flex-col gap-lg">
            {filterBar}
            <div className="flex justify-between gap-md">
              <Button variant="secondary" onClick={() => setFilters(NO_FILTERS)}>
                Limpar filtros
              </Button>
              <Button variant="primary" onClick={() => setFiltersOpen(false)}>
                Ver visitas
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );

  if (isMobile) {
    return (
      <>
        <AgendaMobile
          weekStart={weekStart}
          days={days}
          now={now}
          selectedDay={days.some((day) => sameDay(day, selectedDay)) ? selectedDay : weekStart}
          visits={visible}
          activeFilters={activeFilterCount(filters)}
          onSelectDay={setSelectedDay}
          onPrevWeek={() => goToWeek(addDays(weekStart, -WEEK_DAYS))}
          onNextWeek={() => goToWeek(addDays(weekStart, WEEK_DAYS))}
          onOpenFilters={() => setFiltersOpen(true)}
          onNew={newVisit}
          onOpen={(visit) => setModal({ kind: 'visit', id: visit.id })}
        />
        {modals}
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 md:h-screen">
      <div className="flex min-w-0 flex-1 flex-col gap-lg px-[28px] py-xl">
        <PageHeader
          title="Agenda de visitas"
          description="Visitas da equipe aos médicos solicitantes."
          size="compact"
          className="items-end"
          actions={
            <AgendaButton variant="primary" className="px-[18px]" onClick={newVisit}>
              + Nova visita
            </AgendaButton>
          }
        />

        <div className="flex flex-wrap items-center justify-between gap-md">
          <div className="flex flex-wrap items-center gap-md">
            <PeriodNav
              onPrev={() => goToWeek(addDays(weekStart, -WEEK_DAYS))}
              onToday={() => goToWeek(startOfWeek(new Date()))}
              onNext={() => goToWeek(addDays(weekStart, WEEK_DAYS))}
            />
            <span
              className="text-[18px] font-semibold tabular-nums text-agenda-ink"
              data-testid="week-label"
            >
              {weekLabel(weekStart)}
            </span>
          </div>
          <ViewSwitch value={view} onChange={setView} />
        </div>

        {filterBar}

        {visitsQuery.data?.truncated && (
          <p className="text-caption text-agenda-muted">
            A semana tem visitas demais para mostrar todas. Use os filtros para refinar.
          </p>
        )}

        {visitsQuery.isLoading ? (
          <AgendaSkeleton />
        ) : visitsQuery.isError ? (
          <EmptyState
            message="Não foi possível carregar as visitas"
            hint="Verifique a conexão e tente novamente."
          />
        ) : view === 'week' ? (
          <AgendaWeek
            days={days}
            now={now}
            visits={visible}
            selectedId={selectedId}
            emptyState={emptyState}
            onOpen={openVisit}
            onSlot={(at) => setModal({ kind: 'new', at })}
            onClearFilters={() => setFilters(NO_FILTERS)}
          />
        ) : visible.length === 0 ? (
          <EmptyCard state={emptyState} onClearFilters={() => setFilters(NO_FILTERS)} />
        ) : (
          <AgendaList
            days={days}
            now={now}
            visits={visible}
            selectedId={selectedId}
            onOpen={openVisit}
          />
        )}
      </div>

      {isWide && (
        <AgendaRail
          weekVisits={weekVisits}
          todayVisits={todayVisits}
          today={now}
          selected={selected}
          onSelect={openVisit}
          onCloseDetail={closeDetail}
          onOpenFull={(visit) => setModal({ kind: 'visit', id: visit.id })}
          onAction={(visit, action) => setModal({ kind: 'action', id: visit.id, action })}
          onScheduleReturn={({ at, ...prefill }) => setModal({ kind: 'new', at, prefill })}
        />
      )}
      {modals}
    </div>
  );
}

/** "+ Nova visita" sem clicar na grade: hoje (se a semana é a atual) ou a segunda, às 9h. */
function defaultNewVisitTime(weekStart: Date): Date {
  const now = new Date();
  const base = sameDay(startOfWeek(now), weekStart) ? now : weekStart;
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), 9, 0);
}

function PeriodNav({
  onPrev,
  onToday,
  onNext,
}: {
  onPrev: () => void;
  onToday: () => void;
  onNext: () => void;
}) {
  const item =
    'inline-flex items-center justify-center text-agenda-ink-2 hover:bg-agenda-press focus-visible:relative focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';
  return (
    <div
      className="inline-flex overflow-hidden rounded-md border border-agenda-line-control bg-bg"
      role="group"
      aria-label="Período"
    >
      <button
        type="button"
        aria-label="Semana anterior"
        onClick={onPrev}
        className={cn(item, 'px-md py-sm text-[16px]')}
      >
        ‹
      </button>
      <button
        type="button"
        onClick={onToday}
        className={cn(
          item,
          'border-x border-agenda-line-control px-[14px] py-sm text-body font-semibold text-agenda-ink',
        )}
      >
        Hoje
      </button>
      <button
        type="button"
        aria-label="Próxima semana"
        onClick={onNext}
        className={cn(item, 'px-md py-sm text-[16px]')}
      >
        ›
      </button>
    </div>
  );
}

function ViewSwitch({ value, onChange }: { value: View; onChange: (view: View) => void }) {
  return (
    <div
      role="tablist"
      aria-label="Visão da agenda"
      className="inline-flex gap-[2px] rounded-md bg-agenda-seg p-[3px]"
    >
      {VIEW_OPTIONS.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-sm px-[14px] py-[6px] text-body font-semibold transition-colors',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              active
                ? 'bg-bg text-agenda-ink shadow-[0_1px_2px_rgba(0,0,0,.1)]'
                : 'text-agenda-muted hover:text-agenda-ink',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

interface FilterBarProps {
  filters: Filters;
  counts: Record<VisitStatus, number>;
  assignees: Person[];
  doctors: Person[];
  onChange: (filters: Filters) => void;
  /** No celular (dentro do modal de filtros): um grupo por linha. */
  stacked: boolean;
}

/** Chips de status (filtro + legenda + contagem da semana), responsável e médico. */
function FilterBar({ filters, counts, assignees, doctors, onChange, stacked }: FilterBarProps) {
  const divider = !stacked && (
    <span aria-hidden="true" className="h-5 w-px bg-agenda-line-control" />
  );
  const label = (text: string) => (
    <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-agenda-muted">
      {text}
    </span>
  );
  const group = cn('flex flex-wrap items-center gap-sm', stacked && 'flex-col items-start');

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-sm',
        stacked && 'flex-col items-stretch gap-lg',
      )}
      data-testid="agenda-filters"
    >
      <div className={group} role="group" aria-label="Status">
        {label('Status')}
        <div className="flex flex-wrap gap-sm">
          {STATUS_ORDER.map((status) => {
            const on = !filters.hidden.includes(status);
            return (
              <button
                key={status}
                type="button"
                aria-pressed={on}
                title={VISIT_STATUS_LABELS[status]}
                onClick={() =>
                  onChange({
                    ...filters,
                    hidden: on
                      ? [...filters.hidden, status]
                      : filters.hidden.filter((s) => s !== status),
                  })
                }
                className={cn(
                  'inline-flex items-center gap-[6px] rounded-pill border px-[10px] py-[5px] text-body transition-opacity',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                  on
                    ? cn('border-transparent', STATUS_STYLES[status].bg, STATUS_STYLES[status].ink)
                    : 'border-agenda-line-control bg-bg text-agenda-ink opacity-50',
                )}
              >
                <StatusDot status={status} size={8} />
                {STATUS_SHORT_LABELS[status]}
                <span className="font-semibold tabular-nums">{counts[status]}</span>
              </button>
            );
          })}
        </div>
      </div>
      {divider}
      <div className={group}>
        {label('Responsável')}
        {assignees.length <= MAX_RESPONSIBLE_CHIPS ? (
          <div className="flex flex-wrap gap-sm" role="group" aria-label="Filtrar por responsável">
            {assignees.map((person) => {
              const on = filters.responsibleId === person.id;
              return (
                <button
                  key={person.id}
                  type="button"
                  aria-pressed={on}
                  title={person.name}
                  onClick={() => onChange({ ...filters, responsibleId: on ? '' : person.id })}
                  className={cn(
                    'inline-flex items-center gap-[6px] rounded-pill border bg-bg py-[3px] pl-[3px] pr-[10px] text-body text-agenda-ink transition-opacity',
                    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                    on ? 'border-agenda-ink' : 'border-agenda-line-control',
                    filters.responsibleId && !on && 'opacity-50',
                  )}
                >
                  <PersonAvatar person={person} size={22} />
                  {firstName(person.name)}
                </button>
              );
            })}
          </div>
        ) : (
          <PillSelect
            label="Filtrar por responsável"
            prefix="Responsável"
            value={filters.responsibleId}
            options={assignees}
            onChange={(responsibleId) => onChange({ ...filters, responsibleId })}
          />
        )}
      </div>
      {divider}
      <div className={group}>
        {stacked && label('Médico')}
        <PillSelect
          label="Filtrar por médico"
          prefix="Médico"
          value={filters.doctorId}
          options={doctors}
          onChange={(doctorId) => onChange({ ...filters, doctorId })}
        />
      </div>
    </div>
  );
}

function PillSelect({
  label,
  prefix,
  value,
  options,
  onChange,
}: {
  label: string;
  prefix: string;
  value: string;
  options: Person[];
  onChange: (value: string) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        'max-w-[260px] cursor-pointer truncate rounded-pill border bg-bg px-md py-[5px] text-body text-agenda-ink',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        value ? 'border-agenda-ink' : 'border-agenda-line-control',
      )}
    >
      <option value="">{prefix}: Todos</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.name}
        </option>
      ))}
    </select>
  );
}

function EmptyCard({
  state,
  onClearFilters,
}: {
  state: 'none' | 'week' | 'filtered';
  onClearFilters: () => void;
}) {
  return (
    <div className="flex flex-1 items-start justify-center rounded-lg border border-agenda-line bg-bg p-xl">
      <div className="flex flex-col items-center gap-xs text-center">
        <p className="text-[14px] font-semibold text-agenda-ink">
          {state === 'filtered'
            ? 'Nenhuma visita com esses filtros'
            : 'Nenhuma visita nesta semana'}
        </p>
        {state === 'filtered' ? (
          <button
            type="button"
            className="text-body font-semibold text-accent-700 hover:underline"
            onClick={onClearFilters}
          >
            Limpar filtros
          </button>
        ) : (
          <p className="text-body text-agenda-muted">Use “+ Nova visita” para agendar.</p>
        )}
      </div>
    </div>
  );
}

function AgendaSkeleton() {
  return (
    <div
      className="flex flex-1 flex-col gap-md rounded-lg border border-agenda-line bg-bg p-lg"
      aria-busy="true"
      aria-label="Carregando visitas"
      data-testid="agenda-skeleton"
    >
      <div className="h-8 animate-pulse rounded-md bg-agenda-seg" />
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="h-12 animate-pulse rounded-md bg-agenda-alt" />
      ))}
    </div>
  );
}

/** Ação vinda do painel lateral: carrega a visita e abre o formulário da ação. */
function VisitActionById({
  id,
  action,
  onClose,
}: {
  id: string;
  action: RailAction;
  onClose: () => void;
}) {
  const visitQuery = useQuery({ queryKey: queryKeys.visit(id), queryFn: () => visitsApi.get(id) });
  if (!visitQuery.data) return null;
  return <VisitActionModal visit={visitQuery.data} action={action} onClose={onClose} />;
}

type Person = { id: string; name: string };

/** Opções de seleção com o valor atual garantido (médico/responsável inativo continua aparecendo). */
function withCurrent(options: Person[], current: Person | null | undefined, suffix: string) {
  const list = options.map((o) => ({ value: o.id, label: o.name }));
  if (current && !options.some((o) => o.id === current.id)) {
    list.push({ value: current.id, label: `${current.name} ${suffix}`.trim() });
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
  /** "Agendar retorno" (CRMLAB-88): só pré-preenche; nada é criado sem confirmar. */
  prefill?: Omit<ReturnVisitPrefill, 'at'>;
  assignees: Person[];
  doctors: Person[];
  onClose: () => void;
  onSaved: () => void;
}

/** Criar (com data/hora) ou editar (médico, responsável, tipo, pauta — a data muda por "Reagendar"). */
function VisitFormModal({
  visit,
  initialAt,
  prefill,
  assignees,
  doctors,
  onClose,
  onSaved,
}: VisitFormModalProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const user = useCurrentUser();
  const { fieldErrors, setFieldErrors, onError } = useFieldErrors();
  const isEdit = visit !== undefined;
  const at = initialAt ?? new Date();

  const [doctorId, setDoctorId] = useState(visit?.doctor.id ?? prefill?.doctor.id ?? '');
  const [responsibleId, setResponsibleId] = useState(() => {
    if (visit) return visit.responsible?.id ?? '';
    if (prefill?.responsibleId && assignees.some((a) => a.id === prefill.responsibleId))
      return prefill.responsibleId;
    return assignees.some((a) => a.id === user?.id) ? (user?.id ?? '') : '';
  });
  const [day, setDay] = useState(toDateInput(at));
  const [time, setTime] = useState(toTimeInput(at));
  const [type, setType] = useState<VisitType>(visit?.type ?? prefill?.type ?? 'presencial');
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
    if (!isEdit && fromDateTimeInputs(day, time) === null)
      errors.scheduledAt = 'Informe data e hora';
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
      title={isEdit ? 'Editar visita' : prefill ? 'Agendar retorno' : 'Nova visita'}
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
            options={withCurrent(
              doctors,
              visit?.doctor ?? prefill?.doctor,
              // No retorno o médico pode só estar fora dos 100 do seletor.
              visit || prefill?.doctor.isActive === false ? '(inativo)' : '',
            )}
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
            <Input
              label="Hora"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
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
  onScheduleReturn: (prefill: ReturnVisitPrefill) => void;
}

/**
 * Visita aberta: registro (check-in/out, CRMLAB-88), detalhe, relato, anexos e
 * histórico de datas; editar/reagendar/encerrar só enquanto `agendada`.
 */
function VisitModal({ id, assignees, doctors, onClose, onScheduleReturn }: VisitModalProps) {
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
            {/* Depois do check-in a data não muda mais (D-258 item 4). */}
            {visit?.checkInAt === null && (
              <Button variant="secondary" onClick={() => setMode('reschedule')}>
                Reagendar
              </Button>
            )}
            <Button variant="primary" onClick={() => setMode('edit')}>
              Editar
            </Button>
          </div>
        ) : undefined
      }
    >
      {!visit ? (
        <p className="text-body text-neutral-600">
          {visitQuery.isError ? 'Não foi possível carregar a visita.' : 'Carregando...'}
        </p>
      ) : (
        <div className="flex flex-col gap-lg">
          <div className="flex flex-wrap items-start justify-between gap-md">
            <div className="min-w-0">
              <div className="font-heading text-section text-text">{visit.doctor.name}</div>
              <div className="text-caption text-neutral-600">
                {[
                  visit.doctor.crm ? `CRM ${visit.doctor.crm}/${visit.doctor.crmUf ?? ''}` : null,
                  visit.doctor.specialty,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            <StatusBadge status={visit.status} />
          </div>

          <VisitCheckSection visit={visit} />

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

          {/* `key`: o formulário do relato recomeça quando a visita muda no servidor. */}
          <VisitReportSection
            key={visit.updatedAt}
            visit={visit}
            onScheduleReturn={onScheduleReturn}
          />
          <VisitAttachmentsSection visit={visit} />

          {visit.reschedules.length > 0 && (
            <section className="flex flex-col gap-sm">
              <h3 className="font-heading text-label font-semibold text-text">
                Histórico de datas
              </h3>
              <ul
                className="flex flex-col gap-xs text-caption text-text"
                data-testid="visit-reschedules"
              >
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
function VisitActionModal({
  visit,
  action,
  onClose,
}: {
  visit: VisitDetail;
  action: VisitAction;
  onClose: () => void;
}) {
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
      toast(action === 'reschedule' ? 'Visita reagendada' : VISIT_STATUS_LABELS[updated.status], {
        tone: 'positive',
      });
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
            <Input
              label="Nova hora"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
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
