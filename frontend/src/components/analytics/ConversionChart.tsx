import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

interface ConversionChartProps {
  data?: Array<{ stage: string; count: number }>;
}

export default function ConversionChart({ data = [] }: ConversionChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="bg-white p-5 rounded-md shadow-sm">
        <h3 className="text-heading-16 font-semibold mb-4">Funil de Conversão</h3>
        <div className="h-80 flex items-center justify-center text-neutral-500">Nenhum dado disponível</div>
      </div>
    );
  }

  return (
    <div className="bg-white p-5 rounded-md shadow-sm">
      <h3 className="text-heading-16 font-semibold mb-4">Funil de Conversão</h3>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis
            dataKey="stage"
            tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }}
            angle={-45}
            textAnchor="end"
            height={100}
          />
          <YAxis tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }} />
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
            }}
            labelStyle={{ color: 'var(--color-text)' }}
            formatter={(value) => [(value ?? 0).toLocaleString('pt-BR'), 'Propostas']}
          />
          <Bar dataKey="count" fill="var(--color-accent)" name="Propostas" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
