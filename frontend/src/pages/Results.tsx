import { useMemo, useState } from 'react';
import {
  useLisBudgetsFilters,
  useLisBudgetsPendingSummary,
  useLisBudgetsSummary,
  useLisImportsLatest,
} from '@/api/lis';
import { useExecutiveReport } from '@/api/reports';
import { useSalesSummary } from '@/api/sales';
import { useCommissionSettings } from '@/api/commission-settings';
import { useUIStore } from '@/stores/ui.store';
import { useAuthStore } from '@/stores/auth.store';
import { PageContainer, PageHeader } from '@/components/layout';
import { Button, Select, useToast } from '@/components/ui';
import { DataTable, DateDisplay, EmptyState, MoneyDisplay } from '@/components/shared';
import type { DataTableColumn } from '@/components/shared';
import { ResultsKpiCard } from '@/components/lis/ResultsKpiCard';
import { PeriodFilter, previousPeriod } from '@/components/lis/PeriodFilter';
import { AttendantRevenueChart } from '@/components/lis/AttendantRevenueChart';
import { InsuranceDonutChart } from '@/components/lis/InsuranceDonutChart';
import { MonthlySeriesChart } from '@/components/lis/MonthlySeriesChart';
import { ImportModal } from '@/components/lis/ImportModal';
import { PurgeDialog } from '@/components/lis/PurgeDialog';
import { buildCommissionDetail, totalsOf } from '@/lib/lis/commission-detail';
import type { CommissionDetailRow } from '@/lib/lis/commission-detail';
import { generateExecutiveReportPdf } from '@/lib/pdf/executive-report';
import { generateCommissionReportPdf } from '@/lib/pdf/commission-report';
import { generateCommissionReportExcel } from '@/lib/excel/commission-report';

/** Percentual de `part` sobre `whole`, com uma casa. `whole` zerado vira "0.0". */
function share(part: number, whole: number): string {
  return whole > 0 ? ((part / whole) * 100).toFixed(1) : '0.0';
}

/**
 * Esqueleto dos 4 cartões enquanto o resumo carrega. Um "Carregando..." solto
 * fazia a página saltar de uma linha de texto para uma grade inteira; o
 * esqueleto reserva a altura final e a leitura não pula.
 */
function KpiSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-lg sm:grid-cols-2 xl:grid-cols-4" aria-hidden="true">
      {[0, 1, 2, 3].map((slot) => (
        <div
          key={slot}
          className="h-[148px] rounded-lg border border-neutral-200 bg-neutral-100 motion-safe:animate-pulse"
        />
      ))}
    </div>
  );
}

/**
 * Que base está na tela: nome do arquivo e quando entrou. Fica dentro da barra
 * de filtro, colado ao período — as duas informações respondem juntas à mesma
 * pergunta ("de onde vem e de quando é o que estou vendo").
 */
function ImportStamp({ fileName, createdAt }: { fileName: string | null; createdAt?: string }) {
  if (!createdAt) {
    return <p className="font-body text-caption text-neutral-600">Nenhuma importação ainda</p>;
  }

  return (
    <div className="min-w-0 text-right">
      <p className="truncate font-body text-caption font-semibold text-neutral-800" title={fileName ?? undefined}>
        {fileName ?? 'Importação'}
      </p>
      <p className="font-body text-caption text-neutral-600">
        Importada em <DateDisplay value={createdAt} variant="absolute" />
      </p>
    </div>
  );
}

/**
 * Resultados (`/results`) — home do domínio LIS (PAGES.md §14).
 *
 * Leitura em três tempos, de cima para baixo: o que estou vendo (barra de
 * filtro + carimbo da importação), quanto deu (4 KPIs, com o Total Orçado em
 * destaque), e de onde veio (gráficos e o detalhe por atendente). A largura é
 * de painel (`PageContainer wide`): a tabela de comissão tem 10 colunas e a
 * largura de leitura de 1180px a empurrava para rolagem horizontal.
 */
export default function Results() {
  const role = useAuthStore((s) => s.user?.role);
  const isAdmin = role === 'admin';
  const { toast } = useToast();

  const lisFilters = useUIStore((s) => s.lisFilters);
  const setLisFilters = useUIStore((s) => s.setLisFilters);

  const [showImport, setShowImport] = useState(false);
  const [showPurge, setShowPurge] = useState(false);

  const period = { startDate: lisFilters.startDate, endDate: lisFilters.endDate };
  const periodInvalid = period.endDate < period.startDate;
  const insuranceId = lisFilters.insuranceId || undefined;

  const { data: filters } = useLisBudgetsFilters();
  const { data: latestImport } = useLisImportsLatest();
  const { data: commissionSettings } = useCommissionSettings();

  const { data: summary, isLoading } = useLisBudgetsSummary(
    { ...period, insuranceId },
    { enabled: !periodInvalid },
  );
  const { data: previousSummary } = useLisBudgetsSummary(
    { ...previousPeriod(period), insuranceId },
    { enabled: !periodInvalid },
  );
  const { data: executiveReport } = useExecutiveReport(period, { enabled: !periodInvalid });
  const { data: salesSummary } = useSalesSummary(period);
  // O tema vem no login e mora no store — nada de request extra (FRONTEND_BACKEND.md).
  const theme = useAuthStore((s) => s.theme);
  const { data: pendingSummary } = useLisBudgetsPendingSummary();

  const commissionRows = useMemo<CommissionDetailRow[]>(() => {
    if (!summary || !commissionSettings) return [];
    return buildCommissionDetail(
      summary.byAttendantDetail,
      salesSummary?.byAttendant,
      commissionSettings.commissionBudgetPct,
    );
  }, [summary, salesSummary, commissionSettings]);
  const commissionTotals = useMemo(() => totalsOf(commissionRows), [commissionRows]);

  const deltaPct = useMemo(() => {
    const previousTotal = previousSummary?.issued.totalValue ?? 0;
    if (!summary || previousTotal <= 0) return undefined;
    return ((summary.issued.totalValue - previousTotal) / previousTotal) * 100;
  }, [summary, previousSummary]);

  /**
   * Fatias do donut em RECEBIDO (`paidValue`), não em orçado: o gráfico responde
   * de onde vem o dinheiro que entrou. O fecho "Outros" é a diferença entre o
   * KPI "Recebido" e a soma dos 6 convênios mostrados — a mesma base, senão a
   * tela somaria dois números de janelas diferentes.
   */
  const insuranceSlices = useMemo(() => {
    if (!summary) return [];
    const shown = summary.byInsurance
      .filter((row) => row.paidValue > 0)
      .map((row) => ({ name: row.insuranceName, value: row.paidValue }));
    const shownTotal = shown.reduce((sum, s) => sum + s.value, 0);
    const remainder = Math.max(0, summary.paid.totalValue - shownTotal);
    return remainder > 0 ? [...shown, { name: 'Outros', value: remainder }] : shown;
  }, [summary]);

  async function handleExportExecutivePdf() {
    if (!executiveReport) return;
    try {
      await generateExecutiveReportPdf({
        report: executiveReport,
        theme,
        // `/reports/executive` ignora o filtro de convênio (D-116: o PDF é o
        // retrato do período inteiro). Comissões e comparativo saem de
        // `/lis-budgets/summary`, que o RESPEITA — juntar os dois com o filtro
        // ligado misturaria duas bases. Nesse caso o PDF sai só com o que o
        // relatório do servidor cobre, em vez de somar números incompatíveis.
        previous: insuranceId ? null : (previousSummary ?? null),
        commission:
          insuranceId || !commissionSettings || commissionRows.length === 0
            ? null
            : { rows: commissionRows, totals: commissionTotals, settings: commissionSettings },
        pending: pendingSummary ?? null,
      });
    } catch {
      toast('Não foi possível gerar o PDF.', { tone: 'attention' });
    }
  }

  async function handleExportCommissionPdf() {
    try {
      await generateCommissionReportPdf(
        commissionRows,
        commissionTotals,
        executiveReport?.brandName ?? 'Laboratório',
        period,
      );
    } catch {
      toast('Não foi possível gerar o PDF.', { tone: 'attention' });
    }
  }

  async function handleExportCommissionExcel() {
    try {
      await generateCommissionReportExcel(commissionRows, commissionTotals, period);
    } catch {
      toast('Não foi possível gerar o Excel.', { tone: 'attention' });
    }
  }

  const commissionColumns: Array<DataTableColumn<CommissionDetailRow>> = [
    { key: 'attendantName', header: 'Atendente', render: (r) => r.attendantName },
    { key: 'issuedCount', header: 'Orç.', render: (r) => String(r.issuedCount) },
    { key: 'paidValue', header: 'Recebido', render: (r) => <MoneyDisplay value={r.paidValue} /> },
    { key: 'conversionQty', header: 'Conv. %', render: (r) => `${r.conversionQty.toFixed(1)}%` },
    {
      key: 'budgetCommission',
      header: `Com. Orç. (${commissionSettings?.commissionBudgetPct ?? 0}%)`,
      render: (r) => <MoneyDisplay value={r.budgetCommission} />,
    },
    { key: 'examsValue', header: 'Vendas Exames', render: (r) => <MoneyDisplay value={r.examsValue} /> },
    {
      key: 'examsCommission',
      header: `Com. Exames (${commissionSettings?.commissionExamsPct ?? 0}%)`,
      render: (r) => <MoneyDisplay value={r.examsCommission} />,
    },
    { key: 'checkupValue', header: 'Vendas Check-up', render: (r) => <MoneyDisplay value={r.checkupValue} /> },
    {
      key: 'checkupCommission',
      header: `Com. Check-up (${commissionSettings?.commissionCheckupPct ?? 0}%)`,
      render: (r) => <MoneyDisplay value={r.checkupCommission} />,
    },
    {
      key: 'totalCommission',
      header: 'Comissão Total',
      align: 'right',
      render: (r) => <MoneyDisplay value={r.totalCommission} emphasis />,
    },
  ];

  return (
    <PageContainer wide>
      <PageHeader
        title="Resultados"
        size="compact"
        description="Orçamentos do LIS no período selecionado."
        actions={
          <>
            <Button variant="secondary" onClick={() => setShowImport(true)}>
              Importar
            </Button>
            <Button variant="primary" onClick={handleExportExecutivePdf} disabled={!executiveReport}>
              Exportar relatório executivo
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-lg rounded-lg border border-neutral-200 bg-neutral-100 px-lg py-md shadow-sm">
        <div className="flex flex-wrap items-center gap-lg">
          <PeriodFilter value={period} onChange={(p) => setLisFilters({ ...lisFilters, ...p })} />

          <div className="flex items-center gap-sm">
            <span aria-hidden="true" className="font-body text-caption text-neutral-700">
              Convênio
            </span>
            <div className="w-[208px]">
              <Select
                aria-label="Convênio"
                value={lisFilters.insuranceId}
                onChange={(e) => setLisFilters({ ...lisFilters, insuranceId: e.target.value })}
                options={[
                  { value: '', label: 'Todos os convênios' },
                  ...(filters?.insurances.map((i) => ({ value: i.id, label: i.name })) ?? []),
                ]}
              />
            </div>
          </div>
        </div>

        <ImportStamp
          fileName={latestImport?.fileName ?? null}
          createdAt={latestImport?.createdAt}
        />
      </div>

      {isLoading ? (
        <KpiSkeleton />
      ) : !summary || summary.issued.count === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-neutral-100 shadow-sm">
          <EmptyState
            message="Nenhum orçamento importado neste período."
            hint="Troque o período acima ou importe a planilha do LIS para ver os números."
            action={
              <Button variant="secondary" onClick={() => setShowImport(true)}>
                Importar planilha
              </Button>
            }
          />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-lg sm:grid-cols-2 xl:grid-cols-4">
            <ResultsKpiCard
              icon="wallet"
              highlight
              label="Total Orçado"
              value={<MoneyDisplay value={summary.issued.totalValue} emphasis size="metric" />}
              caption={`${summary.issued.count} orçamentos`}
              deltaPct={deltaPct}
              deltaLabel="vs. período anterior"
            />
            <ResultsKpiCard
              icon="money"
              label="Em Requisição"
              value={<MoneyDisplay value={summary.requisition.totalValue} emphasis size="metric" />}
              caption={`${summary.requisition.count} requisições, ${share(
                summary.requisition.totalValue,
                summary.issued.totalValue,
              )}% do orçado`}
            />
            <ResultsKpiCard
              icon="trend"
              label="Recebido"
              value={<MoneyDisplay value={summary.paid.totalValue} emphasis size="metric" />}
              caption={`${summary.paid.count} pagos, ${share(
                summary.paid.totalValue,
                summary.issued.totalValue,
              )}% do orçado`}
              progress={summary.paid.conversionQty}
              progressLabel="Taxa de conversão"
            />
            <ResultsKpiCard
              icon="people"
              label="Atendentes"
              value={summary.byAttendantDetail.length}
              caption={`${summary.byAttendantDetail.length} com orçamento no período`}
            />
          </div>

          <MonthlySeriesChart
            data={executiveReport?.monthlySeries ?? []}
            note={
              insuranceId
                ? 'A série de 12 meses considera todos os convênios — o filtro acima vale para os cartões, os gráficos abaixo e a tabela.'
                : undefined
            }
          />

          <div className="grid grid-cols-1 gap-lg lg:grid-cols-12">
            <div className="lg:col-span-7">
              <AttendantRevenueChart
                data={summary.byAttendantDetail.map((a) => ({
                  attendantName: a.attendantName,
                  paidValue: a.paidValue,
                }))}
              />
            </div>
            <div className="lg:col-span-5">
              <InsuranceDonutChart slices={insuranceSlices} />
            </div>
          </div>

          <section className="space-y-md rounded-lg border border-neutral-200 bg-neutral-100 p-lg shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-md">
              <div>
                <h3 className="font-heading text-section">Detalhe por atendente</h3>
                <p className="mt-xs font-body text-caption text-neutral-600">
                  {commissionRows.length} pessoas, com orçamentos, vendas e comissões
                </p>
              </div>
              <div className="flex items-center gap-sm">
                <span className="rounded-pill bg-accent2-200 px-md py-xs font-body text-caption font-semibold text-accent2-800">
                  % Comissão: {commissionSettings?.commissionBudgetPct ?? 0}%
                </span>
                <Button variant="secondary" size="sm" onClick={handleExportCommissionPdf}>
                  Comissão em PDF
                </Button>
                <Button variant="secondary" size="sm" onClick={handleExportCommissionExcel}>
                  Comissão em Excel
                </Button>
              </div>
            </div>

            <DataTable
              columns={commissionColumns}
              rows={commissionRows}
              rowKey={(r) => r.attendantId}
              emptyMessage="Nenhum atendente com orçamento neste período"
              minWidth={1100}
            />
            {commissionRows.length > 0 && (
              <div className="flex flex-wrap justify-between gap-sm border-t border-neutral-300 pt-md font-body text-caption font-semibold text-neutral-800">
                <span>TOTAL</span>
                <span>
                  {commissionTotals.issuedCount} orç. ·{' '}
                  <MoneyDisplay value={commissionTotals.paidValue} /> recebido ·{' '}
                  <MoneyDisplay value={commissionTotals.totalCommission} emphasis /> em comissão
                </span>
              </div>
            )}
          </section>
        </>
      )}

      {isAdmin && (
        <div className="flex items-center justify-between gap-md border-t border-neutral-200 pt-lg">
          <p className="font-body text-caption text-neutral-600">
            Apagar todos os orçamentos importados deste laboratório. Não tem volta.
          </p>
          <Button variant="destructive" size="sm" onClick={() => setShowPurge(true)}>
            Limpar base
          </Button>
        </div>
      )}

      {showImport && <ImportModal onClose={() => setShowImport(false)} />}
      {showPurge && <PurgeDialog onClose={() => setShowPurge(false)} />}
    </PageContainer>
  );
}
