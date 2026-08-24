import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

interface LossReasonsChartProps {
  data?: Array<{ reason: string; count: number }>;
}

export default function LossReasonsChart({ data = [] }: LossReasonsChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="bg-white p-5 rounded-md shadow-sm">
        <h3 className="text-heading-16 font-semibold mb-4">Motivos de Perda</h3>
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
    <div className="bg-white p-5 rounded-md shadow-sm">
      <h3 className="text-heading-16 font-semibold mb-4">Motivos de Perda</h3>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={formattedData} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis type="number" tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }} />
          <YAxis
            dataKey="reasonLabel"
            type="category"
            width={150}
            tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
            }}
            labelStyle={{ color: 'var(--color-text)' }}
            formatter={(value) => [(value ?? 0).toLocaleString('pt-BR'), 'Motivos']}
          />
          <Bar dataKey="count" fill="var(--color-warning)" name="Motivos" />
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
