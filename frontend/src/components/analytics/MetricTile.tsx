import { MoneyDisplay } from '@/components/shared/MoneyDisplay';
import { formatCount } from '@/lib/format';

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
        return <span className="font-heading text-section">{value.toFixed(1)}%</span>;
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
