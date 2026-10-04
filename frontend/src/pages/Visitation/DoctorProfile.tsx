import { useState } from 'react';
import type { ReactNode } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  DOCTOR_INTERACTION_DESCRIPTION_MAX_LENGTH,
  DOCTOR_INTERACTION_TYPES,
  DOCTOR_INTERACTION_TYPE_LABELS,
  VISIT_STATUS_LABELS,
  VISIT_TYPE_LABELS,
  visitDurationMinutes,
  type CreateDoctorInteractionRequest,
  type Doctor,
  type DoctorInteractionType,
  type DoctorTimelineInteraction,
  type DoctorTimelineItem,
  type DoctorTimelineVisit,
  type VisitStatus,
} from '@crm-lab/shared';
import { doctorsApi } from '@/api/doctors';
import { conversationsApi } from '@/api/conversations';
import { isApiError } from '@/api/client';
import { mapFieldErrors } from '@/api/error-handler';
import { queryKeys } from '@/api/query-keys';
import { useApiErrorHandler } from '@/hooks';
import { PageContainer, PageHeader } from '@/components/layout';
import { EmptyState, Modal } from '@/components/shared';
import { Button, Chip, Input, Select, TextArea, useToast } from '@/components/ui';
import type { ChipTone } from '@/components/ui';
import { formatDateTime, fromDateTimeInputs, toDateInput, toTimeInput } from './agenda-dates';
import { DoctorModal, crmLabel } from './Doctors';

const PAGE_SIZE = 20;

const STATUS_TONES: Record<VisitStatus, ChipTone> = {
  agendada: 'attention',
  realizada: 'positive',
  cancelada: 'inactive',
  nao_recebeu: 'inactive',
};

/** Registro aberto no modal: novo ou edição de um existente. */
type InteractionModalState = { kind: 'new' } | { kind: 'edit'; interaction: DoctorTimelineInteraction } | null;

/**
 * Ficha do médico — `/visitation/doctors/:id` (PAGES.md §22b · API_CONTRACTS.md
 * §13 · CRMLAB-89, D-261). Dados do cadastro no topo (editar reaproveita o
 * modal da lista) e a linha do tempo embaixo: as visitas do médico e os
 * registros lançados à mão (ligação, e-mail, WhatsApp), do mais novo para o
 * mais antigo, com "Carregar mais".
 *
 * Todo papel do laboratório vê, lança, edita e exclui (resposta 2A do épico).
 * Médico de outro laboratório responde `404` e a tela diz "não encontrado".
 */
export default function DoctorProfile() {
  const { id } = useParams<{ id: string }>();
  const doctorId = id ?? '';
  const [editing, setEditing] = useState(false);

  const doctorQuery = useQuery({
    queryKey: queryKeys.doctor(doctorId),
    queryFn: () => doctorsApi.get(doctorId),
    enabled: doctorId.length > 0,
  });

  // Usuários ativos do laboratório, qualquer papel — o modal de edição escolhe o responsável.
  const assigneesQuery = useQuery({
    queryKey: queryKeys.conversationAssignees(),
    queryFn: () => conversationsApi.assignees(),
    enabled: editing,
  });

  const breadcrumb = [{ label: 'Médicos', to: '/visitation/doctors' }, { label: 'Ficha do médico' }];

  if (doctorQuery.isLoading) {
    return (
      <PageContainer>
        <PageHeader title="Ficha do médico" breadcrumb={breadcrumb} />
        <p className="m-0 font-body text-body text-neutral-600">Carregando ficha...</p>
      </PageContainer>
    );
  }

  if (doctorQuery.isError || !doctorQuery.data) {
    const notFound = isApiError(doctorQuery.error) && doctorQuery.error.code === 'NOT_FOUND';
    return (
      <PageContainer>
        <PageHeader title="Ficha do médico" breadcrumb={breadcrumb} />
        <EmptyState
          message={notFound ? 'Médico não encontrado' : 'Não foi possível carregar a ficha'}
          hint={notFound ? 'Confira o endereço ou volte para a lista de médicos.' : 'Verifique a conexão e tente novamente.'}
          action={
            notFound ? undefined : (
              <Button variant="secondary" onClick={() => void doctorQuery.refetch()}>
                Tentar novamente
              </Button>
            )
          }
        />
      </PageContainer>
    );
  }

  const doctor = doctorQuery.data;
  const subtitle = [doctor.crm ? `CRM ${crmLabel(doctor)}` : null, doctor.specialty].filter(Boolean).join(' · ');

  return (
    <PageContainer>
      <PageHeader
        title={doctor.name}
        breadcrumb={breadcrumb}
        description={subtitle || undefined}
        actions={
          <div className="flex items-center gap-sm">
            {!doctor.isActive && <Chip tone="inactive">Inativo</Chip>}
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Editar
            </Button>
          </div>
        }
      />

      <DoctorDetails doctor={doctor} />

      <DoctorTimeline doctorId={doctor.id} />

      {editing && (
        <DoctorModal doctor={doctor} assignees={assigneesQuery.data?.assignees ?? []} onClose={() => setEditing(false)} />
      )}
    </PageContainer>
  );
}

function DoctorDetails({ doctor }: { doctor: Doctor }) {
  const fields: Array<[string, ReactNode]> = [
    ['Clínica/consultório', doctor.clinic],
    ['Endereço', doctor.address],
    ['Telefone/WhatsApp', doctor.phone ? <span className="tabular-nums">{doctor.phone}</span> : null],
    ['E-mail', doctor.email],
    ['Secretária/contato', doctor.contactName],
    ['Melhor dia e horário', doctor.visitPreference],
    ['Responsável pela carteira', doctor.responsible?.name ?? null],
  ];

  return (
    <section aria-label="Dados do médico" className="rounded-lg border border-neutral-200 bg-surface p-lg">
      <dl className="m-0 grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3">
        {fields.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-caption text-neutral-600">{label}</dt>
            <dd className="m-0 break-words font-body text-body text-text">{value ?? '—'}</dd>
          </div>
        ))}
      </dl>
      {doctor.notes && (
        <div className="mt-md">
          <div className="text-caption text-neutral-600">Observações</div>
          <p className="m-0 whitespace-pre-wrap font-body text-body text-text">{doctor.notes}</p>
        </div>
      )}
    </section>
  );
}

function DoctorTimeline({ doctorId }: { doctorId: string }) {
  const queryClient = useQueryClient();
  const handleApiError = useApiErrorHandler();
  const { toast } = useToast();
  const [modal, setModal] = useState<InteractionModalState>(null);

  const timelineQuery = useInfiniteQuery({
    queryKey: queryKeys.doctorTimeline(doctorId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      doctorsApi.timeline(doctorId, { limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const remove = useMutation({
    mutationFn: (interactionId: string) => doctorsApi.deleteInteraction(doctorId, interactionId),
    onSuccess: () => {
      toast('Registro excluído', { tone: 'positive' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.doctorTimeline(doctorId) });
    },
    onError: handleApiError,
  });

  const items = timelineQuery.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section aria-labelledby="doctor-timeline-heading" className="flex flex-col gap-md">
      <div className="flex flex-wrap items-center justify-between gap-md">
        <h2 id="doctor-timeline-heading" className="m-0 font-heading text-section text-text">
          Linha do tempo
        </h2>
        <Button variant="primary" onClick={() => setModal({ kind: 'new' })}>
          + Registrar interação
        </Button>
      </div>

      {timelineQuery.isLoading ? (
        <p className="m-0 font-body text-body text-neutral-600">Carregando linha do tempo...</p>
      ) : timelineQuery.isError ? (
        <EmptyState
          message="Não foi possível carregar a linha do tempo"
          hint="Verifique a conexão e tente novamente."
          action={
            <Button variant="secondary" onClick={() => void timelineQuery.refetch()}>
              Tentar novamente
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState
          message="Nenhuma interação ainda"
          hint="As visitas da Agenda aparecem aqui. Ligações, e-mails e mensagens você registra pelo botão acima."
        />
      ) : (
        <>
          <ol className="m-0 flex list-none flex-col gap-sm p-0" data-testid="doctor-timeline">
            {items.map((item) => (
              <li
                key={`${item.kind}:${item.id}`}
                className="flex flex-col gap-xs rounded-md border border-neutral-300 bg-neutral-100 px-md py-sm"
              >
                <TimelineItem
                  item={item}
                  onEdit={(interaction) => setModal({ kind: 'edit', interaction })}
                  onDelete={(interaction) => {
                    if (!window.confirm('Excluir este registro? Não dá para desfazer.')) return;
                    remove.mutate(interaction.id);
                  }}
                  deleting={remove.isPending && remove.variables === item.id}
                />
              </li>
            ))}
          </ol>
          {timelineQuery.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                onClick={() => void timelineQuery.fetchNextPage()}
                loading={timelineQuery.isFetchingNextPage}
              >
                Carregar mais
              </Button>
            </div>
          )}
        </>
      )}

      {modal && (
        <InteractionModal
          doctorId={doctorId}
          interaction={modal.kind === 'edit' ? modal.interaction : undefined}
          onClose={() => setModal(null)}
        />
      )}
    </section>
  );
}

interface TimelineItemProps {
  item: DoctorTimelineItem;
  onEdit: (interaction: DoctorTimelineInteraction) => void;
  onDelete: (interaction: DoctorTimelineInteraction) => void;
  deleting: boolean;
}

/** Uma espécie, um corpo — o `switch` é em `kind`. */
function TimelineItem({ item, onEdit, onDelete, deleting }: TimelineItemProps) {
  switch (item.kind) {
    case 'visit':
      return <VisitItem visit={item} />;
    case 'interaction':
      return <InteractionItem interaction={item} onEdit={onEdit} onDelete={onDelete} deleting={deleting} />;
    default: {
      const never: never = item;
      return never;
    }
  }
}

function VisitItem({ visit }: { visit: DoctorTimelineVisit }) {
  const duration = visitDurationMinutes(visit);
  const details = [
    VISIT_TYPE_LABELS[visit.type],
    visit.responsible ? `com ${visit.responsible.name}` : null,
    duration !== null ? `${duration} min` : null,
    visit.attachmentCount > 0 ? `${visit.attachmentCount} anexo${visit.attachmentCount > 1 ? 's' : ''}` : null,
  ].filter(Boolean);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <div className="flex flex-wrap items-center gap-sm">
          <span className="font-heading text-label font-semibold text-text">Visita</span>
          <Chip tone={STATUS_TONES[visit.status]}>{VISIT_STATUS_LABELS[visit.status]}</Chip>
          <span className="text-caption tabular-nums text-neutral-600">{formatDateTime(visit.occurredAt)}</span>
        </div>
        <Link
          to={`/visitation/agenda?visit=${visit.id}`}
          className="text-caption font-semibold text-accent-700 hover:underline"
        >
          Abrir visita
        </Link>
      </div>
      <p className="m-0 text-caption text-text">{details.join(' · ')}</p>
      {visit.statusReason && <p className="m-0 text-caption text-neutral-600">Motivo: {visit.statusReason}</p>}
      {visit.reportExcerpt && (
        <p className="m-0 whitespace-pre-wrap font-body text-body text-text">{visit.reportExcerpt}</p>
      )}
    </>
  );
}

interface InteractionItemProps {
  interaction: DoctorTimelineInteraction;
  onEdit: (interaction: DoctorTimelineInteraction) => void;
  onDelete: (interaction: DoctorTimelineInteraction) => void;
  deleting: boolean;
}

function InteractionItem({ interaction, onEdit, onDelete, deleting }: InteractionItemProps) {
  const label = DOCTOR_INTERACTION_TYPE_LABELS[interaction.type];
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <div className="flex flex-wrap items-center gap-sm">
          <span className="font-heading text-label font-semibold text-text">{label}</span>
          <span className="text-caption tabular-nums text-neutral-600">{formatDateTime(interaction.occurredAt)}</span>
        </div>
        <div className="flex gap-sm">
          <Button variant="secondary" size="sm" onClick={() => onEdit(interaction)} aria-label={`Editar registro de ${label}`}>
            Editar
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onDelete(interaction)}
            loading={deleting}
            aria-label={`Excluir registro de ${label}`}
          >
            Excluir
          </Button>
        </div>
      </div>
      <p className="m-0 whitespace-pre-wrap font-body text-body text-text">{interaction.description}</p>
      <p className="m-0 text-caption text-neutral-600">
        Registrado por {interaction.createdBy?.name ?? 'usuário removido'}
        {interaction.updatedBy ? ` · editado por ${interaction.updatedBy.name}` : ''}
      </p>
    </>
  );
}

interface InteractionModalProps {
  doctorId: string;
  /** Ausente = novo registro. */
  interaction?: DoctorTimelineInteraction;
  onClose: () => void;
}

function InteractionModal({ doctorId, interaction, onClose }: InteractionModalProps) {
  const queryClient = useQueryClient();
  const handleApiError = useApiErrorHandler();
  const { toast } = useToast();
  const isEdit = interaction !== undefined;

  const initial = interaction ? new Date(interaction.occurredAt) : new Date();
  const [type, setType] = useState<DoctorInteractionType>(interaction?.type ?? 'ligacao');
  const [day, setDay] = useState(toDateInput(initial));
  const [time, setTime] = useState(toTimeInput(initial));
  const [description, setDescription] = useState(interaction?.description ?? '');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: (body: CreateDoctorInteractionRequest) =>
      interaction
        ? doctorsApi.updateInteraction(doctorId, interaction.id, body)
        : doctorsApi.createInteraction(doctorId, body),
    onSuccess: () => {
      toast(isEdit ? 'Registro atualizado' : 'Interação registrada', { tone: 'positive' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.doctorTimeline(doctorId) });
      onClose();
    },
    onError: (error) => {
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

  function handleSubmit(event?: React.FormEvent) {
    event?.preventDefault();
    const occurredAt = fromDateTimeInputs(day, time);
    // Mesma regra do servidor (D-261), só para não gastar a ida: o backend valida de novo.
    const errors: Record<string, string> = {};
    if (occurredAt === null) errors.occurredAt = 'Informe a data e a hora';
    if (description.trim().length === 0) errors.description = 'Descreva a interação';
    if (occurredAt === null || Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    save.mutate({ type, occurredAt, description: description.trim() });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? 'Editar registro' : 'Registrar interação'}
      footer={
        <div className="ml-auto flex gap-md">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={() => handleSubmit()} loading={save.isPending}>
            {isEdit ? 'Salvar' : 'Registrar'}
          </Button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-md md:grid-cols-3" noValidate>
        <Select
          label="Tipo"
          value={type}
          onChange={(e) => setType(e.target.value as DoctorInteractionType)}
          options={DOCTOR_INTERACTION_TYPES.map((value) => ({ value, label: DOCTOR_INTERACTION_TYPE_LABELS[value] }))}
          error={fieldErrors.type}
        />
        <Input
          label="Data"
          type="date"
          value={day}
          onChange={(e) => setDay(e.target.value)}
          error={fieldErrors.occurredAt}
        />
        <Input label="Hora" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        <div className="md:col-span-3">
          <TextArea
            label="Descrição"
            placeholder="Ex.: ligou para confirmar a visita de terça"
            value={description}
            maxLength={DOCTOR_INTERACTION_DESCRIPTION_MAX_LENGTH}
            onChange={(e) => {
              setDescription(e.target.value);
              if (fieldErrors.description) setFieldErrors(({ description: _removed, ...rest }) => rest);
            }}
            error={fieldErrors.description}
            rows={4}
          />
        </div>
      </form>
    </Modal>
  );
}
