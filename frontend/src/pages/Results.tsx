import { useState } from 'react';
import { useLisImportsLatest } from '@/api/lis';
import { useExecutiveReport } from '@/api/reports';
import { useUIStore } from '@/stores/ui.store';
import { useAuthStore } from '@/stores/auth.store';
import { PageContainer, PageHeader } from '@/components/layout';
import { Button, useToast } from '@/components/ui';
import { KpiCard } from '@/components/lis/KpiCard';
import { PeriodFilter } from '@/components/lis/PeriodFilter';
import { MonthlySeriesChart } from '@/components/lis/MonthlySeriesChart';
import { ImportModal } from '@/components/lis/ImportModal';
import { PurgeDialog } from '@/components/lis/PurgeDialog';
import { DataTable, DateDisplay } from '@/components/shared';
import { generateExecutiveReportPdf } from '@/lib/pdf/executive-report';

/**
 * Resultados (`/results`) — home do domínio LIS (PAGES.md §14).
 * `GET /reports/executive` alimenta os KPIs, a série mensal, os tops e o PDF
 * — a tela e o PDF nunca divergem (D-116) porque derivam do MESMO fetch.
 */
export default function Results() {
  const role = useAuthStore((s) => s.user?.role);
  const isAdmin = role === 'admin';

  const lisFilters = useUIStore((s) => s.lisFilters);
  const setLisFilters = useUIStore((s) => s.setLisFilters);
  const { toast } = useToast();

  const [showImport, setShowImport] = useState(false);
  const [showPurge, setShowPurge] = useState(false);

  const periodInvalid = lisFilters.endDate < lisFilters.startDate;

  const { data: latestImport } = useLisImportsLatest();
  const { data: report, isLoading } = useExecutiveReport(
    { startDate: lisFilters.startDate, endDate: lisFilters.endDate },
    { enabled: !periodInvalid },
  );

  async function handleExportPdf() {
    if (!report) return;
    try {
      await generateExecutiveReportPdf(report);
    } catch {
      toast('Não foi possível gerar o PDF.', { tone: 'attention' });
    }
  }

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
            <Button variant="primary" onClick={handleExportPdf} disabled={!report}>
              Exportar PDF
            </Button>
          </div>
        }
      />

      <div className="space-y-lg">
        <PeriodFilter
          value={{ startDate: lisFilters.startDate, endDate: lisFilters.endDate }}
          onChange={(period) => setLisFilters({ ...lisFilters, ...period })}
        />

        <p className="font-body text-caption text-neutral-600">
          {latestImport ? (
            <>
              Última atualização em <DateDisplay value={latestImport.createdAt} variant="absolute" />
            </>
          ) : (
            'Nenhuma importação ainda'
          )}
        </p>

        {isLoading ? (
          <div className="font-body text-body text-neutral-600">Carregando...</div>
        ) : !report ? (
          <div className="font-body text-body text-neutral-600">
            Nenhum orçamento importado neste período.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-lg">
              <KpiCard label="Emitidos" value={report.issued.count} variant="number" />
              <KpiCard label="Valor emitido" value={report.issued.totalValue} variant="money" />
              <KpiCard label="Ticket médio (emitido)" value={report.issued.averageTicket} variant="money" />
              <KpiCard label="Pagos" value={report.paid.count} variant="number" />
              <KpiCard label="Valor pago" value={report.paid.totalValue} variant="money" />
              <KpiCard label="Conversão" value={report.paid.conversionQty} variant="percent" />
            </div>

            <MonthlySeriesChart data={report.monthlySeries} />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-lg">
              <div className="bg-neutral-100 p-lg rounded-md shadow-sm">
                <h3 className="font-heading text-section mb-lg">Top Atendentes</h3>
                <DataTable
                  columns={[
                    { key: 'name', header: 'Atendente', render: (r) => r.attendantName },
                    { key: 'issued', header: 'Emitidos', render: (r) => String(r.issuedCount) },
                    {
                      key: 'paid',
                      header: 'Pago',
                      align: 'right',
                      render: (r) => new Intl.NumberFormat('pt-BR', {
                        style: 'currency',
                        currency: 'BRL',
                      }).format(r.paidValue),
                    },
                  ]}
                  rows={report.byAttendant}
                  rowKey={(r) => r.attendantId}
                  emptyMessage="Sem dados no período"
                />
              </div>
              <div className="bg-neutral-100 p-lg rounded-md shadow-sm">
                <h3 className="font-heading text-section mb-lg">Top Convênios</h3>
                <DataTable
                  columns={[
                    { key: 'name', header: 'Convênio', render: (r) => r.insuranceName },
                    { key: 'count', header: 'Contagem', render: (r) => String(r.count) },
                    {
                      key: 'value',
                      header: 'Valor',
                      align: 'right',
                      render: (r) => new Intl.NumberFormat('pt-BR', {
                        style: 'currency',
                        currency: 'BRL',
                      }).format(r.totalValue),
                    },
                  ]}
                  rows={report.byInsurance}
                  rowKey={(r) => r.insuranceName}
                  emptyMessage="Sem dados no período"
                />
              </div>
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
