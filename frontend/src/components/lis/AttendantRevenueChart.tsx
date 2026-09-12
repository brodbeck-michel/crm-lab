import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatMoney } from '@/lib/format';
import {
  CHART_GRID_COLOR,
  CHART_POSITIVE_COLOR,
  CHART_TICK,
  CHART_TOOLTIP_CONTENT_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
  toChartNumber,
} from '@/components/analytics/chartTokens';

export interface AttendantRevenuePoint {
  attendantName: string;
  paidValue: number;
}

export interface AttendantRevenueChartProps {
  data: AttendantRevenuePoint[];
}

/**
 * "Faturamento por atendente" — barras horizontais, ranking por valor
 * recebido (PAGES.md §14). Usa `byAttendantDetail` (D-122, TODOS os
 * atendentes) — não o `byAttendant` gated/top-6.
 */
export function AttendantRevenueChart({ data }: AttendantRevenueChartProps) {
  if (data.length === 0) {
    return (
      <div className="bg-neutral-100 p-lg rounded-md shadow-sm">
        <h3 className="font-heading text-section mb-lg">Faturamento por atendente</h3>
        <p className="font-body text-body text-neutral-600">Sem dado no período.</p>
      </div>
    );
  }

  const height = Math.max(160, data.length * 36);

  return (
    <div className="bg-neutral-100 p-lg rounded-md shadow-sm">
      <h3 className="font-heading text-section mb-lg">Faturamento por atendente</h3>
      <p className="font-body text-caption text-neutral-600 mb-md">Ranking por valor recebido</p>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} layout="vertical" margin={{ left: 24 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} horizontal={false} />
          <XAxis
            type="number"
            tick={CHART_TICK}
            tickFormatter={(value) => formatMoney(toChartNumber(value), 'thousands')}
          />
          <YAxis type="category" dataKey="attendantName" tick={CHART_TICK} width={90} />
          <Tooltip
            contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
            labelStyle={CHART_TOOLTIP_LABEL_STYLE}
            formatter={(value) => [formatMoney(toChartNumber(value)), 'Recebido']}
          />
          <Bar dataKey="paidValue" fill={CHART_POSITIVE_COLOR} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
