import type { ProposalStageHistoryEntry } from '@crm-lab/shared';
import { PROPOSAL_STATUS_LABELS } from '@crm-lab/shared';
import { formatRelativeDate } from '@/lib/format';

interface StageHistoryProps {
  history: ProposalStageHistoryEntry[];
}

export default function StageHistory({ history }: StageHistoryProps) {
  return (
    <div className="space-y-3">
      <h3 className="font-semibold text-label">Histórico</h3>
      <div className="space-y-2">
        {history.map((entry, idx) => (
          <div key={idx} className="flex justify-between text-caption text-neutral-600">
            <div>
              <span className="font-medium">{PROPOSAL_STATUS_LABELS[entry.status]}</span>
              {entry.changedByName && (
                <span className="ml-2 text-neutral-500">por {entry.changedByName}</span>
              )}
            </div>
            <span>{formatRelativeDate(entry.changedAt)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
