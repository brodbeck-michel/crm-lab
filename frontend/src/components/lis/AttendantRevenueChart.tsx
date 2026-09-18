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

/** Título + linha de apoio, iguais nos dois estados (com e sem dado). */
function ChartHeading({ caption }: { caption: string }) {
  return (
    <header className="mb-lg">
      <h3 className="font-heading text-section">Faturamento por atendente</h3>
      <p className="mt-xs font-body text-caption text-neutral-600">{caption}</p>
    </header>
  );
}

/**
 * "Faturamento por atendente" — barras horizontais, ranking por valor
 * recebido (PAGES.md §14). Usa `byAttendantDetail` (D-122, TODOS os
 * atendentes) — não o `byAttendant` gated/top-6.
 */
export function AttendantRevenueChart({ data }: AttendantRevenueChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex h-full flex-col rounded-lg border border-neutral-200 bg-neutral-100 p-lg shadow-sm">
        <ChartHeading caption="Ranking por valor recebido" />
        <p className="font-body text-body text-neutral-600">Sem dado no período.</p>
      </div>
    );
  }

  // Barra de 34px + respiro: o gráfico cresce com o time, sem esmagar 12
  // atendentes em 160px nem deixar um vazio de 300px quando só há dois.
  const height = Math.max(200, data.length * 34 + 24);

  return (
    <div className="flex h-full flex-col rounded-lg border border-neutral-200 bg-neutral-100 p-lg shadow-sm">
      <ChartHeading caption="Ranking por valor recebido" />
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }} barSize={18}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} horizontal={false} />
          <XAxis
            type="number"
            tick={CHART_TICK}
            tickFormatter={(value) => formatMoney(toChartNumber(value), 'thousands')}
          />
          <YAxis type="category" dataKey="attendantName" tick={CHART_TICK} width={104} />
          <Tooltip
            contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
            labelStyle={CHART_TOOLTIP_LABEL_STYLE}
            formatter={(value) => [formatMoney(toChartNumber(value)), 'Recebido']}
          />
          <Bar dataKey="paidValue" fill={CHART_POSITIVE_COLOR} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
