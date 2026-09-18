import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ExecutiveReportMonthlyPoint } from '@crm-lab/shared';
import { formatMoney } from '@/lib/format';
import {
  CHART_ACCENT_COLOR,
  CHART_GRID_COLOR,
  CHART_POSITIVE_COLOR,
  CHART_POSITIVE_DEEP_COLOR,
  CHART_TICK,
  CHART_TOOLTIP_CONTENT_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
  toChartNumber,
} from '@/components/analytics/chartTokens';

const MONTH_NAMES = [
  'jan',
  'fev',
  'mar',
  'abr',
  'mai',
  'jun',
  'jul',
  'ago',
  'set',
  'out',
  'nov',
  'dez',
];

/** `2026-08` → `ago/26`. Rótulo de eixo precisa caber em 12 pontos na horizontal. */
export function formatMonthLabel(month: string): string {
  const [year, monthNumber] = month.split('-');
  const name = MONTH_NAMES[Number(monthNumber) - 1];
  if (!name || !year) return month;
  return `${name}/${year.slice(2)}`;
}

export interface MonthlySeriesChartProps {
  data: ExecutiveReportMonthlyPoint[];
  /** Nota de rodapé — ex.: o aviso de que a série ignora o filtro de convênio. */
  note?: string;
}

const SERIES = [
  { key: 'issuedValue', name: 'Total orçado', color: CHART_POSITIVE_DEEP_COLOR },
  { key: 'requisitionValue', name: 'Em requisição', color: CHART_POSITIVE_COLOR },
  { key: 'paidValue', name: 'Recebido', color: CHART_ACCENT_COLOR },
] as const;

/**
 * "Evolução do faturamento" (`GET /reports/executive`, §5c) — 12 meses, sempre
 * com todos os pontos (mês sem movimento em `0`, nunca ausente).
 *
 * As três séries do funil na MESMA escala, uma sobre a outra: orçado (o que foi
 * proposto), em requisição (o que virou pedido) e recebido (o que entrou). A
 * distância vertical entre as curvas É a leitura — perda entre uma etapa e a
 * seguinte. Área sobreposta, nunca empilhada: empilhar somaria três números que
 * já se contêm, e a soma não significa nada.
 */
export function MonthlySeriesChart({ data, note }: MonthlySeriesChartProps) {
  return (
    <div className="flex h-full flex-col rounded-lg border border-neutral-200 bg-neutral-100 p-lg shadow-sm">
      <header className="mb-lg">
        <h3 className="font-heading text-section">Evolução do faturamento</h3>
        <p className="mt-xs font-body text-caption text-neutral-600">
          Total orçado, em requisição e recebido, mês a mês (12 meses)
        </p>
      </header>

      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={data} margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
          <defs>
            {SERIES.map((series) => (
              <linearGradient key={series.key} id={`fill-${series.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={series.color} stopOpacity={0.28} />
                <stop offset="100%" stopColor={series.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} vertical={false} />
          <XAxis dataKey="month" tick={CHART_TICK} tickFormatter={formatMonthLabel} />
          <YAxis
            tick={CHART_TICK}
            width={88}
            tickFormatter={(value) => formatMoney(toChartNumber(value), 'thousands')}
          />
          <Tooltip
            contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
            labelStyle={CHART_TOOLTIP_LABEL_STYLE}
            labelFormatter={(month) => formatMonthLabel(String(month))}
            formatter={(value, name) => [formatMoney(toChartNumber(value)), name]}
          />
          <Legend iconType="plainline" />
          {SERIES.map((series) => (
            <Area
              key={series.key}
              type="monotone"
              dataKey={series.key}
              name={series.name}
              stroke={series.color}
              strokeWidth={2}
              fill={`url(#fill-${series.key})`}
              dot={false}
              activeDot={{ r: 4 }}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>

      {note && <p className="mt-md font-body text-caption text-neutral-600">{note}</p>}
    </div>
  );
}
