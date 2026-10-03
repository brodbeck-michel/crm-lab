import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ResponseTimeDay } from '@crm-lab/shared';
import { formatMinutes } from '@/lib/format';
import {
  CHART_ACCENT_COLOR,
  CHART_GRID_COLOR,
  CHART_TICK,
  CHART_TOOLTIP_CONTENT_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
  toChartNumber,
} from './chartTokens';

interface ResponseTimeDailyChartProps {
  days: ResponseTimeDay[];
}

/**
 * Mediana do tempo de resposta por dia (CRMLAB-83, D-257). Dia sem resposta
 * fica sem barra (`null`), não com zero — zero diria "respondeu na hora".
 */
export default function ResponseTimeDailyChart({ days }: ResponseTimeDailyChartProps) {
  const data = days.map((d) => ({
    label: `${d.date.slice(8, 10)}/${d.date.slice(5, 7)}`,
    median: d.medianMinutes,
    answered: d.answered,
  }));

  return (
    <div className="bg-neutral-100 p-lg rounded-md shadow-sm">
      <h3 className="font-heading text-section mb-lg">Mediana por dia</h3>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} />
          <XAxis dataKey="label" tick={CHART_TICK} />
          <YAxis tick={CHART_TICK} />
          <Tooltip
            contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
            labelStyle={CHART_TOOLTIP_LABEL_STYLE}
            formatter={(value) => [formatMinutes(toChartNumber(value)), 'Mediana']}
          />
          <Bar dataKey="median" fill={CHART_ACCENT_COLOR} name="Mediana" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
