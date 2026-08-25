import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { formatMoney } from '@/lib/format';
import {
  CHART_GRID_COLOR,
  CHART_POSITIVE_COLOR,
  CHART_TICK,
  CHART_TOOLTIP_CONTENT_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
  toChartNumber,
} from './chartTokens';

interface RevenueChartProps {
  data?: Array<{ month: string; revenue: number }>;
}

export default function RevenueChart({ data = [] }: RevenueChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="bg-neutral-100 p-lg rounded-md shadow-sm">
        <h3 className="font-heading text-section mb-lg">Receita Acumulada</h3>
        <div className="h-80 flex items-center justify-center text-neutral-500">Nenhum dado disponível</div>
      </div>
    );
  }

  return (
    <div className="bg-neutral-100 p-lg rounded-md shadow-sm">
      <h3 className="font-heading text-section mb-lg">Receita Acumulada</h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} />
          <XAxis
            dataKey="month"
            tick={CHART_TICK}
          />
          <YAxis
            tick={CHART_TICK}
            // Eixo estreito: `thousands` é a variante de escala grande de lib/format.
            tickFormatter={(value) => formatMoney(toChartNumber(value), 'thousands')}
          />
          <Tooltip
            contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
            labelStyle={CHART_TOOLTIP_LABEL_STYLE}
            formatter={(value) => [formatMoney(toChartNumber(value)), 'Receita']}
          />
          <Legend />
          <Line
            type="monotone"
            dataKey="revenue"
            stroke={CHART_POSITIVE_COLOR}
            name="Receita"
            dot={{ fill: CHART_POSITIVE_COLOR, r: 4 }}
            activeDot={{ r: 6 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
