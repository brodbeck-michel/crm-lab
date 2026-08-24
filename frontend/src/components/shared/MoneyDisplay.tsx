import { formatMoney } from '@/lib/format';
import type { MoneyVariant } from '@/lib/format';
import { cn } from '@/components/ui/cn';

export interface MoneyDisplayProps {
  /** Número decimal vindo da API (179.80) — nunca string já formatada. */
  value: number;
  /** `full` R$ 1.350,00 · `compact` R$ 24.400 · `thousands` R$ 96,4 mil */
  variant?: MoneyVariant;
  /** `true` usa a fonte de título (indicadores e total do modal). */
  emphasis?: boolean;
}

/**
 * Único componente que exibe dinheiro. SEMPRE `white-space: nowrap` —
 * valor monetário quebrado em duas linhas é defeito (regra de largura 4).
 */
export function MoneyDisplay({ value, variant = 'full', emphasis = false }: MoneyDisplayProps) {
  return (
    <span
      data-variant={variant}
      className={cn(
        'whitespace-nowrap tabular-nums',
        emphasis ? 'font-heading text-section' : 'font-body',
      )}
    >
      {formatMoney(value, variant)}
    </span>
  );
}
