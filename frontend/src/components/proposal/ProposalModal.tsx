import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ProposalStatus, LossReason } from '@crm-lab/shared';
import { formatProposalNumber, isProposalEditable } from '@crm-lab/shared';
import { useProposalDetail, useUpdateProposalStatus, useUpdateProposalItems } from '@/api/proposals';
import { useInsuranceList } from '@/api/insurances';
import { useApiErrorHandler } from '@/hooks';
import { formatMoney } from '@/lib/format';
import { Modal, MoneyDisplay } from '@/components/shared';
import { Button, Chip, Input } from '@/components/ui';
import ItemsList from './ItemsList';
import EditableItemsList, { type EditableProposalItem } from './EditableItemsList';
import DiscountSection from './DiscountSection';
import ApprovalAlert from './ApprovalAlert';
import StageHistory from './StageHistory';
import ActionsRow from './ActionsRow';
import LostReasonForm from './LostReasonForm';

interface ProposalModalProps {
  proposalId: string;
  onClose: () => void;
}

export default function ProposalModal({ proposalId, onClose }: ProposalModalProps) {
  const { data: proposal, isLoading } = useProposalDetail(proposalId);
  const updateStatus = useUpdateProposalStatus();
  const navigate = useNavigate();
  const handleApiError = useApiErrorHandler();
  // Sem `active: true`: uma proposta pode referenciar um convênio já
  // desativado, e o nome ainda precisa resolver. `limit: 100` é o teto
  // documentado de `GET /insurances` (API_CONTRACTS.md §8) — não existe
  // `GET /insurances/:id` no contrato, então isto é o único jeito de resolver
  // um nome a partir de um id sem inventar endpoint (Regra Zero). Efeito
  // colateral aceito: um tenant com MAIS de 100 convênios cujo
  // `insuranceId` caia fora dessa primeira página resolve para o fallback
  // genérico "Convênio" abaixo — indistinguível, na tela, do estado "ainda
  // carregando" ou de um convênio removido. Hoje os tenants semeados têm
  // ~20 convênios (docs/STATUS.md); risco aceito, não corrigido nesta task.
  const { data: insurancesData } = useInsuranceList({ limit: 100 });
  const [showLostForm, setShowLostForm] = useState(false);
  const updateItems = useUpdateProposalItems();

  // CRMLAB-12/D-132: itens/desconto/médico só editáveis nestes estágios —
  // mesma constante que o backend usa em `PATCH /proposals/:id/items`.
  const [isEditing, setIsEditing] = useState(false);
  const [editItems, setEditItems] = useState<EditableProposalItem[]>([]);
  const [editDiscount, setEditDiscount] = useState(0);
  const [editDoctor, setEditDoctor] = useState('');

  if (isLoading || !proposal) {
    return null;
  }

  const canEdit = isProposalEditable(proposal.status);

  const handleStartEdit = () => {
    setEditItems(
      proposal.items.map((item) => ({
        examId: item.examId,
        examName: item.examName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        priceSource: item.priceSource,
      })),
    );
    setEditDiscount(proposal.discountPercent);
    setEditDoctor(proposal.requestingDoctor ?? '');
    setIsEditing(true);
  };

  const handleSaveEdit = () => {
    updateItems.mutate(
      {
        proposalId,
        items: editItems.map((item) => ({ examId: item.examId, quantity: item.quantity })),
        discountPercent: editDiscount,
        requestingDoctor: editDoctor || null,
      },
      {
        onSuccess: () => setIsEditing(false),
        onError: handleApiError,
      },
    );
  };

  // `Proposal`/`ProposalDetail` não embutem o nome do convênio (só o id) —
  // resolvido aqui via `useInsuranceList`. Enquanto a lista carrega, mostra
  // um rótulo genérico em vez de nada (ajuste de UX menor, não bloqueante).
  const insuranceName = proposal.insuranceId
    ? (insurancesData?.insurances.find((insurance) => insurance.id === proposal.insuranceId)
        ?.name ?? 'Convênio')
    : 'Particular';

  const handleChangeStatus = (newStatus: ProposalStatus) => {
    updateStatus.mutate({ proposalId, status: newStatus });
  };

  const handleMarkWon = () => {
    updateStatus.mutate({ proposalId, status: 'ganho' });
  };

  const handleMarkLost = (reasonLost: LossReason) => {
    updateStatus.mutate({ proposalId, status: 'perdido', reasonLost });
    setShowLostForm(false);
  };

  /**
   * "Enviar orçamento": avança para `orcamento_enviado` (só transição válida
   * de `novo_contato` além de `perdido`) E leva para a conversa do paciente
   * com a mensagem já pronta — um clique faz as duas coisas, em vez de
   * exigir mudar o estágio manualmente depois de mandar a mensagem.
   */
  const handleSendProposal = () => {
    const message = `Olá! Segue o orçamento nº ${formatProposalNumber(proposal.proposalNumber)}, no valor de ${formatMoney(proposal.totalPrice)}.`;
    updateStatus.mutate(
      { proposalId, status: 'orcamento_enviado' },
      {
        onSuccess: () => {
          onClose();
          navigate(
            `/attendance?conversationId=${proposal.conversationId}&draft=${encodeURIComponent(message)}`,
          );
        },
        onError: handleApiError,
      },
    );
  };

  return (
    <Modal open onClose={onClose} title={proposal.patientName || 'Proposta'}>
      <div className="space-y-xl">
        <div className="space-y-lg">
          <p className="text-caption text-neutral-600">
            {formatProposalNumber(proposal.proposalNumber)}
          </p>

          <div className="flex items-center justify-between gap-sm">
            <div className="flex items-center gap-sm">
              <span className="text-caption text-neutral-600">Convênio</span>
              <Chip tone="inactive">{insuranceName}</Chip>
            </div>
            {/* CRMLAB-12/D-132: some fora de novo_contato/orcamento_enviado. */}
            {canEdit && !isEditing && !showLostForm && (
              <Button variant="secondary" size="sm" onClick={handleStartEdit}>
                Editar
              </Button>
            )}
          </div>

          {isEditing ? (
            <>
              <Input
                label="Médico solicitante (opcional)"
                value={editDoctor}
                onChange={(e) => setEditDoctor(e.target.value)}
                placeholder="Nome do médico"
                maxLength={255}
              />

              <EditableItemsList
                items={editItems}
                insuranceId={proposal.insuranceId}
                onChange={setEditItems}
              />

              <DiscountSection
                discountPercent={editDiscount}
                discountLimit={100}
                onChange={setEditDiscount}
              />

              <div className="border-t pt-md">
                <div className="flex justify-between">
                  <span className="font-semibold">Total</span>
                  <MoneyDisplay
                    value={
                      editItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0) *
                      (1 - editDiscount / 100)
                    }
                  />
                </div>
              </div>

              <div className="flex justify-end gap-sm">
                <Button variant="secondary" onClick={() => setIsEditing(false)}>
                  Cancelar
                </Button>
                <Button
                  variant="primary"
                  loading={updateItems.isPending}
                  disabled={editItems.length === 0}
                  onClick={handleSaveEdit}
                >
                  Salvar
                </Button>
              </div>
            </>
          ) : (
            <>
              {/* CRMLAB-9: só aparece quando há médico informado — sem linha vazia. */}
              {proposal.requestingDoctor && (
                <div className="flex items-center gap-sm">
                  <span className="text-caption text-neutral-600">Médico solicitante</span>
                  <span className="text-body">{proposal.requestingDoctor}</span>
                </div>
              )}

              <ItemsList items={proposal.items} insuranceId={proposal.insuranceId} />

              <DiscountSection
                discountPercent={proposal.discountPercent}
                discountLimit={100}
                onChange={() => {}}
                readOnly
              />

              <div className="border-t pt-md">
                <div className="flex justify-between">
                  <span className="font-semibold">Total</span>
                  <MoneyDisplay value={proposal.totalPrice} />
                </div>
              </div>
            </>
          )}

          {proposal.approvalStatus === 'pending' && (
            <ApprovalAlert />
          )}

          <StageHistory history={proposal.history} />
        </div>

        {isEditing ? null : showLostForm ? (
          <LostReasonForm
            onSubmit={handleMarkLost}
            isPending={updateStatus.isPending}
          />
        ) : (
          <ActionsRow
            status={proposal.status}
            onChangeStatus={handleChangeStatus}
            onMarkWon={handleMarkWon}
            onMarkLost={() => setShowLostForm(true)}
            onSendProposal={handleSendProposal}
            isPending={updateStatus.isPending}
          />
        )}
      </div>
    </Modal>
  );
}
