import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useProposalList } from '@/api/proposals';
import { PROPOSAL_STATUSES, type ProposalStatus, type ListProposalsQuery, type Proposal } from '@crm-lab/shared';
import StageColumn from '@/components/proposal/StageColumn';
import ProposalsFilters from '@/components/proposal/ProposalsFilters';
import { Pagination } from '@/components/shared';

/** Mesmo default do backend (`docs/api/API_CONTRACTS.md` §3). */
const PAGE_SIZE = 20;

export default function Proposals() {
  const [filters, setFilters] = useState<ListProposalsQuery>({
    startDate: '',
    endDate: '',
    createdBy: '',
    status: '',
  });

  /**
   * A página mora na URL, não no Zustand: `?page=3` é compartilhável, sobrevive
   * ao F5 e volta com o botão "voltar" do navegador. Zustand é estado de
   * sessão (usuário, tenant, tema) — página de listagem não é isso.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const parsedPage = Number.parseInt(searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;

  const goToPage = (next: number) => {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        if (next <= 1) params.delete('page');
        else params.set('page', String(next));
        return params;
      },
      { replace: true },
    );
  };

  /** Trocar de filtro reinicia a paginação — página 3 do filtro antigo não existe. */
  const handleFiltersChange = (next: ListProposalsQuery) => {
    setFilters(next);
    goToPage(1);
  };

  const { data, isLoading } = useProposalList({ ...filters, page, limit: PAGE_SIZE });

  const proposals: Proposal[] = data?.proposals ?? [];

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

      <ProposalsFilters filters={filters} onChange={handleFiltersChange} />

      {isLoading ? (
        <div>Carregando...</div>
      ) : (
        <>
          <div className="flex gap-md overflow-x-auto pb-md flex-1">
            {PROPOSAL_STATUSES.map((status) => (
              <StageColumn
                key={status}
                status={status}
                proposals={proposalsByStatus[status]}
              />
            ))}
          </div>

          {data && (
            <Pagination
              pagination={data.pagination}
              onPageChange={goToPage}
              itemLabel="propostas"
            />
          )}
        </>
      )}
    </div>
  );
}
