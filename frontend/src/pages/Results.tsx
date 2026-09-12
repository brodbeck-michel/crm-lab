import { useMemo, useState } from 'react';
import { useLisBudgetsFilters, useLisBudgetsSummary, useLisImportsLatest } from '@/api/lis';
import { useExecutiveReport } from '@/api/reports';
import { useSalesSummary } from '@/api/sales';
import { useCommissionSettings } from '@/api/commission-settings';
import { useUIStore, defaultLisFilters } from '@/stores/ui.store';
import { useAuthStore } from '@/stores/auth.store';
import { PageContainer, PageHeader } from '@/components/layout';
import { Button, Select, useToast } from '@/components/ui';
import { DataTable, DateDisplay, MoneyDisplay } from '@/components/shared';
import type { DataTableColumn } from '@/components/shared';
import { ResultsKpiCard } from '@/components/lis/ResultsKpiCard';
import { PeriodFilter, previousPeriod } from '@/components/lis/PeriodFilter';
import { AttendantRevenueChart } from '@/components/lis/AttendantRevenueChart';
import { InsuranceDonutChart } from '@/components/lis/InsuranceDonutChart';
import { ImportModal } from '@/components/lis/ImportModal';
import { PurgeDialog } from '@/components/lis/PurgeDialog';
import { buildCommissionDetail, totalsOf } from '@/lib/lis/commission-detail';
import type { CommissionDetailRow } from '@/lib/lis/commission-detail';
import { generateExecutiveReportPdf } from '@/lib/pdf/executive-report';
import { generateCommissionReportPdf } from '@/lib/pdf/commission-report';
import { generateCommissionReportExcel } from '@/lib/excel/commission-report';

/**
 * Resultados (`/results`) — home do domínio LIS (PAGES.md §14), redesenhada
 * a partir da referência visual real do produto equivalente (FluxoLab/Santé).
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

  const insuranceSlices = useMemo(() => {
    if (!summary) return [];
    const shown = summary.byInsurance.map((row) => ({ name: row.insuranceName, value: row.totalValue }));
    const shownTotal = shown.reduce((sum, s) => sum + s.value, 0);
    const remainder = Math.max(0, summary.issued.totalValue - shownTotal);
    return remainder > 0 ? [...shown, { name: 'Outros', value: remainder }] : shown;
  }, [summary]);

  async function handleExportExecutivePdf() {
    if (!executiveReport) return;
    try {
      await generateExecutiveReportPdf(executiveReport);
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
    <PageContainer>
      <PageHeader
        title="Resultados"
        description="Visão executiva dos orçamentos do LIS."
        actions={
          <div className="flex gap-md">
            <Button variant="secondary" onClick={() => setShowImport(true)}>
              Importar
            </Button>
            <Button variant="primary" onClick={handleExportExecutivePdf} disabled={!executiveReport}>
              Exportar Relatório Executivo
            </Button>
          </div>
        }
      />

      <div className="space-y-lg">
        <div className="flex flex-wrap items-end justify-between gap-lg">
          <div className="flex flex-wrap items-end gap-md">
            <PeriodFilter value={period} onChange={(p) => setLisFilters({ ...lisFilters, ...p })} />
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                setLisFilters({ ...lisFilters, ...{ startDate: defaultLisFilters().startDate, endDate: defaultLisFilters().endDate } })
              }
            >
              Limpar período
            </Button>
            <Select
              label="Convênio"
              value={lisFilters.insuranceId}
              onChange={(e) => setLisFilters({ ...lisFilters, insuranceId: e.target.value })}
              options={[
                { value: '', label: 'Todos os convênios' },
                ...(filters?.insurances.map((i) => ({ value: i.id, label: i.name })) ?? []),
              ]}
            />
          </div>
          <p className="font-body text-caption text-neutral-600 text-right">
            {latestImport ? (
              <>
                {latestImport.fileName ?? 'Importação'}
                <br />
                Importado em <DateDisplay value={latestImport.createdAt} variant="absolute" />
              </>
            ) : (
              'Nenhuma importação ainda'
            )}
          </p>
        </div>

        {isLoading ? (
          <div className="font-body text-body text-neutral-600">Carregando...</div>
        ) : !summary || summary.issued.count === 0 ? (
          <div className="font-body text-body text-neutral-600">
            Nenhum orçamento importado neste período.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-lg">
              <ResultsKpiCard
                icon="wallet"
                highlight
                label="Total Orçado"
                value={<MoneyDisplay value={summary.issued.totalValue} emphasis />}
                caption={`${summary.issued.count} orçamentos`}
                deltaPct={deltaPct}
              />
              <ResultsKpiCard
                icon="money"
                label="Em Requisição"
                value={<MoneyDisplay value={summary.requisition.totalValue} emphasis />}
                caption={`${summary.requisition.count} req. · ${
                  summary.issued.totalValue > 0
                    ? ((summary.requisition.totalValue / summary.issued.totalValue) * 100).toFixed(1)
                    : '0.0'
                }% do total`}
              />
              <ResultsKpiCard
                icon="trend"
                label="Recebido"
                value={<MoneyDisplay value={summary.paid.totalValue} emphasis />}
                caption={`${summary.paid.count} pagos · ${
                  summary.issued.totalValue > 0
                    ? ((summary.paid.totalValue / summary.issued.totalValue) * 100).toFixed(1)
                    : '0.0'
                }% do orçamento`}
                progress={summary.paid.conversionQty}
                progressLabel="Taxa de conversão"
              />
              <ResultsKpiCard
                icon="people"
                label="Atendentes"
                value={summary.byAttendantDetail.length}
                caption={`${summary.byAttendantDetail.length} ativo(s) no período`}
              />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-lg">
              <AttendantRevenueChart
                data={summary.byAttendantDetail.map((a) => ({
                  attendantName: a.attendantName,
                  paidValue: a.paidValue,
                }))}
              />
              <InsuranceDonutChart slices={insuranceSlices} />
            </div>

            <div className="bg-neutral-100 p-lg rounded-md shadow-sm space-y-md">
              <div className="flex flex-wrap items-center justify-between gap-md">
                <div>
                  <h3 className="font-heading text-section">Detalhe por atendente</h3>
                  <p className="font-body text-caption text-neutral-600">
                    {commissionRows.length} pessoas · orçamentos, vendas e comissões
                  </p>
                </div>
                <div className="flex items-center gap-sm">
                  <span className="font-body text-caption font-semibold bg-accent2-200 text-accent2-800 rounded-pill px-md py-xs">
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
                <div className="flex justify-between font-body text-caption font-semibold text-neutral-800 border-t border-neutral-300 pt-md">
                  <span>TOTAL</span>
                  <span>
                    {commissionTotals.issuedCount} orç. ·{' '}
                    <MoneyDisplay value={commissionTotals.paidValue} /> recebido ·{' '}
                    <MoneyDisplay value={commissionTotals.totalCommission} emphasis /> em comissão
                  </span>
                </div>
              )}
            </div>
          </>
        )}

        {isAdmin && (
          <div className="pt-xl border-t border-neutral-200">
            <Button variant="destructive" onClick={() => setShowPurge(true)}>
              Limpar base
            </Button>
          </div>
        )}
      </div>

      {showImport && <ImportModal onClose={() => setShowImport(false)} />}
      {showPurge && <PurgeDialog onClose={() => setShowPurge(false)} />}
    </PageContainer>
  );
}
