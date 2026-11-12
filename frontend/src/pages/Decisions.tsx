import { useQuery } from '@tanstack/react-query';
import { operationApi, queryKeys, staleTimes } from '@/api';
import { PageContainer, PageHeader } from '@/components/layout';
import { EmptyState } from '@/components/shared';
import { formatCount } from '@/lib/format';
import { useUIStore } from '@/stores';
import { ApprovalActions } from '@/components/proposal/ApprovalActions';
import { PendingDecisionCard } from './Settings/Operation';

/**
 * Decisões — `/decisions` (PAGES.md §12).
 *
 * Mesmo retrato de `GET /operations/overview` (D-067) usado em Gestão da
 * Operação (§10); esta tela só mostra o bloco `pendingDecisions`. Desde o
 * CRMLAB-146 (D-318) é AQUI que o gestor aprova ou rejeita — o chat interno
 * não tem mais pedido de aprovação.
 */
export default function Decisions() {
  const openModal = useUIStore((state) => state.openModal);

  const overviewQuery = useQuery({
    queryKey: queryKeys.operationOverview({}),
    queryFn: () => operationApi.overview({}),
    staleTime: staleTimes.operation,
    refetchInterval: 60_000,
  });

  const decisions = overviewQuery.data?.pendingDecisions;

  return (
    <PageContainer>
      <PageHeader
        title="Decisões"
        description="Propostas aguardando aprovação de alçada, da mais antiga para a mais recente."
      />

      {decisions && decisions.items.length === 0 ? (
        <EmptyState
          message="Nenhuma decisão pendente"
          hint="Descontos acima da alçada aparecem aqui assim que forem pedidos."
        />
      ) : decisions ? (
        <>
          <div className="grid grid-cols-1 gap-md sm:grid-cols-2">
            {decisions.items.map((item) => (
              <div key={item.proposalId} className="flex flex-col gap-sm">
                <PendingDecisionCard
                  item={item}
                  onOpen={() => openModal({ kind: 'proposal', id: item.proposalId })}
                />
                <ApprovalActions proposalId={item.proposalId} patientName={item.patientName} />
              </div>
            ))}
          </div>
          <p className="m-0 font-body text-caption text-neutral-600">
            {formatCount(decisions.total)} decisão(ões) pendente(s) no total.
          </p>
        </>
      ) : null}
    </PageContainer>
  );
}
