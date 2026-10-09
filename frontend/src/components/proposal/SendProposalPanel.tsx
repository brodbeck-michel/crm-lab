import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  Conversation,
  ListConversationsQuery,
  ProposalDetail,
  SendMessageTemplate,
} from '@crm-lab/shared';
import {
  PROPOSAL_STATUS_LABELS,
  SEND_PROPOSAL_MESSAGE_MAX,
  nameSimilarity,
  renderSendMessageTemplate,
} from '@crm-lab/shared';
import { conversationsApi } from '@/api/conversations';
import { toHandledError } from '@/api';
import { queryKeys } from '@/api/query-keys';
import {
  useResendProposal,
  useSendProposal,
  useUpdateProposalConversation,
} from '@/api/proposals';
import { formatMoney } from '@/lib/format';
import { Button, Chip, SearchInput, Select, TextArea, cn } from '@/components/ui';

/**
 * Painel do cartão do Bitlab (CRMLAB-58, D-200..D-203, PAGES.md §6):
 * - `send`: confere os dados do Bitlab, escolhe a conversa (sugestão por nome
 *   no topo, busca livre), revisa a mensagem do modelo das Regras e envia
 *   (com 2+ modelos, escolhe qual — D-265 item 5);
 * - `resend`: só a mensagem, pela conversa já vinculada;
 * - `relink`: só a conversa, sem enviar nada.
 * Nunca vincula sozinho: o botão só liga depois que a atendente clica numa conversa.
 */
export type SendPanelMode = 'send' | 'resend' | 'relink';

interface SendProposalPanelProps {
  proposal: ProposalDetail;
  mode: SendPanelMode;
  /** Nome do convênio, ou "Particular" (`{convenio}` do modelo). */
  insuranceName: string;
  /** `sendMessage.templates` das Regras; o primeiro é o padrão (D-265). */
  templates: readonly SendMessageTemplate[];
  /** Para onde o envio leva o cartão (`bitlabSendTarget`). */
  target?: ProposalDetail['status'];
  onDone: () => void;
  onCancel: () => void;
}

/** Quantas conversas recentes a tela considera para sugerir (D-203). */
const CANDIDATE_LIMIT = 100;

interface Candidate {
  conversation: Conversation;
  score: number;
}

/** Sugeridas (nota > 0) em cima, da maior para a menor; o resto na ordem do servidor. */
export function rankCandidates(
  patientName: string | null,
  conversations: readonly Conversation[],
): { suggested: Candidate[]; others: Candidate[] } {
  const scored = conversations.map((conversation) => ({
    conversation,
    score: nameSimilarity(patientName, conversation.patientName),
  }));
  return {
    suggested: scored.filter((c) => c.score > 0).sort((a, b) => b.score - a.score),
    others: scored.filter((c) => c.score === 0),
  };
}

export default function SendProposalPanel({
  proposal,
  mode,
  insuranceName,
  templates,
  target,
  onDone,
  onCancel,
}: SendProposalPanelProps) {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const renderTemplate = (index: number): string =>
    renderSendMessageTemplate(templates[index]?.text ?? '', {
      paciente: proposal.patientName ?? '',
      numero_orcamento: proposal.lisBudgetNumber ?? '',
      valor: formatMoney(proposal.totalPrice),
      convenio: insuranceName,
    });
  const [templateIndex, setTemplateIndex] = useState(0);
  const [message, setMessage] = useState(() => renderTemplate(0));

  /**
   * Troca de modelo (D-265 item 5): sem edição, troca direto; com o texto
   * editado, pergunta antes de sobrescrever (cancelar mantém tudo).
   */
  const changeTemplate = (index: number) => {
    if (index === templateIndex) return;
    const edited = message !== renderTemplate(templateIndex);
    if (edited && !window.confirm('Trocar o modelo? O texto que você editou será substituído.')) {
      return;
    }
    setTemplateIndex(index);
    setMessage(renderTemplate(index));
  };
  const [error, setError] = useState<string | null>(null);

  const send = useSendProposal();
  const resend = useResendProposal();
  const relink = useUpdateProposalConversation();
  const pending = send.isPending || resend.isPending || relink.isPending;

  const pickConversation = mode !== 'resend';
  const writeMessage = mode !== 'relink';

  const query: ListConversationsQuery = {
    status: 'active',
    limit: CANDIDATE_LIMIT,
    ...(search ? { search } : {}),
  };
  const conversations = useQuery({
    queryKey: queryKeys.conversations(query),
    queryFn: () => conversationsApi.list(query),
    enabled: pickConversation,
  });

  const { suggested, others } = useMemo(
    () =>
      rankCandidates(
        proposal.patientName,
        (conversations.data?.conversations ?? []).filter(
          (c) => c.id !== proposal.conversationId,
        ),
      ),
    [conversations.data, proposal.patientName, proposal.conversationId],
  );

  const trimmed = message.trim();
  const canSubmit =
    !pending &&
    (!pickConversation || selectedId !== null) &&
    (!writeMessage || (trimmed.length > 0 && trimmed.length <= SEND_PROPOSAL_MESSAGE_MAX));

  const handlers = {
    onSuccess: () => onDone(),
    onError: (err: unknown) => setError(toHandledError(err).message),
  };

  const handleSubmit = () => {
    setError(null);
    if (mode === 'send' && selectedId) {
      send.mutate(
        { proposalId: proposal.id, body: { conversationId: selectedId, message: trimmed } },
        handlers,
      );
    } else if (mode === 'resend') {
      resend.mutate({ proposalId: proposal.id, body: { message: trimmed } }, handlers);
    } else if (mode === 'relink' && selectedId) {
      relink.mutate(
        { proposalId: proposal.id, body: { conversationId: selectedId } },
        handlers,
      );
    }
  };

  const renderCandidate = ({ conversation, score }: Candidate) => {
    const selected = conversation.id === selectedId;
    return (
      <li key={conversation.id}>
        <button
          type="button"
          aria-pressed={selected}
          onClick={() => setSelectedId(conversation.id)}
          className={cn(
            'w-full text-left rounded-md border p-sm flex items-center justify-between gap-sm',
            selected ? 'border-accent-600 bg-accent-100' : 'border-neutral-200 bg-surface',
          )}
        >
          <span className="min-w-0">
            <span className="block text-label font-semibold truncate">
              {conversation.patientName || 'Sem nome'}
            </span>
            <span className="block text-caption text-neutral-600">
              {conversation.patientPhone}
              {conversation.assignedToName ? ` · ${conversation.assignedToName}` : ' · Fila livre'}
            </span>
          </span>
          {score > 0 && <Chip tone="positive">Sugerida</Chip>}
        </button>
      </li>
    );
  };

  const title =
    mode === 'send' ? 'Enviar orçamento' : mode === 'resend' ? 'Reenviar mensagem' : 'Trocar conversa';

  return (
    <section className="space-y-lg border-t pt-lg" aria-label={title}>
      <h3 className="text-label font-semibold">{title}</h3>

      {mode === 'send' && (
        <dl className="grid grid-cols-2 gap-sm text-body">
          <dt className="text-caption text-neutral-600">Paciente no Bitlab</dt>
          <dd>{proposal.patientName ?? '—'}</dd>
          <dt className="text-caption text-neutral-600">Nº do orçamento</dt>
          <dd>{proposal.lisBudgetNumber ?? '—'}</dd>
          <dt className="text-caption text-neutral-600">Valor</dt>
          <dd>{formatMoney(proposal.totalPrice)}</dd>
          <dt className="text-caption text-neutral-600">Convênio</dt>
          <dd>{insuranceName}</dd>
          {target && (
            <>
              <dt className="text-caption text-neutral-600">Vai para</dt>
              <dd>{PROPOSAL_STATUS_LABELS[target]}</dd>
            </>
          )}
        </dl>
      )}

      {pickConversation && (
        <div className="space-y-sm">
          <p className="text-caption text-neutral-600">Conversa do paciente</p>
          <SearchInput
            placeholder="Buscar por nome ou telefone"
            aria-label="Buscar conversa"
            onSearch={(term) => {
              setSearch(term.trim());
              setSelectedId(null);
            }}
          />
          {conversations.isLoading ? (
            <p className="text-caption text-neutral-600">Carregando conversas…</p>
          ) : suggested.length + others.length === 0 ? (
            <p className="text-caption text-neutral-600">Nenhuma conversa aberta encontrada.</p>
          ) : (
            <ul className="space-y-xs max-h-[280px] overflow-y-auto" aria-label="Conversas">
              {suggested.map(renderCandidate)}
              {others.map(renderCandidate)}
            </ul>
          )}
        </div>
      )}

      {writeMessage && templates.length > 1 && (
        <Select
          label="Modelo da mensagem"
          value={String(templateIndex)}
          options={templates.map((t, index) => ({ value: String(index), label: t.name }))}
          onChange={(e) => changeTemplate(Number(e.target.value))}
        />
      )}

      {writeMessage && (
        <TextArea
          label="Mensagem"
          rows={4}
          value={message}
          maxLength={SEND_PROPOSAL_MESSAGE_MAX}
          onChange={(e) => setMessage(e.target.value)}
        />
      )}

      {error && (
        <p role="alert" className="text-caption text-accent-700">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-sm">
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
        <Button variant="primary" onClick={handleSubmit} disabled={!canSubmit} loading={pending}>
          {mode === 'relink' ? 'Trocar conversa' : mode === 'resend' ? 'Reenviar' : 'Enviar'}
        </Button>
      </div>
    </section>
  );
}
