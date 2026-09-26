import type { ProposalStageHistoryEntry } from '@crm-lab/shared';
import { PROPOSAL_STATUS_LABELS, describeStageAutomation } from '@crm-lab/shared';
import { formatRelativeDate } from '@/lib/format';

interface StageHistoryProps {
  history: ProposalStageHistoryEntry[];
}

export default function StageHistory({ history }: StageHistoryProps) {
  return (
    <div className="space-y-md">
      <h3 className="font-semibold text-label">Histórico</h3>
      <div className="space-y-sm">
        {history.map((entry, idx) => (
          <div key={idx} className="flex justify-between text-caption text-neutral-600">
            <div>
              <span className="font-medium">{PROPOSAL_STATUS_LABELS[entry.status]}</span>
              {/* CRMLAB-59/D-208: linha gravada pelo motor de tempo. */}
              {entry.automation ? (
                <span className="ml-sm text-neutral-500">
                  movido pela regra: {describeStageAutomation(entry.automation)}
                </span>
              ) : (
                entry.changedByName && (
                  <span className="ml-sm text-neutral-500">por {entry.changedByName}</span>
                )
              )}
            </div>
            <span>{formatRelativeDate(entry.changedAt)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
