import { useState } from 'react';
import {
  PROPOSAL_STATUS_LABELS,
  isTransitionAllowed,
  type Proposal,
  type ProposalStatus,
} from '@crm-lab/shared';
import ProposalCard, { DRAG_STATUS_PREFIX } from './ProposalCard';
import { MoneyDisplay } from '@/components/shared/MoneyDisplay';
import { cn } from '@/components/ui';

interface StageColumnProps {
  status: ProposalStatus;
  proposals: Proposal[];
  /** Card solto na coluna. Sem handler, a coluna nao aceita drop. */
  onDropProposal?: (proposal: Proposal, target: ProposalStatus) => void;
}

/**
 * O card viaja pelo DataTransfer como JSON (`ProposalCard` serializa). Payload
 * quebrado devolve `null` e a coluna simplesmente ignora o drop. So funciona no
 * `drop` — no `dragover` o store esta protegido e isso devolve `null` sempre.
 */
function readProposal(event: React.DragEvent): Proposal | null {
  const raw = event.dataTransfer.getData('application/json');
  if (raw === '') return null;
  try {
    return JSON.parse(raw) as Proposal;
  } catch {
    return null;
  }
}

/**
 * Estagio de origem lido de `types` — a UNICA parte do dataTransfer legivel
 * durante o `dragover` (modo protegido do HTML5). E por isso que `ProposalCard`
 * codifica o status no nome do tipo em vez de so no payload.
 */
function readOriginStatus(event: React.DragEvent): ProposalStatus | null {
  const type = Array.from(event.dataTransfer.types).find((t) =>
    t.startsWith(DRAG_STATUS_PREFIX),
  );
  return type === undefined ? null : (type.slice(DRAG_STATUS_PREFIX.length) as ProposalStatus);
}

export default function StageColumn({ status, proposals, onDropProposal }: StageColumnProps) {
  const total = proposals.reduce((sum, p) => sum + (p.totalPrice || 0), 0);
  const [over, setOver] = useState(false);

  const accepts = (event: React.DragEvent) => {
    if (onDropProposal === undefined) return false;
    const origin = readOriginStatus(event);
    return origin !== null && isTransitionAllowed(origin, status);
  };

  return (
    <div
      onDragOver={(event) => {
        if (!accepts(event)) return;
        // Sem o preventDefault o navegador recusa o drop (HTML5 drag-and-drop).
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        if (!accepts(event)) return;
        const proposal = readProposal(event);
        if (proposal === null) return;
        event.preventDefault();
        onDropProposal?.(proposal, status);
      }}
      className={cn(
        'min-w-0 bg-surface rounded-lg p-md flex flex-col transition-colors',
        over && 'bg-accent-100 ring-2 ring-accent',
      )}
    >
      <div className="flex items-center justify-between gap-xs mb-md">
        <h3 className="font-semibold text-label truncate">{PROPOSAL_STATUS_LABELS[status]}</h3>
        <div className="flex gap-sm items-center flex-shrink-0">
          <span className="bg-neutral-200 rounded-pill px-md py-xs text-caption font-semibold">
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
            <ProposalCard key={proposal.id} proposal={proposal} draggable={onDropProposal !== undefined} />
          ))
        )}
      </div>
    </div>
  );
}
