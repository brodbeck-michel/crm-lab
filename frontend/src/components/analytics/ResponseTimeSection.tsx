import { useMemo, useState } from 'react';
import {
  RESPONSE_TIME_MAX_PERIOD_DAYS,
  type ResponseTimeResponder,
  type ResponseTimeSummary,
} from '@crm-lab/shared';
import { useAnalyticsResponseTime } from '@/api/analytics';
import MetricTile from '@/components/analytics/MetricTile';
import ResponseTimeDailyChart from '@/components/analytics/ResponseTimeDailyChart';
import { Button, Select, useToast } from '@/components/ui';
import { DataTable, EmptyState } from '@/components/shared';
import type { DataTableColumn } from '@/components/shared';
import { formatCount, formatIsoDay, formatMinutes, formatPercent } from '@/lib/format';
import { generateResponseTimeExcel } from '@/lib/excel/response-time-report';

const ALL = 'all';
const MS_PER_DAY = 86_400_000;

interface ResponseTimeSectionProps {
  /** `YYYY-MM-DD` ou vazio (o servidor usa os últimos 30 dias). */
  startDate: string;
  endDate: string;
}

/** Linha da tabela: quem respondeu ou o total do laboratório. */
interface RankingRow {
  key: string;
  name: string;
  summary: ResponseTimeSummary;
  total: boolean;
}

/** Dias do período (inclusive) quando as duas datas estão preenchidas. */
function periodDays(startDate: string, endDate: string): number | null {
  if (startDate === '' || endDate === '') return null;
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round((end - start) / MS_PER_DAY) + 1;
}

const BUCKETS: Array<{ key: keyof ResponseTimeSummary['buckets']; label: string }> = [
  { key: 'upTo5', label: 'Até 5 min' },
  { key: 'upTo15', label: '5 a 15 min' },
  { key: 'upTo60', label: '15 a 60 min' },
  { key: 'over60', label: 'Mais de 1 h' },
];

/**
 * Aba "Tempo de resposta" de `/analytics` (CRMLAB-83, D-257, PAGES.md §8) —
 * gestor e admin. Minutos ÚTEIS (expediente, sem feriados), contados da
 * primeira mensagem de cada bloco do paciente até a resposta humana.
 *
 * O filtro de atendente é LOCAL: o relatório já traz cada linha completa
 * (indicadores, faixas e dia a dia), então trocar a atendente não refaz a
 * busca. Sem resposta não tem atendente — só aparece no recorte do laboratório.
 */
export default function ResponseTimeSection({ startDate, endDate }: ResponseTimeSectionProps) {
  const { toast } = useToast();
  const [responderId, setResponderId] = useState<string>(ALL);

  const days = periodDays(startDate, endDate);
  const tooLong = days !== null && days > RESPONSE_TIME_MAX_PERIOD_DAYS;
  const inverted = days !== null && days < 1;

  const { data: report, isLoading, isError } = useAnalyticsResponseTime(
    {
      startDate: startDate === '' ? undefined : startDate,
      endDate: endDate === '' ? undefined : endDate,
    },
    !tooLong && !inverted,
  );

  const selected: ResponseTimeResponder | null = useMemo(
    () => report?.responders.find((r) => r.responderId === responderId) ?? null,
    [report, responderId],
  );

  if (tooLong || inverted) {
    return (
      <p role="alert" className="font-body text-body text-accent-700">
        {inverted
          ? 'Data final anterior à inicial.'
          : `Escolha um período de até ${RESPONSE_TIME_MAX_PERIOD_DAYS} dias.`}
      </p>
    );
  }
  if (isLoading) return <div>Carregando dados...</div>;
  if (isError || !report) return <EmptyState message="Não foi possível carregar o tempo de resposta." />;

  const summary: ResponseTimeSummary = selected ?? report.total;
  const daily = selected ? selected.daily : report.total.daily;
  const { waiting, closed, conversations } = report.total.unanswered;

  const rows: RankingRow[] = [
    ...report.responders.map((r) => ({ key: r.responderId, name: r.name, summary: r, total: false })),
    { key: 'total', name: 'Total do laboratório', summary: report.total, total: true },
  ];
  const columns: Array<DataTableColumn<RankingRow>> = [
    {
      key: 'name',
      header: 'Atendente',
      render: (r) => (r.total ? <strong>{r.name}</strong> : r.name),
    },
    { key: 'answered', header: 'Respondidos', render: (r) => formatCount(r.summary.answered) },
    { key: 'median', header: 'Mediana', render: (r) => formatMinutes(r.summary.medianMinutes) },
    { key: 'average', header: 'Média', render: (r) => formatMinutes(r.summary.averageMinutes) },
    {
      key: 'first',
      header: '1ª resposta (mediana)',
      render: (r) => formatMinutes(r.summary.firstResponse.medianMinutes),
    },
    ...BUCKETS.map((b) => ({
      key: b.key,
      header: b.label,
      align: b.key === 'over60' ? ('right' as const) : undefined,
      render: (r: RankingRow) => formatCount(r.summary.buckets[b.key]),
    })),
  ];

  async function handleExport() {
    if (!report) return;
    try {
      await generateResponseTimeExcel(report, selected?.responderId ?? null);
    } catch {
      toast('Não foi possível gerar o Excel.', { tone: 'attention' });
    }
  }

  return (
    <section aria-label="Tempo de resposta" className="space-y-xl">
      <div className="flex flex-wrap items-end justify-between gap-lg">
        <div className="space-y-xs">
          <h2 className="font-heading text-section">Tempo de resposta no WhatsApp</h2>
          <p className="font-body text-caption text-neutral-600">
            {formatIsoDay(report.period.startDate)} a {formatIsoDay(report.period.endDate)} · minutos
            úteis (expediente, sem feriados), da primeira mensagem do paciente até a resposta de uma
            pessoa. Mensagem automática não conta.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-md">
          <div className="w-[240px]">
            <Select
              label="Atendente"
              value={responderId}
              onChange={(e) => setResponderId(e.target.value)}
              options={[
                { value: ALL, label: 'Todo o laboratório' },
                ...report.responders.map((r) => ({ value: r.responderId, label: r.name })),
              ]}
            />
          </div>
          <Button variant="secondary" size="sm" onClick={handleExport}>
            Exportar Excel
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-lg">
        <MetricTile label="Mediana" value={summary.medianMinutes ?? undefined} variant="minutes" />
        <MetricTile label="Média" value={summary.averageMinutes ?? undefined} variant="minutes" />
        <MetricTile
          label="1ª resposta (mediana)"
          value={summary.firstResponse.medianMinutes ?? undefined}
          variant="minutes"
          caption={`${formatCount(summary.firstResponse.answered)} ${summary.firstResponse.answered === 1 ? 'atendimento aberto' : 'atendimentos abertos'}`}
        />
        <MetricTile label="Respondidos" value={summary.answered} variant="number" caption="blocos de mensagens" />
        <MetricTile
          label="Sem resposta"
          value={selected ? undefined : waiting + closed}
          variant="number"
          caption={
            selected
              ? 'Só no total: sem resposta não tem atendente'
              : `${formatCount(waiting)} aguardando · ${formatCount(closed)} encerrados · ${formatCount(conversations)} conversas`
          }
        />
      </div>

      <div className="grid grid-cols-2 gap-lg">
        <div className="bg-neutral-100 p-lg rounded-md shadow-sm space-y-md">
          <h3 className="font-heading text-section">Distribuição</h3>
          <ul className="space-y-sm">
            {BUCKETS.map((b) => {
              const count = summary.buckets[b.key];
              const share = summary.answered > 0 ? count / summary.answered : 0;
              return (
                <li key={b.key} className="space-y-xs">
                  <div className="flex justify-between font-body text-body">
                    <span>{b.label}</span>
                    <span>
                      {formatCount(count)} · {formatPercent(share)}
                    </span>
                  </div>
                  <div className="h-2 rounded-pill bg-neutral-200">
                    <div className="h-2 rounded-pill bg-accent" style={{ width: `${share * 100}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        <ResponseTimeDailyChart days={daily} />
      </div>

      <div className="space-y-md">
        <h3 className="font-heading text-section">Ranking por atendente</h3>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.key}
          minWidth={960}
          emptyMessage="Nenhuma resposta no período"
        />
      </div>
    </section>
  );
}
