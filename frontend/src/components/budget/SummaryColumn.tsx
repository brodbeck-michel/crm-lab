import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCreateProposal } from '@/api/proposals';
import { useApiErrorHandler } from '@/hooks';
import { useAuthStore } from '@/stores/auth.store';
import { useUIStore } from '@/stores/ui.store';
import { Button, Chip } from '@/components/ui';
import DiscountSection from '@/components/proposal/DiscountSection';
import { MoneyDisplay } from '@/components/shared/MoneyDisplay';
import { calculateTotal } from '@crm-lab/shared';

interface BudgetItem {
  examId: string;
  examName: string;
  unitPrice: number;
  quantity: number;
  priceSource: 'insurance' | 'private';
}

interface SummaryColumnProps {
  conversationId?: string;
  items: BudgetItem[];
  /** Convênio da proposta em montagem (D-082). `null` = particular. */
  insuranceId: string | null;
  onRemoveItem: (examId: string) => void;
}

export default function SummaryColumn({
  conversationId,
  items,
  insuranceId,
  onRemoveItem,
}: SummaryColumnProps) {
  const user = useAuthStore((s) => s.user);
  const [discountPercent, setDiscountPercent] = useState(0);

  const navigate = useNavigate();
  const openModal = useUIStore((s) => s.openModal);
  const handleApiError = useApiErrorHandler();
  const createProposal = useCreateProposal();

  // Convert items to the format expected by calculateTotal
  const itemsForCalc = items.map((item) => ({
    unitPrice: item.unitPrice,
    quantity: item.quantity,
  }));

  const subtotal = items.reduce(
    (sum, item) => sum + item.unitPrice * item.quantity,
    0
  );
  const total = calculateTotal(itemsForCalc, discountPercent);

  /**
   * Depois de criada, a proposta some do fluxo de montagem — o lugar dela é o
   * pipeline. Reabrir aqui como modal (mesmo mecanismo do drag-and-drop em
   * `Proposals.tsx`) poupa o usuário de caçar o card recém-criado na tela.
   */
  const handleCreateProposal = () => {
    if (!conversationId || items.length === 0) return;

    createProposal.mutate(
      {
        conversationId,
        items: items.map((item) => ({
          examId: item.examId,
          quantity: item.quantity,
        })),
        discountPercent,
        insuranceId,
      },
      {
        onSuccess: (proposal) => {
          navigate('/proposals');
          openModal({ kind: 'proposal', id: proposal.id });
        },
        onError: handleApiError,
      },
    );
  };

  return (
    <div className="flex flex-col gap-lg p-lg h-full">
      <h2 className="font-heading text-section">Resumo</h2>

      <div className="flex-1 overflow-y-auto min-h-0">
        {items.length === 0 ? (
          <p className="text-body text-neutral-600">Nenhum exame adicionado</p>
        ) : (
          <div data-testid="summary-items" className="space-y-sm">
            {items.map((item) => (
              <div
                key={item.examId}
                className="flex justify-between items-center text-body p-sm rounded-md hover:bg-accent-100"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{item.examName}</p>
                  <p className="text-caption text-neutral-600">
                    Qtd: {item.quantity}
                  </p>
                </div>
                <div className="flex items-center gap-sm flex-shrink-0">
                  {/*
                    Convênio selecionado mas ESTE item caiu no preço
                    particular (sem tabela própria no convênio) — exceção que
                    precisa ficar visível. Com `insuranceId` null tudo já é
                    particular; o badge seria redundante.
                  */}
                  {insuranceId && item.priceSource === 'private' && (
                    <span data-testid="price-source-badge">
                      <Chip tone="inactive" title="Sem tabela para este convênio — preço particular">
                        Particular
                      </Chip>
                    </span>
                  )}
                  <MoneyDisplay value={item.unitPrice * item.quantity} />
                  <button
                    onClick={() => onRemoveItem(item.examId)}
                    className="text-neutral-600 hover:text-accent-600 text-section leading-none"
                    aria-label={`Remover ${item.examName}`}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-lg border-t pt-lg">
        <div className="space-y-xs text-body">
          <div className="flex justify-between">
            <span className="text-neutral-600">Subtotal</span>
            <MoneyDisplay value={subtotal} />
          </div>
        </div>

        <DiscountSection
          discountPercent={discountPercent}
          discountLimit={user?.discountLimit || 0}
          onChange={setDiscountPercent}
        />

        <div className="border-t pt-md">
          <div className="flex justify-between font-heading text-section">
            <span>Total</span>
            <MoneyDisplay value={total} />
          </div>
        </div>

        <Button
          variant="primary"
          onClick={handleCreateProposal}
          disabled={items.length === 0 || createProposal.isPending}
          loading={createProposal.isPending}
        >
          Criar Orçamento
        </Button>
      </div>
    </div>
  );
}
