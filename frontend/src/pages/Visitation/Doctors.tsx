import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BRAZIL_UFS,
  normalizeCrm,
  type CreateDoctorRequest,
  type Doctor,
  type DoctorCrmConflictDetails,
  type ListDoctorsQuery,
} from '@crm-lab/shared';
import { doctorsApi } from '@/api/doctors';
import { conversationsApi } from '@/api/conversations';
import { isApiError } from '@/api/client';
import { mapFieldErrors } from '@/api/error-handler';
import { queryKeys, queryScopes } from '@/api/query-keys';
import { useApiErrorHandler } from '@/hooks';
import { PageContainer, PageHeader } from '@/components/layout';
import { DataTable, EmptyState, Modal, Pagination } from '@/components/shared';
import type { DataTableColumn } from '@/components/shared';
import { Button, Chip, Input, SearchInput, SegmentedControl, Select, TextArea, useToast } from '@/components/ui';

const PAGE_SIZE = 20;

type StatusFilter = 'active' | 'inactive' | 'all';

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'active', label: 'Ativos' },
  { value: 'inactive', label: 'Inativos' },
  { value: 'all', label: 'Todos' },
];

/** `12345/SC`, ou `—` sem CRM. */
function crmLabel(doctor: Pick<Doctor, 'crm' | 'crmUf'>): string {
  return doctor.crm ? `${doctor.crm}/${doctor.crmUf ?? ''}` : '—';
}

/**
 * Médicos — `/visitation/doctors` (PAGES.md §22 · API_CONTRACTS.md §13 ·
 * CRMLAB-86, D-255). Primeira tela do grupo "Visitação Médica"; a agenda
 * (`/visitation/agenda`) vem nos próximos cards do épico CRMLAB-85.
 *
 * Todo papel do laboratório vê, cadastra, edita e inativa — não há controle
 * a esconder por perfil. Responsiva: tabela a partir de `md`, cartões abaixo
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
  const [editing, setEditing] = useState<Doctor | null>(null);
  const [creating, setCreating] = useState(false);

  const filters = useMemo<ListDoctorsQuery>(
    () => ({
      page,
      limit: PAGE_SIZE,
      ...(search.trim().length > 0 ? { search: search.trim() } : {}),
      ...(status !== 'all' ? { active: status === 'active' } : {}),
      ...(responsibleId ? { responsibleId } : {}),
    }),
    [page, search, status, responsibleId],
  );

  const doctorsQuery = useQuery({
    queryKey: queryKeys.doctors(filters),
    queryFn: () => doctorsApi.list(filters),
  });

  // Usuários ativos do laboratório, qualquer papel (`GET /users` é admin-only).
  const assigneesQuery = useQuery({
    queryKey: queryKeys.conversationAssignees(),
    queryFn: () => conversationsApi.assignees(),
  });
  const assignees = assigneesQuery.data?.assignees ?? [];

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
          <div className="truncate font-semibold text-text">{doctor.name}</div>
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
          <Button variant="primary" onClick={() => setCreating(true)}>
            + Novo médico
          </Button>
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
              ...assignees.map((a) => ({ value: a.id, label: a.name })),
            ]}
          />
        </div>
        <SegmentedControl
          aria-label="Situação do cadastro"
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
          hint={search || responsibleId || status !== 'active' ? 'Ajuste a busca ou os filtros.' : 'Cadastre o primeiro médico.'}
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
                    <div className="font-semibold text-text">{doctor.name}</div>
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

interface DoctorModalProps {
  doctor?: Doctor;
  assignees: Array<{ id: string; name: string }>;
  onClose: () => void;
}

interface DoctorForm {
  name: string;
  crm: string;
  crmUf: string;
  specialty: string;
  clinic: string;
  address: string;
  phone: string;
  email: string;
  contactName: string;
  visitPreference: string;
  notes: string;
  responsibleId: string;
}

function toForm(doctor?: Doctor): DoctorForm {
  return {
    name: doctor?.name ?? '',
    crm: doctor?.crm ?? '',
    crmUf: doctor?.crmUf ?? '',
    specialty: doctor?.specialty ?? '',
    clinic: doctor?.clinic ?? '',
    address: doctor?.address ?? '',
    phone: doctor?.phone ?? '',
    email: doctor?.email ?? '',
    contactName: doctor?.contactName ?? '',
    visitPreference: doctor?.visitPreference ?? '',
    notes: doctor?.notes ?? '',
    responsibleId: doctor?.responsible?.id ?? '',
  };
}

/** Mensagem do 409: diz quem já usa o CRM e, se inativo, que o caminho é reativar. */
function crmConflictMessage(details: Record<string, unknown> | undefined): string {
  const existing = (details as Partial<DoctorCrmConflictDetails> | undefined)?.existingDoctor;
  if (!existing?.name) return 'Já existe um médico com este CRM e UF.';
  return existing.isActive
    ? `CRM já cadastrado para ${existing.name}.`
    : `CRM já cadastrado para ${existing.name} (inativo). Reative o cadastro em vez de criar outro.`;
}

function DoctorModal({ doctor, assignees, onClose }: DoctorModalProps) {
  const queryClient = useQueryClient();
  const handleApiError = useApiErrorHandler();
  const { toast } = useToast();
  const isEdit = doctor !== undefined;

  const [form, setForm] = useState<DoctorForm>(() => toForm(doctor));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: (body: CreateDoctorRequest) =>
      doctor ? doctorsApi.update(doctor.id, body) : doctorsApi.create(body),
    onSuccess: () => {
      toast(isEdit ? 'Médico atualizado' : 'Médico cadastrado', { tone: 'positive' });
      void queryClient.invalidateQueries({ queryKey: queryScopes.doctors });
      onClose();
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'DOCTOR_CRM_ALREADY_EXISTS') {
        setFieldErrors({ crm: crmConflictMessage(error.details) });
        return;
      }
      if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
        const fields = mapFieldErrors(error.details);
        if (Object.keys(fields).length > 0) {
          setFieldErrors(fields);
          return;
        }
      }
      handleApiError(error);
    },
  });

  function set<K extends keyof DoctorForm>(field: K, value: DoctorForm[K]) {
    setForm((current) => ({ ...current, [field]: value }));
    if (fieldErrors[field]) {
      setFieldErrors(({ [field]: _removed, ...rest }) => rest);
    }
  }

  function handleSubmit(event?: React.FormEvent) {
    event?.preventDefault();
    // Mesma regra do servidor (D-255), só para não gastar a ida: o backend valida de novo.
    const errors: Record<string, string> = {};
    if (form.name.trim().length === 0) errors.name = 'Informe o nome';
    if (normalizeCrm(form.crm) !== null && form.crmUf === '') errors.crmUf = 'Informe a UF do CRM';
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    // Vazio vai como `null`: no PATCH isso limpa o campo, no POST é o mesmo que ausente.
    const orNull = (value: string) => (value.trim().length > 0 ? value.trim() : null);
    save.mutate({
      name: form.name.trim(),
      crm: orNull(form.crm),
      crmUf: orNull(form.crmUf),
      specialty: orNull(form.specialty),
      clinic: orNull(form.clinic),
      address: orNull(form.address),
      phone: orNull(form.phone),
      email: orNull(form.email),
      contactName: orNull(form.contactName),
      visitPreference: orNull(form.visitPreference),
      notes: orNull(form.notes),
      responsibleId: form.responsibleId || null,
    });
  }

  // O responsável atual pode ter sido desativado e sumir da lista de ativos:
  // ele continua aparecendo para o formulário não trocar a carteira sozinho.
  const responsibleOptions = [
    { value: '', label: 'Sem responsável' },
    ...assignees.map((a) => ({ value: a.id, label: a.name })),
  ];
  if (doctor?.responsible && !assignees.some((a) => a.id === doctor.responsible?.id)) {
    responsibleOptions.push({ value: doctor.responsible.id, label: `${doctor.responsible.name} (inativo)` });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? 'Editar médico' : 'Novo médico'}
      footer={
        <div className="ml-auto flex gap-md">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={() => handleSubmit()} loading={save.isPending}>
            {isEdit ? 'Salvar' : 'Cadastrar'}
          </Button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-md md:grid-cols-2" noValidate>
        <div className="md:col-span-2">
          <Input
            label="Nome"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            error={fieldErrors.name}
            required
          />
        </div>
        <Input
          label="CRM"
          hint="Opcional. Só os números."
          inputMode="numeric"
          value={form.crm}
          onChange={(e) => set('crm', e.target.value)}
          error={fieldErrors.crm}
        />
        <Select
          label="UF do CRM"
          value={form.crmUf}
          onChange={(e) => set('crmUf', e.target.value)}
          options={[{ value: '', label: '—' }, ...BRAZIL_UFS.map((uf) => ({ value: uf, label: uf }))]}
          error={fieldErrors.crmUf}
        />
        <Input
          label="Especialidade"
          value={form.specialty}
          onChange={(e) => set('specialty', e.target.value)}
          error={fieldErrors.specialty}
        />
        <Input
          label="Clínica/consultório"
          value={form.clinic}
          onChange={(e) => set('clinic', e.target.value)}
          error={fieldErrors.clinic}
        />
        <div className="md:col-span-2">
          <Input
            label="Endereço"
            value={form.address}
            onChange={(e) => set('address', e.target.value)}
            error={fieldErrors.address}
          />
        </div>
        <Input
          label="Telefone/WhatsApp"
          type="tel"
          value={form.phone}
          onChange={(e) => set('phone', e.target.value)}
          error={fieldErrors.phone}
        />
        <Input
          label="E-mail"
          type="email"
          value={form.email}
          onChange={(e) => set('email', e.target.value)}
          error={fieldErrors.email}
        />
        <Input
          label="Secretária/contato"
          value={form.contactName}
          onChange={(e) => set('contactName', e.target.value)}
          error={fieldErrors.contactName}
        />
        <Input
          label="Melhor dia e horário para visita"
          placeholder="Ex.: terças à tarde"
          value={form.visitPreference}
          onChange={(e) => set('visitPreference', e.target.value)}
          error={fieldErrors.visitPreference}
        />
        <div className="md:col-span-2">
          <Select
            label="Responsável pela carteira"
            value={form.responsibleId}
            onChange={(e) => set('responsibleId', e.target.value)}
            options={responsibleOptions}
            error={fieldErrors.responsibleId}
          />
        </div>
        <div className="md:col-span-2">
          <TextArea
            label="Observações"
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
            error={fieldErrors.notes}
            rows={3}
          />
        </div>
      </form>
    </Modal>
  );
}
