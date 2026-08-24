import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ProposalDetail } from '@crm-lab/shared';
import { api, isApiError, queryKeys, queryScopes } from '@/api';
import { Button, TextArea, useToast } from '@/components/ui';
import { useApiErrorHandler } from '@/hooks';
import { formatPercent } from '@/lib/format';

/**
 * [Aprovar] / [Rejeitar] do canal `#aprovacoes` — PAGES.md §9 e WORKFLOWS.md §3.
 *
 * O QUE ESTE COMPONENTE NÃO FAZ: decidir se a aprovação é permitida. A alçada
 * é do BACKEND (CLAUDE.md §3) — aqui só existe UX. Em especial a
 * auto-aprovação (D-046): o gestor VÊ o botão na própria proposta e o clique
 * SEMPRE falha com `FORBIDDEN { reason: 'self_approval' }`. Por isso nada de
 * otimismo: nenhum `setQueryData`, nenhum estado local de "aprovado" — só
 * invalidação e um toast que explica o motivo real.
 *
 * Rejeição exige motivo (texto livre, 1..500 no servidor).
 */

export interface ApprovalActionsProps {
  proposal: ProposalDetail;
}

/** Erros com UX própria, tratados por CÓDIGO (API_ERRORS.md), nunca por mensagem. */
function approvalErrorMessage(error: unknown): string | null {
  if (!isApiError(error)) return null;

  if (error.code === 'FORBIDDEN' && error.details?.reason === 'self_approval') {
    return 'Você não pode aprovar a própria proposta. Peça a decisão a outro gestor.';
  }

  if (error.code === 'APPROVAL_NOT_ALLOWED') {
    const limit = Number(error.details?.approverLimit);
    return Number.isFinite(limit)
      ? `Desconto acima da sua alçada de ${formatPercent(limit / 100)}. Só um admin pode aprovar.`
      : 'Desconto acima da sua alçada. Só um admin pode aprovar.';
  }

  return null;
}

export function ApprovalActions({ proposal }: ApprovalActionsProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const handleApiError = useApiErrorHandler();

  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>(undefined);

  /** A decisão mexe na proposta E no canal (o serviço posta o resultado lá). */
  const invalidateDecision = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.proposal(proposal.id) }),
      queryClient.invalidateQueries({ queryKey: queryScopes.proposals }),
      queryClient.invalidateQueries({ queryKey: queryScopes.internalChat }),
    ]);
  };

  const onDecisionError = (error: unknown) => {
    const message = approvalErrorMessage(error);
    if (message !== null) {
      toast(message, { tone: 'attention' });
      return;
    }
    handleApiError(error);
  };

  const approve = useMutation({
    mutationFn: () => api.proposals.approve(proposal.id),
    onSuccess: async () => {
      toast('Desconto aprovado.', { tone: 'positive' });
      await invalidateDecision();
    },
    onError: onDecisionError,
  });

  const reject = useMutation({
    mutationFn: (motivo: string) => api.proposals.reject(proposal.id, { reason: motivo }),
    onSuccess: async () => {
      toast('Desconto rejeitado.', { tone: 'positive' });
      setRejecting(false);
      setReason('');
      await invalidateDecision();
    },
    onError: onDecisionError,
  });

  const submitRejection = () => {
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      setReasonError('Informe o motivo da rejeição.');
      return;
    }
    setReasonError(undefined);
    reject.mutate(trimmed);
  };

  const busy = approve.isPending || reject.isPending;

  return (
    <div data-testid="approval-actions" className="flex flex-col gap-sm">
      <div className="flex flex-wrap items-center gap-sm">
        <Button
          variant="confirmation"
          size="sm"
          loading={approve.isPending}
          disabled={busy}
          onClick={() => approve.mutate()}
        >
          Aprovar
        </Button>

        <Button
          variant="destructive"
          size="sm"
          disabled={busy}
          onClick={() => setRejecting((open) => !open)}
          aria-expanded={rejecting}
        >
          Rejeitar
        </Button>
      </div>

      {rejecting && (
        <div className="flex flex-col gap-sm">
          <TextArea
            label="Motivo da rejeição"
            value={reason}
            error={reasonError}
            rows={2}
            placeholder="Ex.: desconto acima do praticado para este convênio"
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="flex items-center gap-sm">
            <Button
              size="sm"
              loading={reject.isPending}
              disabled={busy}
              onClick={submitRejection}
            >
              Confirmar rejeição
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => {
                setRejecting(false);
                setReasonError(undefined);
              }}
            >
              Cancelar
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
