import type { ProposalStatus } from '@crm-lab/shared';
import {
  PROPOSAL_STATUSES,
  PROPOSAL_STATUS_LABELS,
  ALLOWED_TRANSITIONS,
  TERMINAL_STATUSES,
} from '@crm-lab/shared';
import { Button, Select } from '@/components/ui';

interface ActionsRowProps {
  status: ProposalStatus;
  onChangeStatus: (status: ProposalStatus) => void;
  onMarkWon: () => void;
  onMarkLost: () => void;
  isPending: boolean;
}

export default function ActionsRow({
  status,
  onChangeStatus,
  onMarkWon,
  onMarkLost,
  isPending,
}: ActionsRowProps) {
  const canWin = !TERMINAL_STATUSES.includes(status);
  const canLose = !TERMINAL_STATUSES.includes(status);
  const allowedNextStatuses = ALLOWED_TRANSITIONS[status];

  const handleStatusChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    if (value) {
      onChangeStatus(value as ProposalStatus);
    }
  };

  return (
    <div className="space-y-3 border-t pt-4">
      <div className="flex gap-2">
        <Select
          label="Mudar estágio"
          options={PROPOSAL_STATUSES.filter(
            (s) => s !== status && allowedNextStatuses.includes(s)
          ).map((s) => ({
            label: PROPOSAL_STATUS_LABELS[s],
            value: s,
          }))}
          value=""
          onChange={handleStatusChange}
        />
      </div>

      <div className="flex gap-2 justify-end">
        <Button
          variant="confirmation"
          onClick={onMarkWon}
          disabled={!canWin || isPending}
        >
          Marcar como Ganho
        </Button>
        <Button
          variant="destructive"
          onClick={onMarkLost}
          disabled={!canLose || isPending}
        >
          Marcar como Perdido
        </Button>
      </div>
    </div>
  );
}
