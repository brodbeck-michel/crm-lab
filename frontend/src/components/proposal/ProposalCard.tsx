import { useUIStore } from '@/stores/ui.store';
import {
  type HoursRule,
  type Proposal,
  PROPOSAL_STATUS_LABELS,
  formatProposalNumber,
  hoursSince,
  isStaleNewBudget,
} from '@crm-lab/shared';
import { Chip } from '@/components/ui/Chip';
import { MoneyDisplay } from '@/components/shared/MoneyDisplay';
import { formatIsoDay } from '@/lib/format';

/** Prefixo do tipo que carrega o estagio de origem (ver `onDragStart`). */
export const DRAG_STATUS_PREFIX = 'application/x-crm-proposal-status-';

interface ProposalCardProps {
  proposal: Proposal;
  /** Arrastavel no kanban; na lista nao ha para onde soltar. */
  draggable?: boolean;
  /**
   * Regra "Novo orçamento parado" das Regras (CRMLAB-59, D-207). Sem ela, nada
   * de selo. `now` so existe para teste.
   */
  staleAlert?: HoursRule;
  now?: Date;
}

export default function ProposalCard({
  proposal,
  draggable = false,
  staleAlert,
  now,
}: ProposalCardProps) {
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

  // CRMLAB-57 (D-195/D-197, PAGES.md §5): cartão que nasceu do orçamento do Bitlab.
  const fromBitlab = proposal.origin === 'bitlab';
  const preRegistered =
    fromBitlab && proposal.status === 'novo_contato' && proposal.lisRequisitionNumber !== null;

  // CRMLAB-59/D-207: a mesma função do motor decide o selo.
  const clock = now ?? new Date();
  const stale =
    staleAlert !== undefined &&
    isStaleNewBudget(proposal.status, proposal.stageEnteredAt, staleAlert, clock);
  const staleHours =
    stale && proposal.stageEnteredAt ? hoursSince(new Date(proposal.stageEnteredAt), clock) : 0;

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
        {fromBitlab && <Chip tone="inactive">Bitlab</Chip>}
      </div>

      {fromBitlab && (
        <div className="text-caption text-neutral-600 mb-sm space-y-xs">
          <p>
            Orç. LIS {proposal.lisBudgetNumber}
            {proposal.lisIssuedOn && <> · {formatIsoDay(proposal.lisIssuedOn)}</>}
          </p>
          {proposal.lisAttendantName && <p className="truncate">{proposal.lisAttendantName}</p>}
          {proposal.conversationId === null && <p>Sem conversa vinculada</p>}
        </div>
      )}

      <div className="flex items-end justify-between gap-sm mb-sm">
        <MoneyDisplay value={proposal.totalPrice} variant="full" />
        <span className="text-caption text-neutral-600 flex-shrink-0">{daysOpen}d</span>
      </div>

      <div className="flex justify-between items-center">
        <div className="flex items-center gap-xs flex-wrap">
          <Chip tone={statusTone}>{PROPOSAL_STATUS_LABELS[proposal.status]}</Chip>
          {/* CRMLAB-52/D-119: o LIS confirmou a requisição (PAGES.md §5). */}
          {proposal.lisReconciledAt && <Chip tone="positive">Conciliado</Chip>}
          {/* CRMLAB-57/D-197: requisição já existe, cartão ainda em "Novo orçamento". */}
          {preRegistered && <Chip tone="positive">Pré-cadastro feito</Chip>}
          {/* CRMLAB-59/D-207: "Novo orçamento" parado há N horas sem envio. */}
          {stale && <Chip tone="attention">Parado há {staleHours} h</Chip>}
        </div>
        {proposal.approvalStatus === 'pending' && (
          <span className="text-caption text-accent-700 font-semibold">Aguardando aprovação</span>
        )}
      </div>
    </button>
  );
}
