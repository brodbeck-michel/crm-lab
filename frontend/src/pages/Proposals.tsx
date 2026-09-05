import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useProposalList, useUpdateProposalStatus } from '@/api/proposals';
import {
  PROPOSAL_STATUSES,
  isTransitionAllowed,
  type ProposalStatus,
  type ListProposalsQuery,
  type Proposal,
} from '@crm-lab/shared';
import StageColumn from '@/components/proposal/StageColumn';
import ProposalCard from '@/components/proposal/ProposalCard';
import ProposalsFilters from '@/components/proposal/ProposalsFilters';
import NewAttendanceModal from '@/components/proposal/NewAttendanceModal';
import { Pagination } from '@/components/shared';
import { Button, SegmentedControl, useToast } from '@/components/ui';
import { useUIStore } from '@/stores/ui.store';

/** Mesmo default do backend (`docs/api/API_CONTRACTS.md` §3). */
const PAGE_SIZE = 20;
/**
 * O kanban carrega o teto do contrato de uma vez: pipeline picotado em "página
 * 2" não é pipeline. Acima disso o usuário usa a busca e os filtros.
 */
const KANBAN_SIZE = 100;

type View = 'kanban' | 'lista';

export default function Proposals() {
  const [filters, setFilters] = useState<ListProposalsQuery>({
    startDate: '',
    endDate: '',
    createdBy: '',
    status: '',
    search: '',
  });

  /**
   * A página mora na URL, não no Zustand: `?page=3` é compartilhável, sobrevive
   * ao F5 e volta com o botão "voltar" do navegador. Zustand é estado de
   * sessão (usuário, tenant, tema) — página de listagem não é isso. A visão
   * escolhida segue a mesma regra (`?view=lista`).
   */
  /** Modal do atendimento que nao veio do WhatsApp (PAGES.md §5). */
  const [newAttendanceOpen, setNewAttendanceOpen] = useState(false);

  const [searchParams, setSearchParams] = useSearchParams();
  const parsedPage = Number.parseInt(searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const view: View = searchParams.get('view') === 'lista' ? 'lista' : 'kanban';

  const patchParams = (mutate: (params: URLSearchParams) => void) => {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        mutate(params);
        return params;
      },
      { replace: true },
    );
  };

  const goToPage = (next: number) =>
    patchParams((params) => {
      if (next <= 1) params.delete('page');
      else params.set('page', String(next));
    });

  /** Trocar de visão reinicia a paginação — os limites das duas são diferentes. */
  const setView = (next: View) =>
    patchParams((params) => {
      if (next === 'kanban') params.delete('view');
      else params.set('view', next);
      params.delete('page');
    });

  /** Trocar de filtro reinicia a paginação — página 3 do filtro antigo não existe. */
  const handleFiltersChange = (next: ListProposalsQuery) => {
    setFilters(next);
    goToPage(1);
  };

  const isKanban = view === 'kanban';
  const { data, isLoading } = useProposalList({
    ...filters,
    page: isKanban ? 1 : page,
    limit: isKanban ? KANBAN_SIZE : PAGE_SIZE,
  });

  const proposals: Proposal[] = data?.proposals ?? [];

  const proposalsByStatus = PROPOSAL_STATUSES.reduce(
    (acc, status) => ({
      ...acc,
      [status]: proposals.filter((p) => p.status === status),
    }),
    {} as Record<ProposalStatus, Proposal[]>
  );

  const openModal = useUIStore((s) => s.openModal);
  const { toast } = useToast();
  const updateStatus = useUpdateProposalStatus();

  /**
   * Soltar o card numa coluna move o estágio. A transição é conferida aqui só
   * para não gastar request óbvio — quem decide continua sendo o backend.
   * `perdido` exige `reasonLost`, então o drop abre a proposta em vez de mutar:
   * o formulário de motivo já mora no modal.
   */
  const handleDrop = (proposal: Proposal, target: ProposalStatus) => {
    if (!isTransitionAllowed(proposal.status, target)) return;
    if (target === 'perdido') {
      openModal({ kind: 'proposal', id: proposal.id });
      return;
    }
    updateStatus.mutate(
      { proposalId: proposal.id, status: target },
      { onError: () => toast('Não foi possível mover a proposta.', { tone: 'attention' }) },
    );
  };

  return (
    <div className="flex flex-col gap-lg p-lg h-full">
      <div className="flex items-center justify-between gap-md">
        <h1 className="font-heading text-display">Pipeline de Propostas</h1>
        <div className="flex items-center gap-md">
          <SegmentedControl<View>
            aria-label="Visualização"
            value={view}
            onChange={setView}
            options={[
              { value: 'kanban', label: 'Kanban' },
              { value: 'lista', label: 'Lista' },
            ]}
          />
          <Button variant="primary" onClick={() => setNewAttendanceOpen(true)}>
            Novo atendimento
          </Button>
        </div>
      </div>

      {newAttendanceOpen && <NewAttendanceModal onClose={() => setNewAttendanceOpen(false)} />}

      <ProposalsFilters filters={filters} onChange={handleFiltersChange} />

      {isLoading ? (
        <div>Carregando...</div>
      ) : isKanban ? (
        <>
          {/* 6 estágios em 6 colunas: cabem na largura, cada uma rola por dentro. */}
          <div className="grid grid-cols-6 gap-md flex-1 min-h-0">
            {PROPOSAL_STATUSES.map((status) => (
              <StageColumn
                key={status}
                status={status}
                proposals={proposalsByStatus[status]}
                onDropProposal={handleDrop}
              />
            ))}
          </div>
          {data && data.pagination.total > KANBAN_SIZE && (
            <p className="text-caption text-neutral-600">
              Mostrando as {KANBAN_SIZE} propostas mais recentes de {data.pagination.total}. Use a
              busca ou os filtros para chegar nas demais.
            </p>
          )}
        </>
      ) : (
        <>
          <div className="grid gap-sm sm:grid-cols-2 lg:grid-cols-3 overflow-y-auto flex-1 min-h-0">
            {proposals.length === 0 ? (
              <p className="text-caption text-neutral-600">Nenhuma proposta</p>
            ) : (
              proposals.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} />)
            )}
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
