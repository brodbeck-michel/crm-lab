import { useQuery } from '@tanstack/react-query';
import type { InternalMessage, UserRole } from '@crm-lab/shared';
import { api, queryKeys } from '@/api';
import { cn } from '@/components/ui';
import { DateDisplay } from '@/components/shared';
import { INBOX_BUBBLE_MAX_WIDTH } from '@/components/conversation';
import ProposalCard from '@/components/proposal/ProposalCard';
import { ApprovalActions } from './ApprovalActions';

/**
 * Uma mensagem do chat interno — WORKFLOWS.md §6.
 *
 * Três formas, como no inbox de atendimento: recebida · enviada (a sua) ·
 * sistema (o pedido de aprovação). A proposta anexada vira `ProposalCard`
 * clicável, que abre o Modal da Proposta (PAGES.md §6).
 *
 * A proposta anexada NÃO vem no payload da mensagem (o contrato só carrega o
 * id): ela é uma query própria em `queryKeys.proposal(id)` — a MESMA chave que
 * `approval.requested` / `approval.decided` invalidam, então o cartão e os
 * botões se atualizam sozinhos quando a decisão chega por WebSocket.
 */

export interface InternalMessageItemProps {
  message: InternalMessage;
  /** Id do usuário logado — define se a bolha é "enviada". */
  currentUserId: string | null;
  currentUserRole: UserRole | null;
  /** `#aprovacoes`: só lá os botões de decisão aparecem. */
  isApprovalsChannel: boolean;
}

type BubbleKind = 'received' | 'sent' | 'system';

const SHELL: Record<BubbleKind, string> = {
  received: 'self-start bg-surface rounded-md rounded-bl-sm px-[15px] py-[11px]',
  sent: 'self-end bg-accent-200 rounded-md rounded-br-sm px-[15px] py-[11px]',
  system: 'self-center w-full bg-accent2-100 border border-accent2-300 rounded-md px-[15px] py-[11px]',
};

/** Só gestor/admin decide (SERVICES.md §6). A UI esconde, o servidor recusa. */
function canDecide(role: UserRole | null): boolean {
  return role === 'manager' || role === 'admin';
}

function AttachedProposal({
  proposalId,
  showActions,
}: {
  proposalId: string;
  showActions: boolean;
}) {
  const proposalQuery = useQuery({
    queryKey: queryKeys.proposal(proposalId),
    queryFn: () => api.proposals.get(proposalId),
  });

  if (proposalQuery.isPending) {
    return (
      <p role="status" className="m-0 font-body text-caption text-neutral-600">
        Carregando proposta…
      </p>
    );
  }

  if (proposalQuery.isError || !proposalQuery.data) {
    return (
      <p className="m-0 font-body text-caption text-neutral-600">
        Não foi possível carregar a proposta anexada.
      </p>
    );
  }

  const proposal = proposalQuery.data;

  return (
    <div className="flex flex-col gap-sm">
      <ProposalCard proposal={proposal} />
      {showActions && proposal.approvalStatus === 'pending' && (
        <ApprovalActions proposal={proposal} />
      )}
    </div>
  );
}

export function InternalMessageItem({
  message,
  currentUserId,
  currentUserRole,
  isApprovalsChannel,
}: InternalMessageItemProps) {
  const kind: BubbleKind = message.isSystem
    ? 'system'
    : message.senderId !== null && message.senderId === currentUserId
      ? 'sent'
      : 'received';

  return (
    <article
      data-testid="internal-message"
      data-kind={kind}
      style={{ maxWidth: kind === 'system' ? undefined : INBOX_BUBBLE_MAX_WIDTH }}
      className={cn('flex min-w-0 flex-col gap-xs font-body text-label text-text', SHELL[kind])}
    >
      <p className="m-0 whitespace-pre-wrap break-words">{message.content}</p>

      {message.attachedProposalId !== null && (
        <AttachedProposal
          proposalId={message.attachedProposalId}
          showActions={isApprovalsChannel && canDecide(currentUserRole)}
        />
      )}

      <span className="flex items-baseline gap-sm font-body text-micro text-neutral-600">
        <span className="truncate">{message.senderName}</span>
        <DateDisplay value={message.createdAt} variant="absolute" />
      </span>
    </article>
  );
}
