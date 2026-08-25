import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { formatCount } from '@/lib/format';
import {
  CHART_ACCENT_COLOR,
  CHART_GRID_COLOR,
  CHART_TICK,
  CHART_TOOLTIP_CONTENT_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
  toChartNumber,
} from './chartTokens';

interface ConversionChartProps {
  data?: Array<{ stage: string; count: number }>;
}

export default function ConversionChart({ data = [] }: ConversionChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="bg-neutral-100 p-lg rounded-md shadow-sm">
        <h3 className="font-heading text-section mb-lg">Funil de Conversão</h3>
        <div className="h-80 flex items-center justify-center text-neutral-500">Nenhum dado disponível</div>
      </div>
    );
  }

  return (
    <div className="bg-neutral-100 p-lg rounded-md shadow-sm">
      <h3 className="font-heading text-section mb-lg">Funil de Conversão</h3>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} />
          <XAxis
            dataKey="stage"
            tick={CHART_TICK}
            angle={-45}
            textAnchor="end"
            height={100}
          />
          <YAxis tick={CHART_TICK} />
          <Tooltip
            contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
            labelStyle={CHART_TOOLTIP_LABEL_STYLE}
            formatter={(value) => [formatCount(toChartNumber(value)), 'Propostas']}
          />
          <Bar dataKey="count" fill={CHART_ACCENT_COLOR} name="Propostas" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
