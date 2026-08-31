import type { ProposalItem } from '@crm-lab/shared';
import { MoneyDisplay } from '@/components/shared';
import { Chip } from '@/components/ui';

interface ItemsListProps {
  items: ProposalItem[];
  /** Convênio da proposta (D-082). `null` = particular. */
  insuranceId: string | null;
}

/**
 * Convênio selecionado mas ESTE item foi cobrado no preço particular (sem
 * tabela própria no convênio, D-004 "fallback nunca bloqueia") — exceção que
 * precisa ficar visível. Com `insuranceId` null todo item já é particular; o
 * badge seria redundante.
 */
export default function ItemsList({ items, insuranceId }: ItemsListProps) {
  return (
    <div className="space-y-sm">
      <h3 className="font-semibold text-label">Itens</h3>
      {items.map((item) => (
        <div key={item.id} className="flex justify-between items-center text-body">
          <span className="flex items-center gap-sm">
            {item.examName}
            {insuranceId && item.priceSource === 'private' && (
              <Chip tone="inactive" title="Sem tabela para este convênio — preço particular">
                Particular
              </Chip>
            )}
          </span>
          <MoneyDisplay value={item.unitPrice} />
        </div>
      ))}
    </div>
  );
}
