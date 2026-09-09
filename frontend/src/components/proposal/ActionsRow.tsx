import type { ProposalStatus } from '@crm-lab/shared';
import {
  PROPOSAL_STATUSES,
  PROPOSAL_STATUS_LABELS,
  ALLOWED_TRANSITIONS,
  NEXT_STAGE,
  TERMINAL_STATUSES,
} from '@crm-lab/shared';
import { Button, Select } from '@/components/ui';

interface ActionsRowProps {
  status: ProposalStatus;
  onChangeStatus: (status: ProposalStatus) => void;
  onMarkWon: () => void;
  onMarkLost: () => void;
  isPending: boolean;
  /**
   * "Enviar orçamento" (só existe em `novo_contato`, ver `ALLOWED_TRANSITIONS`):
   * avança o estágio E leva para a conversa com a mensagem pronta. Omitido =
   * botão não aparece — quem monta a tela decide se o fluxo existe ali.
   */
  onSendProposal?: () => void;
}

export default function ActionsRow({
  status,
  onChangeStatus,
  onMarkWon,
  onMarkLost,
  isPending,
  onSendProposal,
}: ActionsRowProps) {
  const canWin = !TERMINAL_STATUSES.includes(status);
  const canLose = !TERMINAL_STATUSES.includes(status);
  const allowedNextStatuses = ALLOWED_TRANSITIONS[status];
  const nextStage = NEXT_STAGE[status];

  const handleStatusChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    if (value) {
      onChangeStatus(value as ProposalStatus);
    }
  };

  return (
    <div className="space-y-md border-t pt-lg">
      <div className="flex gap-sm">
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

      <div className="flex gap-sm justify-end">
        {status === 'novo_contato' && onSendProposal && (
          <Button variant="primary" onClick={onSendProposal} disabled={isPending} loading={isPending}>
            Enviar orçamento
          </Button>
        )}
        {nextStage && (
          <Button
            variant="primary"
            onClick={() => onChangeStatus(nextStage)}
            disabled={isPending}
            loading={isPending}
          >
            Avançar para {PROPOSAL_STATUS_LABELS[nextStage]}
          </Button>
        )}
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
