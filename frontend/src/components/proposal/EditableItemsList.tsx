import { useState } from 'react';
import { useExamListInfinite } from '@/api/exams';
import { Button, Input, SearchInput } from '@/components/ui';
import { MoneyDisplay } from '@/components/shared';

export interface EditableProposalItem {
  examId: string;
  examName: string;
  quantity: number;
  unitPrice: number;
  priceSource: 'insurance' | 'private';
}

interface EditableItemsListProps {
  items: EditableProposalItem[];
  /** Convênio já gravado na proposta (D-082) — só prévia de preço, imutável aqui. */
  insuranceId: string | null;
  onChange: (items: EditableProposalItem[]) => void;
}

/**
 * Edição de itens em `ProposalModal` (CRMLAB-12, D-132). Diferente de
 * `CatalogSegments` (seletor de `/budget/new`, com pacotes/abas de
 * catálogo): aqui é só um buscador simples de exame para adicionar à lista
 * já existente — o preço é sempre RECALCULADO pelo backend em
 * `PATCH /proposals/:id/items` (D-003), o que aparece aqui é só prévia.
 */
export default function EditableItemsList({ items, insuranceId, onChange }: EditableItemsListProps) {
  const [search, setSearch] = useState('');
  const { data } = useExamListInfinite({
    active: true,
    search: search || undefined,
    limit: 20,
    insuranceId: insuranceId ?? undefined,
  });
  const exams = data?.pages.flatMap((page) => page.exams) ?? [];

  const handleQuantityChange = (examId: string, quantity: number) => {
    if (!Number.isInteger(quantity) || quantity <= 0) return;
    onChange(items.map((item) => (item.examId === examId ? { ...item, quantity } : item)));
  };

  const handleRemove = (examId: string) => {
    onChange(items.filter((item) => item.examId !== examId));
  };

  const handleAdd = (examId: string, examName: string) => {
    if (items.some((item) => item.examId === examId)) return;
    const exam = exams.find((e) => e.id === examId);
    if (!exam) return;
    const price = insuranceId ? (exam.effectivePrice ?? exam.pricePrivate) : exam.pricePrivate;
    const priceSource = insuranceId ? (exam.priceSource ?? 'private') : 'private';
    onChange([...items, { examId, examName, quantity: 1, unitPrice: price, priceSource }]);
    setSearch('');
  };

  return (
    <div className="space-y-sm">
      <h3 className="font-semibold text-label">Itens</h3>

      {items.length === 0 && (
        <p className="text-caption text-neutral-600">Nenhum item — adicione ao menos um abaixo.</p>
      )}

      {items.map((item) => (
        <div key={item.examId} className="flex items-center gap-sm text-body">
          <span className="flex-1 min-w-0 truncate">{item.examName}</span>
          <Input
            type="number"
            min={1}
            max={1000}
            value={item.quantity}
            onChange={(e) => handleQuantityChange(item.examId, Number(e.target.value))}
            aria-label={`Quantidade de ${item.examName}`}
          />
          <MoneyDisplay value={item.unitPrice * item.quantity} />
          <Button variant="destructive" size="sm" onClick={() => handleRemove(item.examId)}>
            Remover
          </Button>
        </div>
      ))}

      <SearchInput placeholder="Adicionar exame..." onSearch={setSearch} />
      {search && (
        <div className="space-y-xs max-h-48 overflow-y-auto">
          {exams.length === 0 ? (
            <p className="text-caption text-neutral-600 py-sm">Nenhum exame encontrado</p>
          ) : (
            exams.map((exam) => (
              <button
                key={exam.id}
                type="button"
                onClick={() => handleAdd(exam.id, exam.name)}
                className="w-full flex justify-between items-center p-sm hover:bg-neutral-100 rounded-md transition-colors text-left"
              >
                <span className="truncate">{exam.name}</span>
                <MoneyDisplay value={exam.effectivePrice ?? exam.pricePrivate} />
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
