import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ListProposalsQuery } from '@crm-lab/shared';
import { proposalsApi } from '@/api/proposals';
import { queryKeys } from '@/api/query-keys';
import { EmptyState, Pagination } from '@/components/shared';
import ProposalCard from '@/components/proposal/ProposalCard';
import { Button } from '@/components/ui';

/**
 * Propostas do paciente — `GET /proposals?patientId=` (D-060).
 *
 * NÃO existe `GET /patients/:id/proposals`: o filtro reusa a listagem que já
 * tem visibilidade por papel (D-042), paginação e o mesmo shape de item. O
 * cartão é o `ProposalCard` do pipeline, que já abre o Modal da Proposta por
 * `useUIStore.openModal({ kind: 'proposal', id })` — a ficha não tem modal
 * próprio.
 *
 * Paginação é de verdade (pendência D7 da Onda 5): a seção anda pelas páginas
 * do servidor em vez de mostrar as 20 primeiras como se fossem todas.
 */

const PAGE_SIZE = 12;

export interface PatientProposalsProps {
  patientId: string;
}

export function PatientProposals({ patientId }: PatientProposalsProps) {
  const [page, setPage] = useState(1);

  const filters = useMemo<ListProposalsQuery>(
    () => ({ patientId, page, limit: PAGE_SIZE, sortBy: 'createdAt', order: 'desc' }),
    [patientId, page],
  );

  const proposalsQuery = useQuery({
    queryKey: queryKeys.proposals(filters),
    queryFn: () => proposalsApi.list(filters),
    enabled: patientId.length > 0,
  });

  const pagination = proposalsQuery.data?.pagination;
  const proposals = proposalsQuery.data?.proposals ?? [];

  return (
    <section aria-labelledby="patient-proposals-heading" className="flex flex-col gap-md">
      <h2 id="patient-proposals-heading" className="m-0 font-heading text-section text-text">
        Orçamentos do paciente
      </h2>

      {proposalsQuery.isLoading ? (
        <p className="m-0 font-body text-body text-neutral-600">Carregando orçamentos...</p>
      ) : proposalsQuery.isError ? (
        <EmptyState
          message="Não foi possível carregar os orçamentos"
          hint="Verifique a conexão e tente novamente."
          action={
            <Button variant="secondary" onClick={() => void proposalsQuery.refetch()}>
              Tentar novamente
            </Button>
          }
        />
      ) : proposals.length === 0 ? (
        <EmptyState
          message="Nenhum orçamento para este paciente"
          hint="Orçamentos criados a partir das conversas dele aparecem aqui."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3">
            {proposals.map((proposal) => (
              <ProposalCard key={proposal.id} proposal={proposal} />
            ))}
          </div>

          {pagination && (
            <Pagination pagination={pagination} onPageChange={setPage} itemLabel="orçamentos" />
          )}
        </>
      )}
    </section>
  );
}

export default PatientProposals;
