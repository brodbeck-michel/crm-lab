import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

interface RevenueChartProps {
  data?: Array<{ month: string; revenue: number }>;
}

export default function RevenueChart({ data = [] }: RevenueChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="bg-white p-5 rounded-md shadow-sm">
        <h3 className="text-heading-16 font-semibold mb-4">Receita Acumulada</h3>
        <div className="h-80 flex items-center justify-center text-neutral-500">Nenhum dado disponível</div>
      </div>
    );
  }

  return (
    <div className="bg-white p-5 rounded-md shadow-sm">
      <h3 className="text-heading-16 font-semibold mb-4">Receita Acumulada</h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis
            dataKey="month"
            tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }}
          />
          <YAxis
            tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }}
            tickFormatter={(value) => {
              if (value >= 1000) {
                return `R$ ${(value / 1000).toFixed(0)}k`;
              }
              return `R$ ${value}`;
            }}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
            }}
            labelStyle={{ color: 'var(--color-text)' }}
            formatter={(value) => [
              new Intl.NumberFormat('pt-BR', {
                style: 'currency',
                currency: 'BRL',
              }).format(value as number),
              'Receita',
            ]}
          />
          <Legend />
          <Line
            type="monotone"
            dataKey="revenue"
            stroke="var(--color-success)"
            name="Receita"
            dot={{ fill: 'var(--color-success)', r: 4 }}
            activeDot={{ r: 6 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
