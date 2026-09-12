import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ExecutiveReportMonthlyPoint } from '@crm-lab/shared';
import { formatMoney } from '@/lib/format';
import {
  CHART_ACCENT_COLOR,
  CHART_GRID_COLOR,
  CHART_POSITIVE_COLOR,
  CHART_TICK,
  CHART_TOOLTIP_CONTENT_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
  toChartNumber,
} from '@/components/analytics/chartTokens';

export interface MonthlySeriesChartProps {
  data: ExecutiveReportMonthlyPoint[];
}

/**
 * Série mensal do Relatório Executivo (`GET /reports/executive`, §5c) —
 * sempre 12 pontos, mês sem dado com `0` (nunca ausente). Emitido (barra) vs.
 * pago (linha) — as duas janelas de tempo do domínio LIS lado a lado
 * (PAGES.md §14).
 */
export function MonthlySeriesChart({ data }: MonthlySeriesChartProps) {
  return (
    <div className="bg-neutral-100 p-lg rounded-md shadow-sm">
      <h3 className="font-heading text-section mb-lg">Emitido × Pago (12 meses)</h3>
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} />
          <XAxis dataKey="month" tick={CHART_TICK} />
          <YAxis
            tick={CHART_TICK}
            tickFormatter={(value) => formatMoney(toChartNumber(value), 'thousands')}
          />
          <Tooltip
            contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
            labelStyle={CHART_TOOLTIP_LABEL_STYLE}
            formatter={(value, name) => [formatMoney(toChartNumber(value)), name]}
          />
          <Legend />
          <Bar dataKey="issuedValue" name="Emitido" fill={CHART_ACCENT_COLOR} />
          <Line
            type="monotone"
            dataKey="paidValue"
            name="Pago"
            stroke={CHART_POSITIVE_COLOR}
            dot={{ fill: CHART_POSITIVE_COLOR, r: 3 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
