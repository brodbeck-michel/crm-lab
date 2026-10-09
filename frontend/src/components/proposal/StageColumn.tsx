import { useState } from 'react';
import {
  PROPOSAL_STATUS_LABELS,
  isTransitionAllowed,
  type StaleNewBudgetAlertRule,
  type Proposal,
  type ProposalStatus,
} from '@crm-lab/shared';
import ProposalCard, { DRAG_STATUS_PREFIX } from './ProposalCard';
import { MoneyDisplay } from '@/components/shared/MoneyDisplay';
import { cn } from '@/components/ui';
import { STAGE_TONES } from './stageTone';

interface StageColumnProps {
  status: ProposalStatus;
  proposals: Proposal[];
  /** Card solto na coluna. Sem handler, a coluna nao aceita drop. */
  onDropProposal?: (proposal: Proposal, target: ProposalStatus) => void;
  /**
   * A coluna aceita um card vindo de `origin`? Omitido = matriz padrao
   * (`isTransitionAllowed`). O pipeline passa as travas das Regras (D-192).
   */
  accepts?: (origin: ProposalStatus, target: ProposalStatus) => boolean;
  /** Regra "Novo orçamento parado" (CRMLAB-59, D-207), repassada ao cartão para o selo. */
  staleAlert?: StaleNewBudgetAlertRule;
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

export default function StageColumn({
  status,
  proposals,
  onDropProposal,
  accepts: acceptsFrom = isTransitionAllowed,
  staleAlert,
}: StageColumnProps) {
  const total = proposals.reduce((sum, p) => sum + (p.totalPrice || 0), 0);
  const [over, setOver] = useState(false);
  const tone = STAGE_TONES[status];

  const accepts = (event: React.DragEvent) => {
    if (onDropProposal === undefined) return false;
    const origin = readOriginStatus(event);
    return origin !== null && acceptsFrom(origin, status);
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
      data-stage={status}
      className={cn(
        // CRMLAB-91/D-260: faixa no topo + fundo tingido na cor do estágio.
        'min-w-0 rounded-lg border-0 border-t-4 border-solid p-md flex flex-col transition-colors',
        tone.column,
        // O realce de drop é a cor do TEMA, não a do estágio: "solte aqui" ≠ "que estágio é".
        over && 'ring-2 ring-accent ring-offset-2',
      )}
    >
      <div className="flex items-center justify-between gap-xs mb-md">
        <h3 className={cn('flex items-center gap-xs font-semibold text-label min-w-0', tone.title)}>
          <span aria-hidden className={cn('size-2 rounded-pill flex-shrink-0', tone.dot)} />
          <span className="truncate">{PROPOSAL_STATUS_LABELS[status]}</span>
        </h3>
        <div className="flex gap-sm items-center flex-shrink-0">
          <span className={cn('rounded-pill px-md py-xs text-caption font-semibold', tone.badge)}>
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
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              draggable={onDropProposal !== undefined}
              staleAlert={staleAlert}
            />
          ))
        )}
      </div>
    </div>
  );
}
