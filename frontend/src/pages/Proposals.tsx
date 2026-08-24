import { useState } from 'react';
import { useProposalList } from '@/api/proposals';
import { PROPOSAL_STATUSES, type ProposalStatus, type ListProposalsQuery, type Proposal } from '@crm-lab/shared';
import StageColumn from '@/components/proposal/StageColumn';
import ProposalsFilters from '@/components/proposal/ProposalsFilters';

export default function Proposals() {
  const [filters, setFilters] = useState<ListProposalsQuery>({
    startDate: '',
    endDate: '',
    createdBy: '',
    status: '',
  });

  const { data: proposals = [], isLoading } = useProposalList(filters);

  const proposalsByStatus = PROPOSAL_STATUSES.reduce(
    (acc, status) => ({
      ...acc,
      [status]: proposals.filter((p) => p.status === status),
    }),
    {} as Record<ProposalStatus, Proposal[]>
  );

  return (
    <div className="flex flex-col gap-lg p-lg h-full">
      <h1 className="font-heading text-display">Pipeline de Propostas</h1>

      <ProposalsFilters filters={filters} onChange={setFilters} />

      {isLoading ? (
        <div>Carregando...</div>
      ) : (
        <div className="flex gap-md overflow-x-auto pb-md flex-1">
          {PROPOSAL_STATUSES.map((status) => (
            <StageColumn
              key={status}
              status={status}
              proposals={proposalsByStatus[status]}
            />
          ))}
        </div>
      )}
    </div>
  );
}
