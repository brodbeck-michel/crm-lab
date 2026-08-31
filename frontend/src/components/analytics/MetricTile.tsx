import { MoneyDisplay } from '@/components/shared/MoneyDisplay';
import { formatCount } from '@/lib/format';

/**
 * `value` da variante `percent` já vem em PONTOS percentuais do contrato
 * (`conversionRate: 30` = 30%, API_CONTRACTS.md — não é fração 0–1). Por
 * isso o formatador é `decimal`, não o `style: 'percent'` do `Intl` — esse
 * estilo multiplica por 100, o que dobraria a escala aqui.
 */
const PERCENT = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

interface MetricTileProps {
  label: string;
  value?: number;
  variant?: 'money' | 'percent' | 'number';
}

export default function MetricTile({ label, value, variant = 'number' }: MetricTileProps) {
  const renderValue = () => {
    if (value === undefined || value === null) {
      return '-';
    }

    switch (variant) {
      case 'money':
        return <MoneyDisplay value={value} emphasis />;
      case 'percent':
        return <span className="font-heading text-section">{PERCENT.format(value)}%</span>;
      case 'number':
      default:
        return <span className="font-heading text-section">{formatCount(value)}</span>;
    }
  };

  return (
    <div className="bg-neutral-100 p-lg rounded-md shadow-sm border border-neutral-200">
      {/* Rótulo de indicador = mesmo degrau do cabeçalho de tabela (micro, 11px
          600 caixa alta) — o `tracking` já vem do token, não se soma aqui. */}
      <p className="text-micro text-neutral-600 font-semibold uppercase">{label}</p>
      <p className="mt-md">{renderValue()}</p>
    </div>
  );
}
