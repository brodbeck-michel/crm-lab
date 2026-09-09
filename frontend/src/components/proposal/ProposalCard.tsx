import { useUIStore } from '@/stores/ui.store';
import { type Proposal, PROPOSAL_STATUS_LABELS, formatProposalNumber } from '@crm-lab/shared';
import { Chip } from '@/components/ui/Chip';
import { MoneyDisplay } from '@/components/shared/MoneyDisplay';

/** Prefixo do tipo que carrega o estagio de origem (ver `onDragStart`). */
export const DRAG_STATUS_PREFIX = 'application/x-crm-proposal-status-';

interface ProposalCardProps {
  proposal: Proposal;
  /** Arrastavel no kanban; na lista nao ha para onde soltar. */
  draggable?: boolean;
}

export default function ProposalCard({ proposal, draggable = false }: ProposalCardProps) {
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
      draggable={draggable}
      onDragStart={(event) => {
        event.dataTransfer.setData('application/json', JSON.stringify(proposal));
        /**
         * O estagio de origem vai TAMBEM no nome do tipo porque no `dragover` o
         * drag data store esta em modo protegido (HTML5): so `types` e legivel,
         * `getData()` devolve string vazia. Sem isso a coluna nao teria como
         * decidir se aceita o drop — e sem `preventDefault()` no `dragover` o
         * navegador nem dispara o `drop`.
         */
        event.dataTransfer.setData(`${DRAG_STATUS_PREFIX}${proposal.status}`, '');
        event.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => openModal({ kind: 'proposal', id: proposal.id })}
      className="w-full text-left bg-neutral-100 p-md rounded-md shadow-sm hover:shadow-md transition-shadow border border-neutral-200"
    >
      <div className="flex items-start justify-between gap-sm mb-sm">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-label truncate">{proposal.patientName || 'Sem paciente'}</p>
          <p className="text-caption text-neutral-600">
            {formatProposalNumber(proposal.proposalNumber)}
          </p>
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
