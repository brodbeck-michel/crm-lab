import { Input, Chip } from '@/components/ui';

interface DiscountSectionProps {
  discountPercent: number;
  discountLimit: number;
  onChange: (value: number) => void;
  readOnly?: boolean;
}

export default function DiscountSection({
  discountPercent,
  discountLimit,
  onChange,
  readOnly = false,
}: DiscountSectionProps) {
  const exceedsLimit = discountPercent > discountLimit;

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium">Desconto (%)</label>
      <div className="flex gap-2 items-center">
        <Input
          type="number"
          min={0}
          max={100}
          value={discountPercent}
          onChange={(e) => !readOnly && onChange(Number(e.target.value))}
          placeholder="0"
          disabled={readOnly}
        />
        <span className="text-sm text-neutral-600 whitespace-nowrap">
          Alçada: {discountLimit}%
        </span>
      </div>

      {exceedsLimit && (
        <Chip tone="attention">
          Exigirá aprovação do gestor
        </Chip>
      )}
    </div>
  );
}
