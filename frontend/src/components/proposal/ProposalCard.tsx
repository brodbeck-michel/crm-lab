import { useUIStore } from '@/stores/ui.store';
import {
  type StaleNewBudgetAlertRule,
  type Proposal,
  PROPOSAL_STATUS_LABELS,
  formatProposalNumber,
  formatStaleDuration,
  minutesSince,
  isStaleNewBudget,
} from '@crm-lab/shared';
import { Chip } from '@/components/ui/Chip';
import { MoneyDisplay } from '@/components/shared/MoneyDisplay';
import { formatIsoDay } from '@/lib/format';
import { cn } from '@/components/ui';
import { STAGE_TONES } from './stageTone';

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
  staleAlert?: StaleNewBudgetAlertRule;
  now?: Date;
}

export default function ProposalCard({
  proposal,
  draggable = false,
  staleAlert,
  now,
}: ProposalCardProps) {
  const openModal = useUIStore((s) => s.openModal);

  const tone = STAGE_TONES[proposal.status];

  const daysOpen = Math.floor(
    (Date.now() - new Date(proposal.createdAt).getTime()) / (1000 * 60 * 60 * 24)
  );

  // CRMLAB-57 (D-195/D-197, PAGES.md §5): cartão que nasceu do orçamento do Bitlab.
  const fromBitlab = proposal.origin === 'bitlab';
  // D-252: o selo vale para qualquer origem — requisição em novo_contato não move a proposta.
  const preRegistered = proposal.status === 'novo_contato' && proposal.lisRequisitionNumber !== null;

  // CRMLAB-59/D-207: a mesma função do motor decide o selo.
  const clock = now ?? new Date();
  const stale =
    staleAlert !== undefined &&
    isStaleNewBudget(proposal.status, proposal.stageEnteredAt, staleAlert, clock);
  // D-267: "N min" abaixo de 1 h, "N h" depois.
  const staleFor =
    stale && proposal.stageEnteredAt
      ? formatStaleDuration(minutesSince(new Date(proposal.stageEnteredAt), clock))
      : '';

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
      className={cn(
        // CRMLAB-91/D-260: cartão branco sobre a coluna tingida, borda esquerda na cor do estágio.
        'w-full text-left bg-bg p-md rounded-md shadow-sm hover:shadow-md transition-shadow',
        'border border-solid border-neutral-200 border-l-4',
        tone.cardEdge,
      )}
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
          {/* Selo do estágio na mesma cor da coluna (CRMLAB-91/D-260) — vale também na lista. */}
          <span
            data-stage={proposal.status}
            className={cn(
              'inline-flex items-center rounded-pill px-[11px] py-[3px] text-caption font-semibold whitespace-nowrap',
              tone.badge,
            )}
          >
            {PROPOSAL_STATUS_LABELS[proposal.status]}
          </span>
          {/* CRMLAB-52/D-119: o LIS confirmou a requisição (PAGES.md §5). */}
          {proposal.lisReconciledAt && <Chip tone="positive">Conciliado</Chip>}
          {/* CRMLAB-57/D-197: requisição já existe, cartão ainda em "Novo orçamento". */}
          {preRegistered && <Chip tone="positive">Pré-cadastro feito</Chip>}
          {/* CRMLAB-59/D-207: "Novo orçamento" parado há N horas sem envio. */}
          {stale && <Chip tone="attention">Parado há {staleFor}</Chip>}
        </div>
        {proposal.approvalStatus === 'pending' && (
          <span className="text-caption text-accent-700 font-semibold">Aguardando aprovação</span>
        )}
      </div>
    </button>
  );
}
