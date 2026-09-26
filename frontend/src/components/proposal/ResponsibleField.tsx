import { useQuery } from '@tanstack/react-query';
import type { ProposalDetail, UserRole } from '@crm-lab/shared';
import { TERMINAL_STATUSES } from '@crm-lab/shared';
import { conversationsApi } from '@/api/conversations';
import { queryKeys } from '@/api/query-keys';
import { useUpdateProposalResponsible } from '@/api/proposals';
import { useApiErrorHandler } from '@/hooks';
import { Select } from '@/components/ui';

interface ResponsibleFieldProps {
  proposal: ProposalDetail;
  user: { id: string; role: UserRole } | null;
}

/**
 * "Responsável" do cartão (CRMLAB-58, D-202 item 3). É o `createdBy`, que decide
 * quem vê o cartão e de quem é a comissão. Gestor/admin trocam para qualquer
 * pessoa ativa, em qualquer estágio; a atendente só passa o cartão DELA, aberto,
 * para outra atendente. O backend valida; aqui só se esconde o que ele recusaria.
 */
export default function ResponsibleField({ proposal, user }: ResponsibleFieldProps) {
  const supervisor = user?.role === 'manager' || user?.role === 'admin';
  const closed = TERMINAL_STATUSES.includes(proposal.status);
  const editable =
    supervisor || (user !== null && proposal.createdBy === user.id && !closed);

  const assignees = useQuery({
    queryKey: queryKeys.conversationAssignees(),
    queryFn: () => conversationsApi.assignees(),
    enabled: editable,
  });
  const update = useUpdateProposalResponsible();
  const handleApiError = useApiErrorHandler();

  const current = proposal.createdByName || 'Sem responsável (fila comum)';

  if (!editable) {
    return (
      <div className="flex items-center gap-sm">
        <span className="text-caption text-neutral-600">Responsável</span>
        <span className="text-body">{current}</span>
      </div>
    );
  }

  const options = (assignees.data?.assignees ?? [])
    .filter((a) => supervisor || a.role === 'attendant')
    .map((a) => ({ value: a.id, label: a.name }));

  return (
    <Select
      label="Responsável"
      options={options}
      placeholder={proposal.createdBy === null ? 'Sem responsável (fila comum)' : undefined}
      value={proposal.createdBy ?? ''}
      disabled={update.isPending || assignees.isLoading}
      onChange={(e) => {
        const userId = e.target.value;
        if (!userId || userId === proposal.createdBy) return;
        update.mutate({ proposalId: proposal.id, body: { userId } }, { onError: handleApiError });
      }}
    />
  );
}
