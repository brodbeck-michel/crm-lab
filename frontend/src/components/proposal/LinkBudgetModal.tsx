import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ConversationDetail, ListProposalsQuery, Proposal } from '@crm-lab/shared';
import { bitlabSendTarget, canActOnCard, isCardOwner, nameSimilarity } from '@crm-lab/shared';
import { proposalsApi } from '@/api/proposals';
import { queryKeys } from '@/api/query-keys';
import { useFunnelRules } from '@/api/funnel-rules';
import { useInsuranceList } from '@/api/insurances';
import { useAuthStore } from '@/stores/auth.store';
import { formatIsoDay, formatMoney } from '@/lib/format';
import { Modal } from '@/components/shared';
import { Button, Chip, SearchInput, cn } from '@/components/ui';
import SendProposalPanel from './SendProposalPanel';

/**
 * "Vincular orçamento" do Atendimento (CRMLAB-129, D-298/D-299, PAGES.md §2).
 *
 * Da conversa aberta, a atendente escolhe um orçamento do Bitlab em "Novo
 * orçamento" ainda sem conversa e o envia por ESTA conversa — o mesmo
 * `POST /proposals/:id/send` do Pipeline (D-201), pelo mesmo painel
 * (`SendProposalPanel` com a conversa fixa). Não existe "só vincular": o
 * vínculo é sempre o envio da mensagem (decisão do PO).
 *
 * A lista não faz polling: a chave é `['proposals', filtros]`, que o WS de
 * proposta (`proposal.created`/`status_changed`/`updated`) já invalida.
 */

/** Quantos candidatos a tela considera (teto da listagem, D-009). */
const CANDIDATE_LIMIT = 100;

interface Candidate {
  proposal: Proposal;
  score: number;
}

/**
 * Os mais parecidos com o nome da conversa em cima (D-203, a mesma nota do
 * Pipeline); empate e nota zero ficam na ordem do servidor (mais novo antes).
 */
export function rankBudgets(conversationName: string | null, proposals: readonly Proposal[]): Candidate[] {
  return proposals
    .map((proposal, index) => ({
      proposal,
      score: nameSimilarity(conversationName, proposal.patientName),
      index,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ proposal, score }) => ({ proposal, score }));
}

interface LinkBudgetModalProps {
  conversation: ConversationDetail;
  onClose: () => void;
}

export function LinkBudgetModal({ conversation, onClose }: LinkBudgetModalProps) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Proposal | null>(null);
  const rules = useFunnelRules().data;
  const user = useAuthStore((s) => s.user);
  const { data: insurancesData } = useInsuranceList({ limit: 100 });

  const query: ListProposalsQuery = {
    status: 'novo_contato',
    withoutConversation: true,
    limit: CANDIDATE_LIMIT,
    ...(search ? { search } : {}),
  };
  const list = useQuery({
    queryKey: queryKeys.proposals(query),
    queryFn: () => proposalsApi.list(query),
  });

  // Mesma permissão do "Enviar" do cartão (§6c): dona/fila comum, admin, gestor com a trava.
  const candidates = useMemo(() => {
    if (!rules) return [];
    const role = user?.role ?? 'attendant';
    const allowed = (list.data?.proposals ?? []).filter((p) =>
      canActOnCard(rules.manualMoves, { role, isOwner: isCardOwner(p.createdBy, user?.id) }),
    );
    return rankBudgets(conversation.patientName, allowed);
  }, [list.data, rules, user, conversation.patientName]);

  const insuranceName = (proposal: Proposal): string =>
    proposal.insuranceId
      ? (insurancesData?.insurances.find((i) => i.id === proposal.insuranceId)?.name ?? 'Convênio')
      : 'Particular';

  const contactName = conversation.patientName ?? conversation.patientPhone;

  return (
    <Modal open onClose={onClose} title="Vincular orçamento">
      {selected && rules ? (
        <SendProposalPanel
          proposal={selected}
          mode="send"
          conversationId={conversation.id}
          insuranceName={insuranceName(selected)}
          templates={rules.sendMessage.templates}
          target={bitlabSendTarget(selected.lisRequisitionNumber, rules.automation)}
          onDone={onClose}
          onCancel={() => setSelected(null)}
        />
      ) : (
        <div className="space-y-sm">
          <p className="text-caption text-neutral-600">
            Orçamentos do Bitlab em “Novo orçamento” ainda sem conversa. O escolhido é enviado
            pelo WhatsApp para {contactName}.
          </p>
          <SearchInput
            placeholder="Buscar por nome ou nº do orçamento"
            aria-label="Buscar orçamento"
            onSearch={(term) => setSearch(term.trim())}
          />
          {list.isLoading || !rules ? (
            <p role="status" className="text-caption text-neutral-600">
              Carregando orçamentos…
            </p>
          ) : list.isError ? (
            <p role="alert" className="text-caption text-accent-700">
              Não foi possível carregar os orçamentos.
            </p>
          ) : candidates.length === 0 ? (
            <p className="text-caption text-neutral-600">
              Nenhum orçamento em “Novo orçamento” sem conversa.
            </p>
          ) : (
            <ul className="space-y-xs max-h-[360px] overflow-y-auto" aria-label="Orçamentos">
              {candidates.map(({ proposal, score }) => (
                <li key={proposal.id}>
                  <button
                    type="button"
                    data-testid="link-budget-candidate"
                    onClick={() => setSelected(proposal)}
                    className={cn(
                      'w-full text-left rounded-md border p-sm flex items-center justify-between gap-sm',
                      'border-neutral-200 bg-surface hover:border-accent-600',
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block text-label font-semibold truncate">
                        {proposal.patientName || 'Sem nome'}
                      </span>
                      <span className="block text-caption text-neutral-600">
                        Nº {proposal.lisBudgetNumber ?? '—'} · {formatMoney(proposal.totalPrice)}
                        {' · '}
                        {proposal.lisIssuedOn
                          ? formatIsoDay(proposal.lisIssuedOn)
                          : formatIsoDay(proposal.createdAt)}
                        {proposal.lisAttendantName ? ` · ${proposal.lisAttendantName}` : ''}
                      </span>
                    </span>
                    <span className="flex flex-[0_0_auto] items-center gap-xs">
                      {proposal.lisRequisitionNumber !== null && (
                        <Chip tone="inactive">Pré-cadastro feito</Chip>
                      )}
                      {score > 0 && <Chip tone="positive">Mais parecido</Chip>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose}>
              Fechar
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/**
 * Botão do painel de contexto. Some quando "Nascer do orçamento do Bitlab"
 * está desligada nas Regras (D-246) — inclusive enquanto as Regras carregam,
 * para não piscar num laboratório que não usa a integração — e em conversa
 * que não está ativa (o envio exige conversa ativa).
 */
export function LinkBudgetButton({ conversation }: { conversation: ConversationDetail }) {
  const [open, setOpen] = useState(false);
  const rules = useFunnelRules().data;
  if (rules?.origin?.fromBitlab !== true || conversation.status !== 'active') return null;
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Vincular orçamento
      </Button>
      {open && <LinkBudgetModal conversation={conversation} onClose={() => setOpen(false)} />}
    </>
  );
}
