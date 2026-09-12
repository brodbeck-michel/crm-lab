import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { formatMoney } from '@/lib/format';
import { CHART_TOOLTIP_CONTENT_STYLE, CHART_TOOLTIP_LABEL_STYLE, toChartNumber } from '@/components/analytics/chartTokens';

export interface InsuranceSlice {
  name: string;
  value: number;
}

/** Paleta categórica — tons de `accent2` (mesma identidade visual do tema), nunca hex. */
const SLICE_COLORS = [
  'var(--color-accent-2-800)',
  'var(--color-accent-2-500)',
  'var(--color-accent-2-300)',
  'var(--color-accent-600)',
  'var(--color-accent-400)',
  'var(--color-accent-200)',
  'var(--color-neutral-400)',
];

export interface InsuranceDonutChartProps {
  slices: InsuranceSlice[];
}

/**
 * Distribuição por convênio — donut + legenda (PAGES.md §14). `slices` já vem
 * pronto do chamador (top 6 + "Outros" quando aplicável) — o componente só
 * desenha e calcula o percentual de cada fatia sobre a SOMA do que recebeu.
 */
export function InsuranceDonutChart({ slices }: InsuranceDonutChartProps) {
  const total = slices.reduce((sum, s) => sum + s.value, 0);

  if (slices.length === 0 || total <= 0) {
    return (
      <div className="bg-neutral-100 p-lg rounded-md shadow-sm">
        <h3 className="font-heading text-section mb-lg">Distribuição por convênio</h3>
        <p className="font-body text-body text-neutral-600">Sem dado no período.</p>
      </div>
    );
  }

  return (
    <div className="bg-neutral-100 p-lg rounded-md shadow-sm">
      <h3 className="font-heading text-section mb-lg">Distribuição por convênio</h3>
      <div className="flex flex-col md:flex-row items-center gap-lg">
        <ResponsiveContainer width="100%" height={220} className="max-w-[220px]">
          <PieChart>
            <Pie data={slices} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90}>
              {slices.map((slice, index) => (
                <Cell key={slice.name} fill={SLICE_COLORS[index % SLICE_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
              labelStyle={CHART_TOOLTIP_LABEL_STYLE}
              formatter={(value) => formatMoney(toChartNumber(value))}
            />
          </PieChart>
        </ResponsiveContainer>
        <ul className="flex-1 w-full space-y-sm">
          {slices.map((slice, index) => (
            <li key={slice.name} className="flex items-center justify-between gap-md">
              <span className="flex items-center gap-sm min-w-0">
                <span
                  className="h-[10px] w-[10px] rounded-full flex-none"
                  style={{ backgroundColor: SLICE_COLORS[index % SLICE_COLORS.length] }}
                />
                <span className="font-body text-caption text-neutral-800 truncate">{slice.name}</span>
              </span>
              <span className="font-body text-caption font-semibold whitespace-nowrap">
                {formatMoney(slice.value)} · {((slice.value / total) * 100).toFixed(1)}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
