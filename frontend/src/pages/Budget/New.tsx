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
}

export default function BudgetNew() {
  const [searchParams] = useSearchParams();
  const conversationId = searchParams.get('conversationId') || '';
  const [items, setItems] = useState<BudgetItem[]>([]);

  const handleAddItem = (examId: string, examName: string, price: number) => {
    const existingItem = items.find((item) => item.examId === examId);
    if (existingItem) {
      setItems(
        items.map((item) =>
          item.examId === examId ? { ...item, quantity: item.quantity + 1 } : item
        )
      );
    } else {
      setItems([...items, { examId, examName, unitPrice: price, quantity: 1 }]);
    }
  };

  const handleRemoveItem = (examId: string) => {
    setItems(items.filter((item) => item.examId !== examId));
  };

  return (
    <BudgetLayout
      catalog={<CatalogSegments onAddItem={handleAddItem} />}
      summary={
        <SummaryColumn
          conversationId={conversationId}
          items={items}
          onRemoveItem={handleRemoveItem}
        />
      }
      total={null}
    />
  );
}
