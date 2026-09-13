import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BudgetLayout } from '@/components/layout/BudgetLayout';
import CatalogSegments from '@/components/budget/CatalogSegments';
import SummaryColumn from '@/components/budget/SummaryColumn';
import type { ExamPackage } from '@crm-lab/shared';

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

  /**
   * Updater funcional (`setItems(current => ...)`): `handleAddPackage` chama
   * isto N vezes em sequência para expandir o pacote em N linhas, tudo dentro
   * do mesmo evento — com `items` fechado sobre o estado da última renderização
   * (como era antes), cada chamada veria o MESMO array desatualizado e só a
   * última exame sobreviveria (as demais `setItems` seriam sobrescritas pela
   * seguinte antes do React re-renderizar).
   */
  const handleAddItem = (
    examId: string,
    examName: string,
    price: number,
    priceSource: 'insurance' | 'private'
  ) => {
    setItems((current) => {
      const existingItem = current.find((item) => item.examId === examId);
      if (existingItem) {
        return current.map((item) =>
          item.examId === examId ? { ...item, quantity: item.quantity + 1 } : item
        );
      }
      return [...current, { examId, examName, unitPrice: price, quantity: 1, priceSource }];
    });
  };

  const handleRemoveItem = (examId: string) => {
    setItems((current) => current.filter((item) => item.examId !== examId));
  };

  /**
   * CRMLAB-10 — expande o pacote em N linhas, uma por exame incluído, com o
   * `pricePrivate` de cada `ExamPackageItem` (não o `effectivePrice` do
   * pacote — esse é só a prévia agregada no seletor). Mesmo caminho de merge
   * de `handleAddItem`: exame já presente no carrinho soma quantidade em vez
   * de duplicar linha. Ver DECISIONS.md D-130/SCHEMA.md §30 para o motivo.
   */
  const handleAddPackage = (pkg: ExamPackage) => {
    for (const item of pkg.items) {
      handleAddItem(item.examId, item.examName, item.pricePrivate, 'private');
    }
  };

  return (
    <BudgetLayout
      catalog={
        <CatalogSegments
          insuranceId={insuranceId}
          onInsuranceChange={setInsuranceId}
          onAddItem={handleAddItem}
          onAddPackage={handleAddPackage}
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
