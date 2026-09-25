import { useState } from 'react';
import type { ProposalDetail } from '@crm-lab/shared';
import { formatProposalNumber } from '@crm-lab/shared';
import { ApiError } from '@/api/client';
import { useUpdateProposalLisReference } from '@/api/proposals';
import { formatIsoDay } from '@/lib/format';
import { MoneyDisplay } from '@/components/shared';
import { Button, Chip, Input, Tooltip, useToast } from '@/components/ui';

/**
 * Nº do orçamento no LIS (PAGES.md §6, CRMLAB-52, D-119). O vínculo é o que
 * permite a conciliação: quando esse orçamento aparece com requisição no
 * Bitlab, a proposta vai para `ganho` sozinha. Em `ganho` o campo é só leitura
 * (o backend recusa com PROPOSAL_ALREADY_CLOSED).
 */
export default function LisReferenceSection({ proposal }: { proposal: ProposalDetail }) {
  const update = useUpdateProposalLisReference();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const readOnly = proposal.status === 'ganho';

  const startEdit = () => {
    setValue(proposal.lisBudgetNumber ?? '');
    setError(null);
    setEditing(true);
  };

  const save = () => {
    const trimmed = value.trim();
    if (trimmed === '' && !window.confirm('Desvincular do orçamento do LIS?')) return;
    update.mutate(
      { proposalId: proposal.id, lisBudgetNumber: trimmed === '' ? null : trimmed },
      {
        onSuccess: (detail) => {
          setEditing(false);
          if (detail.status === 'ganho' && proposal.status !== 'ganho') {
            toast('Orçamento já convertido no LIS — proposta marcada como ganha', {
              tone: 'positive',
            });
          }
        },
        onError: (err) => {
          const details = err instanceof ApiError ? err.details : undefined;
          if (details?.reason === 'lis_budget_number_taken') {
            const other = typeof details.proposalNumber === 'number' ? details.proposalNumber : null;
            setError(
              other !== null
                ? `Este orçamento já está vinculado à proposta ${formatProposalNumber(other)}`
                : 'Este orçamento já está vinculado a outra proposta',
            );
          } else if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') {
            setError('Informe só os dígitos do orçamento');
          } else {
            setError('Não foi possível salvar o número do orçamento');
          }
        },
      },
    );
  };

  return (
    <div className="space-y-sm">
      <div className="flex items-center gap-sm">
        <span className="text-caption text-neutral-600">Nº do orçamento no LIS</span>
        {!editing &&
          (proposal.lisBudgetNumber ? (
            <>
              <span className="text-body">{proposal.lisBudgetNumber}</span>
              {!readOnly && (
                <Button variant="secondary" size="sm" onClick={startEdit}>
                  Alterar
                </Button>
              )}
            </>
          ) : readOnly ? (
            <span className="text-body text-neutral-600">—</span>
          ) : (
            <Button variant="secondary" size="sm" onClick={startEdit}>
              Informar
            </Button>
          ))}
        {proposal.lisReconciledAt && (
          <Tooltip content={`Requisição Nº ${proposal.lisRequisitionNumber ?? '—'} no LIS`}>
            <Chip tone="positive">Conciliado</Chip>
          </Tooltip>
        )}
      </div>

      {editing && (
        <div className="flex items-end gap-sm">
          <Input
            label="Nº do orçamento no LIS"
            inputMode="numeric"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            placeholder="Ex.: 1234"
            maxLength={20}
            error={error ?? undefined}
          />
          <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>
            Cancelar
          </Button>
          <Button variant="primary" size="sm" loading={update.isPending} onClick={save}>
            Salvar
          </Button>
        </div>
      )}

      {proposal.lisPaidValue !== null && proposal.lisPaidValue > 0 && (
        <p className="text-caption text-neutral-600">
          Pago no LIS: <MoneyDisplay value={proposal.lisPaidValue} />
          {proposal.lisPaidOn && <> em {formatIsoDay(proposal.lisPaidOn)}</>}
        </p>
      )}
    </div>
  );
}
