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

interface LossReasonsChartProps {
  data?: Array<{ reason: string; count: number }>;
}

export default function LossReasonsChart({ data = [] }: LossReasonsChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="bg-neutral-100 p-lg rounded-md shadow-sm">
        <h3 className="font-heading text-section mb-lg">Motivos de Perda</h3>
        <div className="h-64 flex items-center justify-center text-neutral-500">Nenhum dado disponível</div>
      </div>
    );
  }

  // Format reason labels
  const formattedData = data.map((item) => ({
    ...item,
    reasonLabel: formatReasonLabel(item.reason),
  }));

  return (
    <div className="bg-neutral-100 p-lg rounded-md shadow-sm">
      <h3 className="font-heading text-section mb-lg">Motivos de Perda</h3>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={formattedData} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} />
          <XAxis type="number" tick={CHART_TICK} />
          <YAxis
            dataKey="reasonLabel"
            type="category"
            width={150}
            tick={CHART_TICK}
          />
          <Tooltip
            contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
            labelStyle={CHART_TOOLTIP_LABEL_STYLE}
            formatter={(value) => [formatCount(toChartNumber(value)), 'Motivos']}
          />
          {/* Perda "exige atenção" → mesmo acento do Chip tone="attention". */}
          <Bar dataKey="count" fill={CHART_ACCENT_COLOR} name="Motivos" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function formatReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    preco_alto: 'Preço Alto',
    concorrencia: 'Concorrência',
    paciente_cancelou: 'Paciente Cancelou',
    sem_interesse: 'Sem Interesse',
    falta_resultado: 'Falta Resultado',
    mudou_de_ideia: 'Mudou de Ideia',
  };
  return labels[reason] || reason;
}
