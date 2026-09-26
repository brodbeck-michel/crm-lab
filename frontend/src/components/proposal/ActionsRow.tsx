import type { ManualMoveRules, ProposalStatus, TransitionActor } from '@crm-lab/shared';
import {
  DEFAULT_FUNNEL_RULES,
  PROPOSAL_STATUSES,
  PROPOSAL_STATUS_LABELS,
  NEXT_STAGE,
  TERMINAL_STATUSES,
  allowedTargets,
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
  /**
   * Travas das Regras do laboratório (CRMLAB-56, D-192). Omitidas = padrões,
   * que são a matriz `ALLOWED_TRANSITIONS` com `ganho`/`perdido` terminais.
   */
  rules?: ManualMoveRules;
  /** Quem está movendo. Omitido = a dona do card, sem poder de reabrir. */
  actor?: TransitionActor;
  /** Ganho fechado pelo LIS nunca reabre (D-192 item 2). */
  lisReconciled?: boolean;
}

const OWNER: TransitionActor = { role: 'attendant', isOwner: true };

export default function ActionsRow({
  status,
  onChangeStatus,
  onMarkWon,
  onMarkLost,
  isPending,
  onSendProposal,
  rules = DEFAULT_FUNNEL_RULES.manualMoves,
  actor = OWNER,
  lisReconciled = false,
}: ActionsRowProps) {
  const closed = TERMINAL_STATUSES.includes(status);
  // O que `checkTransition` aceita para este ator — a mesma função do backend.
  const targets = closed && lisReconciled ? [] : allowedTargets(rules, status, actor);
  const canWin = targets.includes('ganho');
  const canLose = targets.includes('perdido');
  const nextStage = NEXT_STAGE[status];
  const canAdvance = nextStage !== undefined && targets.includes(nextStage);
  const canSend = status === 'novo_contato' && targets.includes('orcamento_enviado');

  const handleStatusChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    if (value) {
      onChangeStatus(value as ProposalStatus);
    }
  };

  return (
    <div className="space-y-md border-t pt-lg">
      <div className="flex gap-sm">
        {closed ? (
          // Fechada: o seletor só existe quando a regra deixa reabrir (D-192).
          targets.length > 0 && (
            <Select
              label="Reabrir em"
              placeholder="Escolha o estágio"
              options={targets.map((s) => ({ label: PROPOSAL_STATUS_LABELS[s], value: s }))}
              value=""
              onChange={handleStatusChange}
              disabled={isPending}
            />
          )
        ) : (
          <Select
            label="Mudar estágio"
            options={PROPOSAL_STATUSES.filter((s) => s !== status && targets.includes(s)).map(
              (s) => ({
                label: PROPOSAL_STATUS_LABELS[s],
                value: s,
              }),
            )}
            value=""
            onChange={handleStatusChange}
          />
        )}
      </div>

      <div className="flex gap-sm justify-end">
        {canSend && onSendProposal && (
          <Button
            variant="primary"
            onClick={onSendProposal}
            disabled={isPending}
            loading={isPending}
          >
            Enviar orçamento
          </Button>
        )}
        {canAdvance && nextStage && (
          <Button
            variant="primary"
            onClick={() => onChangeStatus(nextStage)}
            disabled={isPending}
            loading={isPending}
          >
            Avançar para {PROPOSAL_STATUS_LABELS[nextStage]}
          </Button>
        )}
        <Button variant="confirmation" onClick={onMarkWon} disabled={!canWin || isPending}>
          Marcar como Ganho
        </Button>
        <Button variant="destructive" onClick={onMarkLost} disabled={!canLose || isPending}>
          Marcar como Perdido
        </Button>
      </div>
    </div>
  );
}
