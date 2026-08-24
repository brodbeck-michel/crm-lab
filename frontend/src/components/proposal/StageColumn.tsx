import { ProposalStatus, PROPOSAL_STATUS_LABELS, type Proposal } from '@crm-lab/shared';
import ProposalCard from './ProposalCard';
import { MoneyDisplay } from '@/components/shared/MoneyDisplay';

interface StageColumnProps {
  status: ProposalStatus;
  proposals: Proposal[];
}

export default function StageColumn({ status, proposals }: StageColumnProps) {
  const total = proposals.reduce((sum, p) => sum + (p.totalPrice || 0), 0);

  return (
    <div className="flex-shrink-0 w-80 bg-neutral-50 rounded-md p-md flex flex-col">
      <div className="flex items-center justify-between mb-md">
        <h3 className="font-semibold text-label">{PROPOSAL_STATUS_LABELS[status]}</h3>
        <div className="flex gap-sm items-center">
          <span className="bg-neutral-200 rounded-full px-md py-xs text-caption font-semibold">
            {proposals.length}
          </span>
          <MoneyDisplay value={total} variant="compact" />
        </div>
      </div>

      <div className="space-y-sm overflow-y-auto flex-1">
        {proposals.length === 0 ? (
          <p className="text-caption text-neutral-600 text-center py-lg">Nenhuma proposta</p>
        ) : (
          proposals.map((proposal) => (
            <ProposalCard key={proposal.id} proposal={proposal} />
          ))
        )}
      </div>
    </div>
  );
}
