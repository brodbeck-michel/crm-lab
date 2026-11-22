import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { DOCTOR_ABC_CLASSES, type Doctor, type DoctorAbcClass, type ListDoctorsQuery } from '@crm-lab/shared';
import { doctorsApi } from '@/api/doctors';
import { queryKeys, queryScopes } from '@/api/query-keys';
import { useApiErrorHandler } from '@/hooks';
import { useAuthStore } from '@/stores/auth.store';
import { PageContainer, PageHeader } from '@/components/layout';
import { DataTable, EmptyState, Pagination } from '@/components/shared';
import type { DataTableColumn } from '@/components/shared';
import { Button, Chip, SearchInput, SegmentedControl, Select, useToast } from '@/components/ui';
import { DoctorModal } from './DoctorModal';
import { AbcBadge } from './doctor-ui';
import { useVisitationResponsibles } from './visitation-access';

export { DoctorModal } from './DoctorModal';
export type { DoctorModalProps } from './DoctorModal';

const PAGE_SIZE = 20;

/** Valor do filtro "Sem responsável / responsável inelegível" (`?unassigned=true`, D-329). */
export const UNASSIGNED_FILTER = '__unassigned__';

type StatusFilter = 'active' | 'inactive' | 'all';

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'active', label: 'Ativos' },
  { value: 'inactive', label: 'Inativos' },
  { value: 'all', label: 'Todos' },
];

/** `12345/SC`, ou `—` sem CRM. */
export function crmLabel(doctor: Pick<Doctor, 'crm' | 'crmUf'>): string {
  return doctor.crm ? `${doctor.crm}/${doctor.crmUf ?? ''}` : '—';
}

/**
 * Médicos — `/visitation/doctors` (PAGES.md §22 · API_CONTRACTS.md §13 ·
 * CRMLAB-86, D-255). Primeira tela do grupo "Visitação Médica"; a agenda
 * (`/visitation/agenda`) vem nos próximos cards do épico CRMLAB-85.
 *
 * D-329: representante (só a própria carteira — o servidor recorta), gestor e
 * admin. O filtro por responsável (com "Sem responsável / inelegível") e o
 * recálculo da curva ABC (CRMLAB-188, D-328) são só de gestor/admin.
 * Responsiva: tabela a partir de `md`, cartões abaixo
 * (a `DataTable` rola na horizontal, o que no celular esconde as ações).
 */
export default function Doctors() {
  const queryClient = useQueryClient();
  const handleApiError = useApiErrorHandler();
  const { toast } = useToast();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('active');
  const [responsibleId, setResponsibleId] = useState('');
  const [specialtyId, setSpecialtyId] = useState('');
  const [abcClass, setAbcClass] = useState<DoctorAbcClass | ''>('');
  const [editing, setEditing] = useState<Doctor | null>(null);
  const [creating, setCreating] = useState(false);

  const filters = useMemo<ListDoctorsQuery>(
    () => ({
      page,
      limit: PAGE_SIZE,
      ...(search.trim().length > 0 ? { search: search.trim() } : {}),
      ...(status !== 'all' ? { active: status === 'active' } : {}),
      ...(responsibleId === UNASSIGNED_FILTER
        ? { unassigned: true }
        : responsibleId
          ? { responsibleId }
          : {}),
      ...(specialtyId ? { specialtyId } : {}),
      ...(abcClass ? { abcClass } : {}),
    }),
    [page, search, status, responsibleId, specialtyId, abcClass],
  );

  const doctorsQuery = useQuery({
    queryKey: queryKeys.doctors(filters),
    queryFn: () => doctorsApi.list(filters),
  });

  // Responsáveis elegíveis (D-329); para o representante, só ele mesmo.
  const { seesAll, responsibles: assignees } = useVisitationResponsibles();

  const specialtiesQuery = useQuery({
    queryKey: queryKeys.doctorSpecialties(),
    queryFn: () => doctorsApi.specialties(),
  });
  const specialties = specialtiesQuery.data?.specialties ?? [];

  const role = useAuthStore((s) => s.user?.role);
  const canRecalculate = role === 'manager' || role === 'admin';

  const recalculate = useMutation({
    mutationFn: () => doctorsApi.recalculateAbc(),
    onSuccess: (result) => {
      toast(`Curva ABC recalculada: ${result.counts.A} A · ${result.counts.B} B · ${result.counts.C} C`, {
        tone: 'positive',
      });
      void queryClient.invalidateQueries({ queryKey: queryScopes.doctors });
    },
    onError: handleApiError,
  });

  const toggleActive = useMutation({
    mutationFn: (doctor: Doctor) =>
      doctor.isActive ? doctorsApi.inactivate(doctor.id) : doctorsApi.reactivate(doctor.id),
    onSuccess: (doctor) => {
      toast(doctor.isActive ? 'Médico reativado' : 'Médico inativado', { tone: 'positive' });
      void queryClient.invalidateQueries({ queryKey: queryScopes.doctors });
    },
    onError: handleApiError,
  });

  const doctors = doctorsQuery.data?.doctors ?? [];
  const pagination = doctorsQuery.data?.pagination;

  function openEdit(doctor: Doctor) {
    setEditing(doctor);
    setCreating(false);
  }

  function closeModal() {
    setEditing(null);
    setCreating(false);
  }

  function actions(doctor: Doctor) {
    return (
      <div className="flex flex-wrap justify-end gap-sm">
        <Button variant="secondary" size="sm" onClick={() => openEdit(doctor)}>
          Editar
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => toggleActive.mutate(doctor)}
          disabled={toggleActive.isPending}
          aria-label={`${doctor.isActive ? 'Inativar' : 'Reativar'} ${doctor.name}`}
        >
          {doctor.isActive ? 'Inativar' : 'Reativar'}
        </Button>
      </div>
    );
  }

  const columns: Array<DataTableColumn<Doctor>> = [
    {
      key: 'name',
      header: 'Nome',
      minWidth: 220,
      render: (doctor) => (
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-sm">
            <Link to={`/visitation/doctors/${doctor.id}`} className="block truncate font-semibold text-text hover:underline">
              {doctor.name}
            </Link>
            <AbcBadge doctor={doctor} />
          </div>
          {doctor.specialty && <div className="truncate text-caption text-neutral-600">{doctor.specialty}</div>}
        </div>
      ),
    },
    {
      key: 'crm',
      header: 'CRM',
      render: (doctor) => <span className="whitespace-nowrap tabular-nums">{crmLabel(doctor)}</span>,
    },
    { key: 'clinic', header: 'Clínica', render: (doctor) => doctor.clinic ?? '—' },
    {
      key: 'phone',
      header: 'Telefone',
      render: (doctor) => <span className="whitespace-nowrap tabular-nums">{doctor.phone ?? '—'}</span>,
    },
    { key: 'responsible', header: 'Responsável', render: (doctor) => doctor.responsible?.name ?? '—' },
    {
      key: 'status',
      header: 'Status',
      render: (doctor) => (
        <Chip tone={doctor.isActive ? 'positive' : 'inactive'}>{doctor.isActive ? 'Ativo' : 'Inativo'}</Chip>
      ),
    },
    { key: 'actions', header: 'Ações', align: 'right', render: actions },
  ];

  return (
    <PageContainer>
      <PageHeader
        title="Médicos"
        description="Médicos solicitantes do laboratório e quem cuida de cada carteira."
        actions={
          <div className="flex flex-wrap gap-sm">
            {canRecalculate && (
              <Button variant="secondary" onClick={() => recalculate.mutate()} loading={recalculate.isPending}>
                Recalcular curva ABC
              </Button>
            )}
            <Button variant="primary" onClick={() => setCreating(true)}>
              + Novo médico
            </Button>
          </div>
        }
      />

      <div className="flex flex-col gap-md md:flex-row md:flex-wrap md:items-end">
        <div className="w-full md:max-w-md md:flex-1">
          <SearchInput
            placeholder="Buscar por nome ou CRM"
            aria-label="Buscar médico"
            onSearch={(term) => {
              setSearch(term);
              setPage(1);
            }}
          />
        </div>
        {seesAll && (
          <div className="w-full md:w-64">
            <Select
              aria-label="Filtrar por responsável"
              value={responsibleId}
              onChange={(event) => {
                setResponsibleId(event.target.value);
                setPage(1);
              }}
              options={[
                { value: '', label: 'Todos os responsáveis' },
                { value: UNASSIGNED_FILTER, label: 'Sem responsável / responsável inelegível' },
                ...assignees.map((a) => ({ value: a.id, label: a.name })),
              ]}
            />
          </div>
        )}
        <div className="w-full md:w-64">
          <Select
            aria-label="Filtrar por especialidade"
            value={specialtyId}
            onChange={(event) => {
              setSpecialtyId(event.target.value);
              setPage(1);
            }}
            options={[
              { value: '', label: 'Todas as especialidades' },
              ...specialties.map((s) => ({ value: s.id, label: s.isActive ? s.name : `${s.name} (inativa)` })),
            ]}
          />
        </div>
        <div className="w-full md:w-48">
          <Select
            aria-label="Filtrar por curva ABC"
            value={abcClass}
            onChange={(event) => {
              setAbcClass(event.target.value as DoctorAbcClass | '');
              setPage(1);
            }}
            options={[
              { value: '', label: 'Curva ABC: todas' },
              ...DOCTOR_ABC_CLASSES.map((cls) => ({ value: cls, label: `Curva ABC: ${cls}` })),
            ]}
          />
        </div>
        <SegmentedControl
          aria-label="Situação do cadastro"
          fullWidth={false}
          options={STATUS_OPTIONS}
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
        />
      </div>

      {doctorsQuery.isLoading ? (
        <p className="font-body text-body text-neutral-600">Carregando médicos...</p>
      ) : doctorsQuery.isError ? (
        <EmptyState message="Não foi possível carregar os médicos" hint="Verifique a conexão e tente novamente." />
      ) : doctors.length === 0 ? (
        <EmptyState
          message="Nenhum médico encontrado"
          hint={search || responsibleId || specialtyId || abcClass || status !== 'active' ? 'Ajuste a busca ou os filtros.' : 'Cadastre o primeiro médico.'}
        />
      ) : (
        <>
          <div className="hidden md:block" data-testid="doctors-table">
            <DataTable
              columns={columns}
              rows={doctors}
              rowKey={(doctor) => doctor.id}
              minWidth={960}
            />
          </div>

          <ul className="flex flex-col gap-md md:hidden" data-testid="doctors-cards">
            {doctors.map((doctor) => (
              <li
                key={doctor.id}
                className="rounded-lg border border-neutral-200 bg-neutral-100 p-lg shadow-sm"
              >
                <div className="flex items-start justify-between gap-md">
                  <div className="min-w-0">
                    <div className="flex items-center gap-sm">
                      <Link to={`/visitation/doctors/${doctor.id}`} className="font-semibold text-text hover:underline">
                        {doctor.name}
                      </Link>
                      <AbcBadge doctor={doctor} />
                    </div>
                    <div className="text-caption text-neutral-600">
                      {[doctor.crm ? `CRM ${crmLabel(doctor)}` : null, doctor.specialty].filter(Boolean).join(' · ') ||
                        'Sem CRM'}
                    </div>
                  </div>
                  <Chip tone={doctor.isActive ? 'positive' : 'inactive'}>
                    {doctor.isActive ? 'Ativo' : 'Inativo'}
                  </Chip>
                </div>
                <dl className="mt-md space-y-xs text-caption text-text">
                  {doctor.clinic && <div>{doctor.clinic}</div>}
                  {doctor.phone && <div className="tabular-nums">{doctor.phone}</div>}
                  <div className="text-neutral-600">Responsável: {doctor.responsible?.name ?? '—'}</div>
                </dl>
                <div className="mt-md">{actions(doctor)}</div>
              </li>
            ))}
          </ul>

          {pagination && <Pagination pagination={pagination} onPageChange={setPage} itemLabel="médicos" />}
        </>
      )}

      {(creating || editing) && (
        <DoctorModal doctor={editing ?? undefined} assignees={assignees} onClose={closeModal} />
      )}
    </PageContainer>
  );
}
