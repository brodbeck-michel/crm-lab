import type { ConversationDetail, Proposal } from '@crm-lab/shared';
import { PROPOSAL_STATUS_LABELS, TERMINAL_STATUSES } from '@crm-lab/shared';
import { Button, Chip } from '@/components/ui';
import { Avatar, DateDisplay, EmptyState, MoneyDisplay } from '@/components/shared';

/**
 * Coluna 3 do inbox (316px, recolhível) — PAGES.md §2.
 * Cadastro resumido · propostas da conversa (cartões clicáveis) · tags.
 */

export interface PatientContextProps {
  conversation: ConversationDetail | null;
  proposals: Proposal[];
  isLoading: boolean;
  isError: boolean;
  /**
   * Abre o Modal da Proposta (PAGES.md §6) — implementado por outro agente.
   * TODO(Agent-UI-Proposals): o `activeModal` já é setado aqui; falta só o
   * componente de modal ser montado na árvore.
   */
  onOpenProposal: (proposalId: string) => void;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-micro font-semibold uppercase text-neutral-600">{label}</span>
      <span className="truncate text-body text-text">{value}</span>
    </div>
  );
}

export function PatientContext({
  conversation,
  proposals,
  isLoading,
  isError,
  onOpenProposal,
}: PatientContextProps) {
  if (!conversation) {
    return <EmptyState message="Sem paciente em foco" hint="Abra uma conversa para ver o cadastro." />;
  }

  const displayName = conversation.patientName ?? conversation.patientPhone;
  const custom = Object.entries(conversation.customFields);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-lg px-lg py-lg font-body">
      <div className="flex items-center gap-md">
        <Avatar name={displayName} size={44} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-label font-semibold text-text">{displayName}</span>
          <span className="truncate text-caption text-neutral-600">{conversation.patientPhone}</span>
        </div>
      </div>

      <section className="flex flex-col gap-sm">
        <h2 className="m-0 font-heading text-section text-text">Cadastro</h2>
        <Field label="Telefone" value={conversation.patientPhone} />
        <Field label="E-mail" value={conversation.patientEmail ?? 'Não informado'} />
        <Field label="Canal" value={conversation.channel} />
        <Field
          label="Atendente"
          value={conversation.assignedToName ?? 'Na fila (sem atendente)'}
        />
        {custom.map(([key, value]) => (
          <Field key={key} label={key} value={value} />
        ))}
      </section>

      <section className="flex flex-col gap-sm">
        <h2 className="m-0 font-heading text-section text-text">Propostas</h2>

        {isLoading && (
          <p role="status" className="m-0 text-caption text-neutral-600">
            Carregando propostas…
          </p>
        )}

        {!isLoading && isError && (
          <p role="alert" className="m-0 text-caption text-accent-700">
            Não foi possível carregar as propostas desta conversa.
          </p>
        )}

        {!isLoading && !isError && proposals.length === 0 && (
          <EmptyState
            message="Nenhuma proposta ainda"
            hint="Crie um orçamento a partir desta conversa."
          />
        )}

        {!isLoading &&
          !isError &&
          proposals.map((proposal) => (
            <Button
              key={proposal.id}
              variant="secondary"
              onClick={() => onOpenProposal(proposal.id)}
            >
              <span
                data-testid="context-proposal"
                className="flex min-w-0 flex-1 flex-col gap-xs text-left"
              >
                <span className="flex items-baseline gap-sm">
                  <MoneyDisplay value={proposal.totalPrice} emphasis />
                  <span className="ml-auto text-micro tracking-normal text-neutral-600">
                    <DateDisplay value={proposal.createdAt} variant="relative" />
                  </span>
                </span>
                <span className="flex items-center gap-sm">
                  <Chip
                    tone={
                      proposal.approvalStatus === 'pending'
                        ? 'attention'
                        : TERMINAL_STATUSES.includes(proposal.status)
                          ? 'positive'
                          : 'inactive'
                    }
                  >
                    {proposal.approvalStatus === 'pending'
                      ? 'Aprovação pendente'
                      : PROPOSAL_STATUS_LABELS[proposal.status]}
                  </Chip>
                </span>
              </span>
            </Button>
          ))}
      </section>

      <section className="flex flex-col gap-sm">
        <h2 className="m-0 font-heading text-section text-text">Tags</h2>
        {conversation.tags.length === 0 ? (
          <p className="m-0 text-caption text-neutral-600">Nenhuma tag nesta conversa.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-sm">
            {conversation.tags.map((tag) => (
              <Chip key={tag} tone="positive">
                {tag}
              </Chip>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
