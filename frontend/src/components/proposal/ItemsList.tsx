import type { ProposalItem } from '@crm-lab/shared';
import { MoneyDisplay } from '@/components/shared';

interface ItemsListProps {
  items: ProposalItem[];
}

export default function ItemsList({ items }: ItemsListProps) {
  return (
    <div className="space-y-2">
      <h3 className="font-semibold text-sm">Itens</h3>
      {items.map((item) => (
        <div key={item.id} className="flex justify-between text-sm">
          <span>{item.examName}</span>
          <MoneyDisplay value={item.unitPrice} />
        </div>
      ))}
    </div>
  );
}
