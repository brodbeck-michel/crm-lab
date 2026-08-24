import { useState } from 'react';
import { useCreateProposal } from '@/api/proposals';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/ui';
import DiscountSection from '@/components/proposal/DiscountSection';
import { MoneyDisplay } from '@/components/shared/MoneyDisplay';
import { calculateTotal } from '@crm-lab/shared';

interface BudgetItem {
  examId: string;
  examName: string;
  unitPrice: number;
  quantity: number;
}

interface SummaryColumnProps {
  conversationId?: string;
  items: BudgetItem[];
  onRemoveItem: (examId: string) => void;
}

export default function SummaryColumn({
  conversationId,
  items,
  onRemoveItem,
}: SummaryColumnProps) {
  const user = useAuthStore((s) => s.user);
  const [discountPercent, setDiscountPercent] = useState(0);

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

  const handleCreateProposal = () => {
    if (!conversationId || items.length === 0) return;

    createProposal.mutate({
      conversationId,
      items: items.map((item) => ({
        examId: item.examId,
        quantity: item.quantity,
      })),
      discountPercent,
    });
  };

  return (
    <div className="flex flex-col gap-4 p-5 h-full">
      <h2 className="font-heading text-section">Resumo</h2>

      <div className="flex-1 overflow-y-auto min-h-0">
        {items.length === 0 ? (
          <p className="text-body text-neutral-600">Nenhum exame adicionado</p>
        ) : (
          <div data-testid="summary-items" className="space-y-2">
            {items.map((item) => (
              <div
                key={item.examId}
                className="flex justify-between items-center text-body p-2 rounded-md hover:bg-accent-100"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{item.examName}</p>
                  <p className="text-caption text-neutral-600">
                    Qtd: {item.quantity}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
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

      <div className="space-y-4 border-t pt-4">
        <div className="space-y-1 text-body">
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

        <div className="border-t pt-3">
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
