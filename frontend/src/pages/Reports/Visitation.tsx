import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  DOCTOR_ABC_CLASSES,
  VISITATION_REPORT_STALE_DEFAULT_DAYS,
  VISITATION_REPORT_STALE_MAX_DAYS,
  VISITATION_REPORT_STALE_MIN_DAYS,
  type DoctorAbcClass,
  type VisitationReportCoverage,
  type VisitationReportEvolutionPoint,
  type VisitationReportGranularity,
  type VisitationReportPurposeRow,
  type VisitationReportQuery,
  type VisitationReportRepresentativeRow,
  type VisitationReportStaleDoctor,
} from '@crm-lab/shared';
import { useVisitationReport, useVisitationStaleDoctors } from '@/api/visitation-reports';
import { useVisitPurposes } from '@/api/visit-purposes';
import { PageContainer, PageHeader } from '@/components/layout';
import { Button, Input, SegmentedControl, Select } from '@/components/ui';
import { DataTable, DateDisplay, EmptyState } from '@/components/shared';
import type { DataTableColumn } from '@/components/shared';
import { ResultsKpiCard } from '@/components/lis/ResultsKpiCard';
import { isPeriodInvalid, PeriodFilter, type Period } from '@/components/lis/PeriodFilter';
import {
  CHART_ACCENT_COLOR,
  CHART_GRID_COLOR,
  CHART_POSITIVE_DEEP_COLOR,
  CHART_TICK,
  CHART_TOOLTIP_CONTENT_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
} from '@/components/analytics/chartTokens';
import { downloadCsv, type CsvCell } from '@/lib/csv';
import { formatIsoDay, formatMinutes } from '@/lib/format';
import { useVisitationResponsibles } from '@/pages/Visitation/visitation-access';

/** Mês corrente inteiro, em dias locais (D-333 item 3). */
export function currentMonthPeriod(now: Date = new Date()): Period {
  const year = now.getFullYear();
  const month = now.getMonth();
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDay = new Date(year, month + 1, 0).getDate();
  return { startDate: `${year}-${pad(month + 1)}-01`, endDate: `${year}-${pad(month + 1)}-${pad(lastDay)}` };
}

/** `57.1` → `57,1%`; `null` → `—`. */
function rateLabel(rate: number | null): string {
  return rate === null ? '—' : `${rate.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

function coverageCell(coverage: VisitationReportCoverage): string {
  return `${coverage.visitedDoctors}/${coverage.portfolioDoctors}`;
}

function bucketLabel(bucket: string, granularity: VisitationReportGranularity): string {
  const [year, month, day] = bucket.split('-');
  return granularity === 'month' ? `${month}/${year?.slice(2)}` : `${day}/${month}`;
}

const PERIOD_INVALID_HINT = 'Ajuste o período para ver os números.';

/**
 * Relatório de Visitação — `/reports/visitation` (PAGES.md §22d · API_CONTRACTS
 * §14b · CRMLAB-193, D-333). Fórmulas em BUSINESS_RULES §15b; aqui só se exibe
 * o que o servidor calculou. O representante vê os próprios números — o
 * seletor de representante nem aparece para ele (o servidor recorta de novo).
 */
export default function VisitationReportPage() {
  const { seesAll, responsibles } = useVisitationResponsibles();
  const { data: purposesData } = useVisitPurposes();

  const [period, setPeriod] = useState<Period>(() => currentMonthPeriod());
  const [responsibleId, setResponsibleId] = useState('');
  const [purposeId, setPurposeId] = useState('');
  const [abcClass, setAbcClass] = useState<DoctorAbcClass | ''>('');
  const [granularity, setGranularity] = useState<VisitationReportGranularity | undefined>(undefined);
  const [staleDaysText, setStaleDaysText] = useState(String(VISITATION_REPORT_STALE_DEFAULT_DAYS));

  const periodInvalid = isPeriodInvalid(period);
  const query: VisitationReportQuery = {
    from: period.startDate,
    to: period.endDate,
    ...(seesAll && responsibleId ? { responsibleId } : {}),
    ...(purposeId ? { purposeId } : {}),
    ...(abcClass ? { abcClass } : {}),
    ...(granularity ? { granularity } : {}),
  };
  const reportQuery = useVisitationReport(query, { enabled: !periodInvalid });
  const report = reportQuery.data;

  const staleDays = Number(staleDaysText);
  const staleDaysValid =
    Number.isInteger(staleDays) &&
    staleDays >= VISITATION_REPORT_STALE_MIN_DAYS &&
    staleDays <= VISITATION_REPORT_STALE_MAX_DAYS;
  const staleQuery = useVisitationStaleDoctors(
    {
      days: staleDaysValid ? staleDays : VISITATION_REPORT_STALE_DEFAULT_DAYS,
      ...(seesAll && responsibleId ? { responsibleId } : {}),
      ...(abcClass ? { abcClass } : {}),
    },
    { enabled: staleDaysValid },
  );
  const stale = staleQuery.data;

  function exportRepresentatives() {
    if (!report) return;
    const header: CsvCell[] = [
      'Representante',
      'Carteira (ativos)',
      'Visitados',
      'Cobertura %',
      'A visitados/carteira',
      'B visitados/carteira',
      'C visitados/carteira',
      'Sem classe visitados/carteira',
      'Realizadas',
      'Reagendamentos',
      'Canceladas',
      'Não recebidas',
    ];
    const rows = report.byRepresentative.map((row): CsvCell[] => [
      row.responsible.name,
      row.portfolioDoctors,
      row.visitedDoctors,
      row.coverage.rate,
      coverageCell(row.coverageByClass.A),
      coverageCell(row.coverageByClass.B),
      coverageCell(row.coverageByClass.C),
      coverageCell(row.coverageByClass.unclassified),
      row.completed,
      row.reschedules,
      row.cancelled,
      row.notReceived,
    ]);
    downloadCsv(`visitacao-por-representante_${period.startDate}_${period.endDate}.csv`, [header, ...rows]);
  }

  function exportStale() {
    if (!stale) return;
    const header: CsvCell[] = ['Médico', 'CRM', 'Especialidade', 'Classe', 'Responsável', 'Última visita', 'Dias sem visita'];
    const rows = stale.doctors.map((doctor): CsvCell[] => [
      doctor.name,
      doctor.crm ? `${doctor.crm}${doctor.crmUf ? `/${doctor.crmUf}` : ''}` : null,
      doctor.specialty,
      doctor.abcClass ?? 'Sem classe',
      doctor.responsible?.name ?? 'Sem responsável',
      doctor.lastVisitAt ? formatIsoDay(doctor.lastVisitAt) : 'Nunca visitado',
      doctor.daysSinceLastVisit,
    ]);
    downloadCsv(`medicos-sem-visita-${stale.days}-dias_${stale.referenceDate}.csv`, [header, ...rows]);
  }

  const representativeColumns: Array<DataTableColumn<VisitationReportRepresentativeRow>> = [
    { key: 'name', header: 'Representante', render: (r) => r.responsible.name },
    { key: 'portfolio', header: 'Carteira', render: (r) => r.portfolioDoctors },
    { key: 'visited', header: 'Visitados', render: (r) => r.visitedDoctors },
    { key: 'coverage', header: 'Cobertura', render: (r) => rateLabel(r.coverage.rate) },
    { key: 'a', header: 'A', render: (r) => coverageCell(r.coverageByClass.A) },
    { key: 'b', header: 'B', render: (r) => coverageCell(r.coverageByClass.B) },
    { key: 'c', header: 'C', render: (r) => coverageCell(r.coverageByClass.C) },
    { key: 'completed', header: 'Realizadas', render: (r) => r.completed },
    { key: 'reschedules', header: 'Reagend.', render: (r) => r.reschedules },
    { key: 'cancelled', header: 'Cancel.', align: 'right', render: (r) => r.cancelled },
  ];

  const staleColumns: Array<DataTableColumn<VisitationReportStaleDoctor>> = [
    {
      key: 'name',
      header: 'Médico',
      render: (d) => (
        <Link to={`/visitation/doctors/${d.id}`} className="font-semibold text-text hover:underline">
          {d.name}
        </Link>
      ),
    },
    { key: 'abc', header: 'Classe', render: (d) => d.abcClass ?? 'Sem classe' },
    { key: 'responsible', header: 'Responsável', render: (d) => d.responsible?.name ?? 'Sem responsável' },
    {
      key: 'last',
      header: 'Última visita',
      render: (d) => (d.lastVisitAt ? <DateDisplay value={d.lastVisitAt} variant="absolute" /> : 'Nunca visitado'),
    },
    {
      key: 'days',
      header: 'Dias sem visita',
      align: 'right',
      render: (d) => (d.daysSinceLastVisit === null ? '—' : d.daysSinceLastVisit),
    },
  ];

  const summary = report?.summary;
  const effectiveGranularity = report?.granularity ?? granularity ?? 'week';

  return (
    <PageContainer>
      <PageHeader
        title="Relatório de Visitação"
        description="Visitas, cobertura da carteira e médicos esquecidos no período."
      />

      <div className="flex flex-wrap items-center gap-lg rounded-lg border border-neutral-200 bg-neutral-100 px-lg py-md shadow-sm">
        <PeriodFilter value={period} onChange={setPeriod} />
        {seesAll ? (
          <div className="w-[208px]">
            <Select
              aria-label="Representante"
              value={responsibleId}
              onChange={(e) => setResponsibleId(e.target.value)}
              options={[
                { value: '', label: 'Todos os representantes' },
                ...responsibles.map((person) => ({ value: person.id, label: person.name })),
              ]}
            />
          </div>
        ) : (
          <p className="font-body text-caption text-neutral-600">
            Seus números: sua carteira e as visitas em que você é o responsável.
          </p>
        )}
        <div className="w-[208px]">
          <Select
            aria-label="Finalidade"
            value={purposeId}
            onChange={(e) => setPurposeId(e.target.value)}
            options={[
              { value: '', label: 'Todas as finalidades' },
              ...(purposesData?.purposes ?? []).map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        </div>
        <div className="w-[160px]">
          <Select
            aria-label="Curva ABC"
            value={abcClass}
            onChange={(e) => {
              const value = e.target.value;
              setAbcClass(DOCTOR_ABC_CLASSES.find((c) => c === value) ?? '');
            }}
            options={[
              { value: '', label: 'Curva ABC: todas' },
              ...DOCTOR_ABC_CLASSES.map((c) => ({ value: c, label: `Classe ${c}` })),
            ]}
          />
        </div>
      </div>

      {periodInvalid ? (
        <EmptyState message="Período inválido" hint={PERIOD_INVALID_HINT} />
      ) : reportQuery.isError ? (
        <EmptyState message="Não foi possível carregar o relatório" hint="Verifique a conexão e tente novamente." />
      ) : !summary || !report ? (
        <p className="font-body text-body text-neutral-600">Carregando relatório...</p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-lg sm:grid-cols-2 xl:grid-cols-4">
            <ResultsKpiCard icon="trend" label="Agendadas" value={summary.scheduled} caption={`${summary.total} visitas no período`} />
            <ResultsKpiCard icon="people" highlight label="Realizadas" value={summary.completed} caption={`${summary.reschedules} reagendamentos no período`} />
            <ResultsKpiCard icon="money" label="Canceladas" value={summary.cancelled} />
            <ResultsKpiCard icon="wallet" label="Não recebidas" value={summary.notReceived} />
          </div>
          <div className="grid grid-cols-1 gap-lg sm:grid-cols-3">
            <ResultsKpiCard
              icon="trend"
              label="Taxa de realização"
              value={rateLabel(summary.completionRate)}
              caption="Realizadas ÷ encerradas (realizadas, canceladas e não recebidas)"
              progress={summary.completionRate ?? undefined}
            />
            <ResultsKpiCard
              icon="trend"
              label="Duração média"
              value={formatMinutes(summary.averageDurationMinutes)}
              caption={`${summary.durationSampleSize} visitas com check-in e check-out`}
            />
            <ResultsKpiCard
              icon="people"
              label="Cobertura"
              value={rateLabel(summary.coverage.rate)}
              caption={`${summary.coverage.visitedDoctors} de ${summary.coverage.portfolioDoctors} médicos ativos visitados`}
              progress={summary.coverage.rate ?? undefined}
            />
          </div>

          <section className="space-y-md rounded-lg border border-neutral-200 bg-neutral-100 p-lg shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-md">
              <div>
                <h3 className="font-heading text-section">Por representante</h3>
                <p className="mt-xs font-body text-caption text-neutral-600">
                  Carteira e cobertura pela carteira; realizadas, reagendamentos e cancelamentos pelo responsável da visita.
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={exportRepresentatives} disabled={report.byRepresentative.length === 0}>
                Exportar CSV
              </Button>
            </div>
            <DataTable
              columns={representativeColumns}
              rows={report.byRepresentative}
              rowKey={(r) => r.responsible.id}
              emptyMessage="Nenhum representante no período"
            />
          </section>

          <div className="grid grid-cols-1 gap-lg lg:grid-cols-12">
            <div className="lg:col-span-5">
              <PurposeChart rows={report.byPurpose} />
            </div>
            <div className="lg:col-span-7">
              <EvolutionChart
                points={report.evolution}
                granularity={effectiveGranularity}
                onGranularityChange={setGranularity}
              />
            </div>
          </div>
        </>
      )}

      <section className="space-y-md rounded-lg border border-neutral-200 bg-neutral-100 p-lg shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-md">
          <div>
            <h3 className="font-heading text-section">Médicos sem visita realizada</h3>
            <p className="mt-xs font-body text-caption text-neutral-600">
              Ativos sem visita há mais de X dias ou nunca visitados — classe A primeiro. Não depende do período nem da finalidade.
            </p>
          </div>
          <div className="flex items-end gap-md">
            <div className="w-[140px]">
              <Input
                type="number"
                label="Há mais de (dias)"
                min={VISITATION_REPORT_STALE_MIN_DAYS}
                max={VISITATION_REPORT_STALE_MAX_DAYS}
                value={staleDaysText}
                onChange={(e) => setStaleDaysText(e.target.value)}
                error={staleDaysValid ? undefined : `De ${VISITATION_REPORT_STALE_MIN_DAYS} a ${VISITATION_REPORT_STALE_MAX_DAYS}`}
              />
            </div>
            <Button variant="secondary" size="sm" onClick={exportStale} disabled={!stale || stale.doctors.length === 0}>
              Exportar CSV
            </Button>
          </div>
        </div>
        {staleQuery.isError ? (
          <EmptyState message="Não foi possível carregar a lista" hint="Verifique a conexão e tente novamente." />
        ) : !stale ? (
          <p className="font-body text-body text-neutral-600">Carregando médicos...</p>
        ) : (
          <>
            <DataTable
              columns={staleColumns}
              rows={stale.doctors}
              rowKey={(d) => d.id}
              emptyMessage="Nenhum médico esquecido"
              minWidth={640}
            />
            <p className="font-body text-caption text-neutral-600">
              {stale.total === 1 ? '1 médico' : `${stale.total} médicos`}
              {stale.truncated ? ` — mostrando os primeiros ${stale.doctors.length}` : ''}
            </p>
          </>
        )}
      </section>
    </PageContainer>
  );
}

/** Barras por finalidade, cada uma na cor (token) da própria finalidade — D-330/D-333. */
function PurposeChart({ rows }: { rows: VisitationReportPurposeRow[] }) {
  const data = rows.map((row) => ({ name: row.purpose.name, total: row.total, completed: row.completed, color: row.purpose.color }));
  const height = Math.max(200, data.length * 34 + 24);
  return (
    <div className="flex h-full flex-col rounded-lg border border-neutral-200 bg-neutral-100 p-lg shadow-sm">
      <header className="mb-lg">
        <h3 className="font-heading text-section">Visitas por finalidade</h3>
        <p className="mt-xs font-body text-caption text-neutral-600">Todas as visitas do período, por finalidade</p>
      </header>
      {data.length === 0 ? (
        <p className="font-body text-body text-neutral-600">Sem visita no período.</p>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }} barSize={18}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} horizontal={false} />
            <XAxis type="number" tick={CHART_TICK} allowDecimals={false} />
            <YAxis type="category" dataKey="name" tick={CHART_TICK} width={140} />
            <Tooltip
              contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
              labelStyle={CHART_TOOLTIP_LABEL_STYLE}
              formatter={(value) => [String(value), 'Visitas']}
            />
            <Bar dataKey="total" radius={[0, 4, 4, 0]}>
              {data.map((entry) => (
                <Cell key={entry.name} fill={`var(--color-purpose-${entry.color}-dot)`} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

const GRANULARITY_OPTIONS: Array<{ value: VisitationReportGranularity; label: string }> = [
  { value: 'week', label: 'Semana' },
  { value: 'month', label: 'Mês' },
];

function EvolutionChart({
  points,
  granularity,
  onGranularityChange,
}: {
  points: VisitationReportEvolutionPoint[];
  granularity: VisitationReportGranularity;
  onGranularityChange: (value: VisitationReportGranularity) => void;
}) {
  const data = useMemo(() => points.map((p) => ({ ...p, label: bucketLabel(p.bucket, granularity) })), [points, granularity]);
  return (
    <div className="flex h-full flex-col rounded-lg border border-neutral-200 bg-neutral-100 p-lg shadow-sm">
      <header className="mb-lg flex flex-wrap items-start justify-between gap-md">
        <div>
          <h3 className="font-heading text-section">Evolução</h3>
          <p className="mt-xs font-body text-caption text-neutral-600">Visitas e realizadas por {granularity === 'week' ? 'semana' : 'mês'}</p>
        </div>
        <SegmentedControl
          aria-label="Agrupar por"
          options={GRANULARITY_OPTIONS}
          value={granularity}
          onChange={onGranularityChange}
          fullWidth={false}
        />
      </header>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={data} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} vertical={false} />
          <XAxis dataKey="label" tick={CHART_TICK} />
          <YAxis tick={CHART_TICK} allowDecimals={false} width={40} />
          <Tooltip contentStyle={CHART_TOOLTIP_CONTENT_STYLE} labelStyle={CHART_TOOLTIP_LABEL_STYLE} />
          <Legend iconType="plainline" />
          <Line type="monotone" dataKey="total" name="Visitas" stroke={CHART_POSITIVE_DEEP_COLOR} strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="completed" name="Realizadas" stroke={CHART_ACCENT_COLOR} strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
