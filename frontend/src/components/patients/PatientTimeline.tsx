import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  ConversationChannel,
  ListPatientTimelineQuery,
  MessageType,
  PatientTimelineEntry,
  PatientTimelineKind,
  SenderType,
} from '@crm-lab/shared';
import { PROPOSAL_STATUS_LABELS } from '@crm-lab/shared';
import { patientsApi } from '@/api/patients';
import { queryKeys } from '@/api/query-keys';
import { DateDisplay, EmptyState, MoneyDisplay, Pagination } from '@/components/shared';
import { Button, Chip, Select } from '@/components/ui';
import { useUIStore } from '@/stores/ui.store';

/**
 * Histórico de interações — `GET /patients/:id/timeline` (API_CONTRACTS.md §2c).
 *
 * A resposta é uma UNIÃO DISCRIMINADA por `kind`: o `switch` abaixo é
 * exaustivo por construção (o `default` recebe `never`), então uma quinta
 * espécie no contrato quebra o typecheck em vez de sumir da tela em silêncio.
 * `entry.id` é `"<kind>:<uuid>"` e serve SÓ de `key` — não é id de recurso.
 *
 * Paginação é de verdade: a tela avança pelas páginas do servidor e diz em
 * qual está. Carregar só a primeira e chamar de histórico foi exatamente a
 * pendência D7 da Onda 5.
 */

const PAGE_SIZE = 20;

const KIND_FILTER_OPTIONS = [
  { value: 'all', label: 'Todas as interações' },
  { value: 'message', label: 'Mensagens' },
  { value: 'conversation_started', label: 'Conversas iniciadas' },
  { value: 'proposal_created', label: 'Orçamentos criados' },
  { value: 'proposal_stage_changed', label: 'Mudanças de estágio' },
];

const ORDER_OPTIONS = [
  { value: 'desc', label: 'Mais recentes primeiro' },
  { value: 'asc', label: 'Mais antigas primeiro' },
];

const CHANNEL_LABEL: Readonly<Record<ConversationChannel, string>> = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  web: 'Web',
  direct: 'Direto',
};

const SENDER_LABEL: Readonly<Record<SenderType, string>> = {
  patient: 'Paciente',
  agent: 'Atendente',
  system: 'Sistema',
};

const MESSAGE_TYPE_LABEL: Readonly<Record<MessageType, string>> = {
  text: 'Texto',
  image: 'Imagem',
  audio: 'Áudio',
  pdf: 'PDF',
  doc: 'Documento',
};

function isKind(value: string): value is PatientTimelineKind {
  return (
    value === 'message' ||
    value === 'conversation_started' ||
    value === 'proposal_created' ||
    value === 'proposal_stage_changed'
  );
}

export interface PatientTimelineProps {
  patientId: string;
}

export function PatientTimeline({ patientId }: PatientTimelineProps) {
  const openModal = useUIStore((state) => state.openModal);
  const [page, setPage] = useState(1);
  const [kindFilter, setKindFilter] = useState('all');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');

  const filters = useMemo<ListPatientTimelineQuery>(
    () => ({
      page,
      limit: PAGE_SIZE,
      order,
      ...(isKind(kindFilter) ? { kind: kindFilter } : {}),
    }),
    [page, order, kindFilter],
  );

  const timelineQuery = useQuery({
    queryKey: queryKeys.patientTimeline(patientId, filters),
    queryFn: () => patientsApi.timeline(patientId, filters),
    enabled: patientId.length > 0,
  });

  const pagination = timelineQuery.data?.pagination;
  const entries = timelineQuery.data?.entries ?? [];

  return (
    <section aria-labelledby="patient-timeline-heading" className="flex flex-col gap-md">
      <div className="flex flex-wrap items-end justify-between gap-md">
        <h2 id="patient-timeline-heading" className="m-0 font-heading text-section text-text">
          Histórico de interações
        </h2>

        <div className="flex flex-wrap items-end gap-sm">
          <div className="w-[220px]">
            <Select
              aria-label="Filtrar tipo de interação"
              options={KIND_FILTER_OPTIONS}
              value={kindFilter}
              onChange={(event) => {
                setKindFilter(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="w-[220px]">
            <Select
              aria-label="Ordenar histórico"
              options={ORDER_OPTIONS}
              value={order}
              onChange={(event) => {
                setOrder(event.target.value === 'asc' ? 'asc' : 'desc');
                setPage(1);
              }}
            />
          </div>
        </div>
      </div>

      {timelineQuery.isLoading ? (
        <p className="m-0 font-body text-body text-neutral-600">Carregando histórico...</p>
      ) : timelineQuery.isError ? (
        <EmptyState
          message="Não foi possível carregar o histórico"
          hint="Verifique a conexão e tente novamente."
          action={
            <Button variant="secondary" onClick={() => void timelineQuery.refetch()}>
              Tentar novamente
            </Button>
          }
        />
      ) : entries.length === 0 ? (
        <EmptyState
          message="Nenhuma interação registrada"
          hint="Mensagens, orçamentos e mudanças de estágio aparecem aqui assim que acontecerem."
        />
      ) : (
        <>
          <ol className="m-0 flex list-none flex-col gap-sm p-0">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-col gap-xs rounded-md border border-neutral-300 bg-neutral-100 px-md py-sm"
              >
                <TimelineEntryBody
                  entry={entry}
                  onOpenProposal={(id) => openModal({ kind: 'proposal', id })}
                />
              </li>
            ))}
          </ol>

          {pagination && (
            <Pagination pagination={pagination} onPageChange={setPage} itemLabel="interações" />
          )}
        </>
      )}

      <p className="m-0 font-body text-caption text-neutral-600">
        O histórico mostra apenas o que você já pode ver por outro caminho — outro atendente pode
        ver um número diferente de interações nesta mesma ficha.
      </p>
    </section>
  );
}

interface TimelineEntryBodyProps {
  entry: PatientTimelineEntry;
  onOpenProposal: (proposalId: string) => void;
}

/** Uma espécie, um corpo. O `switch` é em `kind` — nunca em campo presente. */
function TimelineEntryBody({ entry, onOpenProposal }: TimelineEntryBodyProps) {
  switch (entry.kind) {
    case 'conversation_started':
      return (
        <>
          <EntryHeader label="Conversa iniciada" at={entry.at}>
            <Chip tone="inactive">{CHANNEL_LABEL[entry.channel]}</Chip>
          </EntryHeader>
          <p className="m-0 font-body text-caption text-neutral-600">
            Conversa #{entry.conversationId.slice(0, 8)}
          </p>
        </>
      );

    case 'message':
      return (
        <>
          <EntryHeader label={`Mensagem · ${SENDER_LABEL[entry.senderType]}`} at={entry.at}>
            {entry.messageType !== 'text' && (
              <Chip tone="inactive">{MESSAGE_TYPE_LABEL[entry.messageType]}</Chip>
            )}
          </EntryHeader>
          <p className="m-0 font-body text-body text-text">
            {entry.preview.length > 0 ? (
              entry.preview
            ) : (
              <span className="text-neutral-600">
                Sem texto — {MESSAGE_TYPE_LABEL[entry.messageType].toLowerCase()}
              </span>
            )}
          </p>
          <p className="m-0 font-body text-caption text-neutral-600">
            {entry.senderName ?? 'Sem identificação'} · prévia de até 160 caracteres
          </p>
        </>
      );

    case 'proposal_created':
      return (
        <>
          <EntryHeader label="Orçamento criado" at={entry.at}>
            <Chip tone="positive">{PROPOSAL_STATUS_LABELS[entry.status]}</Chip>
          </EntryHeader>
          <div className="flex flex-wrap items-center gap-sm font-body text-body text-text">
            <MoneyDisplay value={entry.totalPrice} variant="full" />
            <span className="text-caption text-neutral-600">
              desconto de {entry.discountPercent}% · por {entry.createdByName}
            </span>
          </div>
          <div>
            <Button variant="secondary" size="sm" onClick={() => onOpenProposal(entry.proposalId)}>
              Abrir orçamento
            </Button>
          </div>
        </>
      );

    case 'proposal_stage_changed':
      return (
        <>
          <EntryHeader label="Mudança de estágio" at={entry.at} />
          <p className="m-0 font-body text-body text-text">
            {entry.from === null ? 'Criado em' : `${PROPOSAL_STATUS_LABELS[entry.from]} →`}{' '}
            {PROPOSAL_STATUS_LABELS[entry.to]}
          </p>
          <p className="m-0 font-body text-caption text-neutral-600">
            {entry.changedByName ?? 'Automático'}
          </p>
          <div>
            <Button variant="secondary" size="sm" onClick={() => onOpenProposal(entry.proposalId)}>
              Abrir orçamento
            </Button>
          </div>
        </>
      );

    default: {
      // Exaustividade: espécie nova no contrato quebra o typecheck aqui.
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

interface EntryHeaderProps {
  label: string;
  at: string;
  children?: ReactNode;
}

function EntryHeader({ label, at, children }: EntryHeaderProps) {
  return (
    <div className="flex flex-wrap items-center gap-sm">
      <span className="font-body text-label font-semibold text-text">{label}</span>
      {children}
      <span className="ml-auto font-body text-caption text-neutral-600">
        <DateDisplay value={at} variant="absolute" />
      </span>
    </div>
  );
}

export default PatientTimeline;
