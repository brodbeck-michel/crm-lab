import MetricTile from '@/components/analytics/MetricTile';

export type KpiCardVariant = 'money' | 'percent' | 'number';
export type KpiCardDeltaTone = 'positive' | 'negative';

/** Mesmo formatador de `MetricTile` — pontos percentuais, não fração 0–1. */
const PERCENT = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  signDisplay: 'always',
});

export interface KpiCardProps {
  label: string;
  value?: number;
  variant?: KpiCardVariant;
  /**
   * Variação vs. período anterior, em PONTOS percentuais (`+12.4` = alta de
   * 12,4%). Omitido quando não há "período anterior" para comparar (ex.:
   * cartões de faixa de idade da Busca Ativa, PAGES.md §16).
   */
  deltaPct?: number;
  /**
   * Cor da seta de variação. A TELA decide o sentido — cair pode ser bom
   * (ex.: "orçamentos em aberto") — nunca inferida automaticamente do sinal.
   */
  deltaTone?: KpiCardDeltaTone;
}

/**
 * `KpiCard` — cartão de indicador do domínio LIS (`docs/frontend/COMPONENTS.md`).
 * Reaproveita `MetricTile` para o valor principal e acrescenta a segunda
 * linha opcional de variação — não duplica a formatação pt-BR de valor.
 */
export function KpiCard({ label, value, variant = 'number', deltaPct, deltaTone }: KpiCardProps) {
  return (
    <div>
      <MetricTile label={label} value={value} variant={variant} />
      {deltaPct !== undefined && (
        <p
          className={
            deltaTone === 'negative'
              ? 'mt-xs text-caption text-accent-700'
              : 'mt-xs text-caption text-accent2-700'
          }
        >
          {PERCENT.format(deltaPct)}% vs. período anterior
        </p>
      )}
    </div>
  );
}
