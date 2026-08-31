import { useState } from 'react';
import type { ProposalStatus, LossReason } from '@crm-lab/shared';
import { useProposalDetail, useUpdateProposalStatus } from '@/api/proposals';
import { useInsuranceList } from '@/api/insurances';
import { Modal, MoneyDisplay } from '@/components/shared';
import { Chip } from '@/components/ui';
import ItemsList from './ItemsList';
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
  // Sem `active: true`: uma proposta pode referenciar um convênio já
  // desativado, e o nome ainda precisa resolver.
  const { data: insurancesData } = useInsuranceList({ limit: 100 });
  const [showLostForm, setShowLostForm] = useState(false);

  if (isLoading || !proposal) {
    return null;
  }

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

  return (
    <Modal open onClose={onClose} title={proposal.patientName || 'Proposta'}>
      <div className="space-y-xl">
        <div className="space-y-lg">
          <div className="flex items-center gap-sm">
            <span className="text-caption text-neutral-600">Convênio</span>
            <Chip tone="inactive">{insuranceName}</Chip>
          </div>

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

          {proposal.approvalStatus === 'pending' && (
            <ApprovalAlert />
          )}

          <StageHistory history={proposal.history} />
        </div>

        {showLostForm ? (
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
            isPending={updateStatus.isPending}
          />
        )}
      </div>
    </Modal>
  );
}
