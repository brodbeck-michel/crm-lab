import { useUIStore } from '@/stores/ui.store';
import { type Proposal, PROPOSAL_STATUS_LABELS } from '@crm-lab/shared';
import { Chip } from '@/components/ui/Chip';
import { MoneyDisplay } from '@/components/shared/MoneyDisplay';

interface ProposalCardProps {
  proposal: Proposal;
}

export default function ProposalCard({ proposal }: ProposalCardProps) {
  const openModal = useUIStore((s) => s.openModal);

  const statusTone =
    proposal.status === 'ganho'
      ? ('positive' as const)
      : proposal.status === 'perdido'
        ? ('attention' as const)
        : ('inactive' as const);

  const daysOpen = Math.floor(
    (Date.now() - new Date(proposal.createdAt).getTime()) / (1000 * 60 * 60 * 24)
  );

  return (
    <button
      onClick={() => openModal({ kind: 'proposal', id: proposal.id })}
      className="w-full text-left bg-white p-md rounded-md shadow-sm hover:shadow-md transition-shadow border border-neutral-200"
    >
      <div className="flex items-start justify-between gap-sm mb-sm">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-label truncate">{proposal.patientName || 'Sem paciente'}</p>
          <p className="text-caption text-neutral-600">#{proposal.id.slice(0, 8)}</p>
        </div>
      </div>

      <div className="flex items-end justify-between gap-sm mb-sm">
        <MoneyDisplay value={proposal.totalPrice} variant="full" />
        <span className="text-caption text-neutral-600 flex-shrink-0">{daysOpen}d</span>
      </div>

      <div className="flex justify-between items-center">
        <Chip tone={statusTone}>{PROPOSAL_STATUS_LABELS[proposal.status]}</Chip>
        {proposal.approvalStatus === 'pending' && (
          <span className="text-caption text-accent-700 font-semibold">Aguardando aprovação</span>
        )}
      </div>
    </button>
  );
}
