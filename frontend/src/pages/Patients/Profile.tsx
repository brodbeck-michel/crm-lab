import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { isApiError } from '@/api/client';
import { patientsApi } from '@/api/patients';
import { queryKeys } from '@/api/query-keys';
import { PageContainer, PageHeader } from '@/components/layout';
import { DateDisplay, EmptyState } from '@/components/shared';
import { Button, Chip } from '@/components/ui';
import {
  PatientLgpdSection,
  PatientProfileForm,
  PatientProposals,
  PatientTimeline,
} from '@/components/patients';
import { useAuthStore } from '@/stores';

/**
 * Ficha do Paciente — `/patients/:id` (PAGES.md §3, API_CONTRACTS.md §2c).
 *
 * TRÊS chamadas, três blocos (D-060) — nunca um payload só:
 *   1. `GET /patients/:id`            → cadastro + contadores  (aqui)
 *   2. `GET /patients/:id/timeline`   → histórico paginado     (PatientTimeline)
 *   3. `GET /proposals?patientId=`    → orçamentos do paciente (PatientProposals)
 *
 * `:id` é o id do PACIENTE (`patients.id`), não o da conversa.
 *
 * Paciente fora da visibilidade do solicitante responde `404` — e a tela diz
 * "não encontrado", nunca "sem permissão": informar que existe já seria
 * vazamento (CLAUDE.md regra 8).
 */
export function PatientProfile() {
  const { id } = useParams<{ id: string }>();
  const patientId = id ?? '';
  const role = useAuthStore((state) => state.user?.role);

  const patientQuery = useQuery({
    queryKey: queryKeys.patient(patientId),
    queryFn: () => patientsApi.get(patientId),
    enabled: patientId.length > 0,
  });

  if (patientQuery.isLoading) {
    return (
      <PageContainer>
        <PageHeader title="Ficha do paciente" />
        <p className="m-0 font-body text-body text-neutral-600">Carregando ficha...</p>
      </PageContainer>
    );
  }

  if (patientQuery.isError || !patientQuery.data) {
    const error = patientQuery.error;
    const notFound = isApiError(error) && error.code === 'NOT_FOUND';

    return (
      <PageContainer>
        <PageHeader title="Ficha do paciente" />
        <EmptyState
          message={notFound ? 'Paciente não encontrado' : 'Não foi possível carregar a ficha'}
          hint={
            notFound
              ? 'Confira o endereço ou volte para o atendimento.'
              : 'Verifique a conexão e tente novamente.'
          }
          action={
            notFound ? undefined : (
              <Button variant="secondary" onClick={() => void patientQuery.refetch()}>
                Tentar novamente
              </Button>
            )
          }
        />
      </PageContainer>
    );
  }

  const patient = patientQuery.data;
  const title = patient.name ?? 'Paciente sem nome';

  return (
    <PageContainer>
      <PageHeader
        title={title}
        breadcrumb={[{ label: 'Atendimento', to: '/attendance' }, { label: 'Ficha do paciente' }]}
        description={patient.phone}
        actions={
          patient.anonymizedAt !== null ? <Chip tone="attention">Anonimizado</Chip> : undefined
        }
      />

      <section aria-label="Resumo da ficha" className="flex flex-wrap gap-md">
        <SummaryTile label="Conversas" value={String(patient.conversationCount)} />
        <SummaryTile label="Orçamentos" value={String(patient.proposalCount)} />
        <SummaryTile
          label="Última interação"
          value={
            patient.lastInteractionAt === null ? (
              'Sem interação'
            ) : (
              <DateDisplay value={patient.lastInteractionAt} variant="absolute" />
            )
          }
        />
      </section>

      <p className="m-0 font-body text-caption text-neutral-600">
        Os números acima contam apenas o que você enxerga — não são o total do laboratório.
      </p>

      <PatientProfileForm patient={patient} />

      <PatientTimeline patientId={patient.id} />

      <PatientProposals patientId={patient.id} />

      {/* A seção LGPD só existe para admin — e, sem ela, nenhuma das duas
          chamadas restritas chega a sair da tela (D-062, D-063). */}
      {role === 'admin' && <PatientLgpdSection patient={patient} />}
    </PageContainer>
  );
}

interface SummaryTileProps {
  label: string;
  value: ReactNode;
}

function SummaryTile({ label, value }: SummaryTileProps) {
  return (
    <div className="min-w-[180px] flex-1 rounded-md border border-neutral-300 bg-neutral-100 px-md py-sm">
      <p className="m-0 font-body text-caption text-neutral-600">{label}</p>
      <p className="m-0 font-heading text-metric text-text">{value}</p>
    </div>
  );
}

export default PatientProfile;
