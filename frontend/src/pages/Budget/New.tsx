import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BudgetLayout } from '@/components/layout/BudgetLayout';
import CatalogSegments from '@/components/budget/CatalogSegments';
import SummaryColumn from '@/components/budget/SummaryColumn';

interface BudgetItem {
  examId: string;
  examName: string;
  unitPrice: number;
  quantity: number;
  /** Origem do preço no momento em que o item foi adicionado (Onda 7). */
  priceSource: 'insurance' | 'private';
}

export default function BudgetNew() {
  const [searchParams] = useSearchParams();
  const conversationId = searchParams.get('conversationId') || '';
  const [items, setItems] = useState<BudgetItem[]>([]);
  /** Convênio da proposta em montagem (D-082). `null` = particular. */
  const [insuranceId, setInsuranceId] = useState<string | null>(null);

  const handleAddItem = (
    examId: string,
    examName: string,
    price: number,
    priceSource: 'insurance' | 'private'
  ) => {
    const existingItem = items.find((item) => item.examId === examId);
    if (existingItem) {
      setItems(
        items.map((item) =>
          item.examId === examId ? { ...item, quantity: item.quantity + 1 } : item
        )
      );
    } else {
      setItems([...items, { examId, examName, unitPrice: price, quantity: 1, priceSource }]);
    }
  };

  const handleRemoveItem = (examId: string) => {
    setItems(items.filter((item) => item.examId !== examId));
  };

  return (
    <BudgetLayout
      catalog={
        <CatalogSegments
          insuranceId={insuranceId}
          onInsuranceChange={setInsuranceId}
          onAddItem={handleAddItem}
        />
      }
      summary={
        <SummaryColumn
          conversationId={conversationId}
          items={items}
          insuranceId={insuranceId}
          onRemoveItem={handleRemoveItem}
        />
      }
      total={null}
    />
  );
}
