import { useEffect, useState } from 'react';
import { useInsuranceList } from '@/api/insurances';
import { useExamPackagePrices, useUpdateExamPackagePrices } from '@/api/exam-packages';
import { Button, Input } from '@/components/ui';
import { EmptyState } from '@/components/shared';
import type { UpdateExamPackagePricesRequest } from '@crm-lab/shared';

export interface PackagePricesTabProps {
  packageId: string;
  /** Escrita só para manager/admin — mesma alçada de `PUT /exam-packages/:id/prices`. */
  canEdit: boolean;
}

/**
 * Grid convênio × preço do PACOTE — mesmo mecanismo de `ExamPricesTab` (§4/§8,
 * D-081/D-082), aplicado a `exam_package_prices` (SCHEMA.md §30). `PUT
 * /exam-packages/:id/prices` também é semântica de PUT: convênio ausente do
 * corpo tem o preço REMOVIDO, então o rascunho local começa com o preço atual
 * de CADA convênio ativo e o salvar envia só as linhas preenchidas.
 */
export default function PackagePricesTab({ packageId, canEdit }: PackagePricesTabProps) {
  const { data: insurancesData, isLoading: insurancesLoading } = useInsuranceList({
    active: true,
    limit: 100,
  });
  const { data: pricesData, isLoading: pricesLoading } = useExamPackagePrices(packageId);
  const updatePrices = useUpdateExamPackagePrices();

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!pricesData) return;
    const next: Record<string, string> = {};
    for (const row of pricesData.prices) {
      next[row.insuranceId] = row.price.toString();
    }
    setDraft(next);
  }, [pricesData]);

  const insurances = insurancesData?.insurances ?? [];
  const isLoading = insurancesLoading || pricesLoading;

  const setPrice = (insuranceId: string, value: string) => {
    setSaved(false);
    setDraft((current) => ({ ...current, [insuranceId]: value }));
  };

  const handleSave = () => {
    const prices: UpdateExamPackagePricesRequest['prices'] = [];
    for (const insurance of insurances) {
      const raw = draft[insurance.id];
      if (raw === undefined || raw.trim() === '') continue;
      const price = parseFloat(raw);
      if (Number.isNaN(price)) continue;
      prices.push({ insuranceId: insurance.id, price });
    }

    updatePrices.mutate(
      { id: packageId, data: { prices } },
      { onSuccess: () => setSaved(true) },
    );
  };

  if (isLoading) {
    return <div className="font-body text-body text-neutral-600">Carregando...</div>;
  }

  if (insurances.length === 0) {
    return (
      <EmptyState
        message="Nenhum convênio ativo cadastrado"
        hint="Cadastre um convênio em Configuração → Convênios para definir preços por convênio."
      />
    );
  }

  return (
    <div className="flex flex-col gap-md">
      <p className="m-0 font-body text-caption text-neutral-600">
        Em branco = sem preço específico para o convênio; o pacote usa o preço particular
        calculado (soma dos exames menos o desconto).
      </p>

      <div className="flex flex-col gap-sm">
        {insurances.map((insurance) => (
          <div key={insurance.id} className="flex items-center gap-md">
            <span className="min-w-0 flex-1 font-body text-label text-text">
              {insurance.name}
            </span>
            <div className="w-[160px] flex-[0_0_160px]">
              <Input
                aria-label={`Preço — ${insurance.name}`}
                type="number"
                step="0.01"
                min="0"
                disabled={!canEdit}
                value={draft[insurance.id] ?? ''}
                onChange={(event) => setPrice(insurance.id, event.target.value)}
              />
            </div>
          </div>
        ))}
      </div>

      {canEdit && (
        <div className="flex items-center gap-md">
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={updatePrices.isPending}
            loading={updatePrices.isPending}
          >
            Salvar preços
          </Button>
          {saved && (
            <span role="status" className="font-body text-caption text-accent2-700">
              Preços salvos.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
