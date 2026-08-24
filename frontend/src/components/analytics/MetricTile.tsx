import { MoneyDisplay } from '@/components/shared/MoneyDisplay';

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
        return <span className="font-heading text-section">{Math.floor(value).toLocaleString('pt-BR')}</span>;
    }
  };

  return (
    <div className="bg-white p-5 rounded-md shadow-sm border border-neutral-200">
      <p className="text-xs text-neutral-600 font-medium uppercase tracking-wide">{label}</p>
      <p className="mt-3">{renderValue()}</p>
    </div>
  );
}
