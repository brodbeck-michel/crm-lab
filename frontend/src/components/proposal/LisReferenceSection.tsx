import { useState } from 'react';
import type { LisBudgetValues, ProposalDetail } from '@crm-lab/shared';
import { formatProposalNumber } from '@crm-lab/shared';
import { ApiError } from '@/api/client';
import { useUpdateProposalLisReference } from '@/api/proposals';
import { formatIsoDay, formatPercent } from '@/lib/format';
import { MoneyDisplay } from '@/components/shared';
import { Button, Chip, Input, Tooltip, useToast } from '@/components/ui';

/**
 * Valores do orçamento do LIS no convênio principal (CRMLAB-114, D-278). Sem
 * desconto nem acréscimo, uma linha só com o valor; com eles, bruto, desconto
 * (R$ e %), acréscimo e o valor a pagar. O percentual é só informativo — o
 * Bitlab às vezes manda 0 com desconto em reais — e some quando não ajuda.
 */
function LisBudgetValuesLine({ values }: { values: LisBudgetValues }) {
  if (values.discountValue === 0 && values.surchargeValue === 0) {
    return (
      <p className="text-caption text-neutral-600">
        Valor no LIS: <MoneyDisplay value={values.netValue} />
      </p>
    );
  }
  const percent = values.discountPercent;
  return (
    <p className="text-caption text-neutral-600">
      Valor no LIS: bruto <MoneyDisplay value={values.grossValue} />
      {values.discountValue !== 0 && (
        <>
          {' · '}desconto <MoneyDisplay value={values.discountValue} />
          {percent !== null && percent > 0 && <> ({formatPercent(percent / 100, Number.isInteger(percent) ? 0 : 2)})</>}
        </>
      )}
      {values.surchargeValue !== 0 && (
        <>
          {' · '}acréscimo <MoneyDisplay value={values.surchargeValue} />
        </>
      )}
      {' · '}a pagar <MoneyDisplay value={values.netValue} />
    </p>
  );
}

/**
 * Nº do orçamento no LIS (PAGES.md §6, CRMLAB-52, D-119). O vínculo é o que
 * permite a conciliação (D-252): pagamento no Bitlab leva a proposta a `ganho`,
 * requisição leva a `negociacao`, cada um pela regra das Regras. Em `ganho` o
 * campo é só leitura (o backend recusa com PROPOSAL_ALREADY_CLOSED).
 */
export default function LisReferenceSection({ proposal }: { proposal: ProposalDetail }) {
  const update = useUpdateProposalLisReference();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Na origem `bitlab` o número é a identidade do cartão (CRMLAB-57, D-195 item 7).
  const readOnly = proposal.status === 'ganho' || proposal.origin === 'bitlab';
  // D-252 item 4: perdida não reabre sozinha; a atendente decide o que fazer.
  const lisAfterLoss =
    proposal.status === 'perdido' &&
    (proposal.lisRequisitionNumber !== null || proposal.lisPaidOn !== null);

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
            toast('Pagamento já registrado no LIS — proposta marcada como ganha', {
              tone: 'positive',
            });
          } else if (detail.status === 'negociacao' && proposal.status !== 'negociacao') {
            toast('Requisição já aberta no LIS — proposta em negociação', { tone: 'positive' });
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
        {/* D-252: o cartão do Bitlab mostra o selo no bloco do orçamento (ProposalModal). */}
        {proposal.origin === 'crm' &&
          proposal.status === 'novo_contato' &&
          proposal.lisRequisitionNumber !== null && <Chip tone="positive">Pré-cadastro feito</Chip>}
        {proposal.lisReconciledAt && (
          <Tooltip content={`Requisição Nº ${proposal.lisRequisitionNumber ?? '—'} no LIS`}>
            <Chip tone="positive">Conciliado</Chip>
          </Tooltip>
        )}
      </div>

      {!editing && proposal.lisBudgetValues && (
        <LisBudgetValuesLine values={proposal.lisBudgetValues} />
      )}

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

      {lisAfterLoss && (
        <div className="flex items-center gap-xs">
          <Chip tone="attention">Conflito com o LIS</Chip>
          <span className="text-caption text-neutral-600">
            O LIS tem {proposal.lisPaidOn !== null ? 'pagamento' : 'requisição'} para este orçamento,
            mas a proposta está perdida e não reabre sozinha.
          </span>
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
