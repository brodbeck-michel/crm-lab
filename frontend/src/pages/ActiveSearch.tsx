import { useState } from 'react';
import type { LisBudgetAgeBand, PendingLisBudget } from '@crm-lab/shared';
import { LIS_BUDGET_AGE_BANDS } from '@crm-lab/shared';
import { useLisBudgetsFilters, useLisBudgetsPending, useLisBudgetsPendingSummary } from '@/api/lis';
import { useAuthStore } from '@/stores/auth.store';
import { PageContainer, PageHeader } from '@/components/layout';
import { Button, Select, useToast } from '@/components/ui';
import { DataTable, MoneyDisplay, Pagination } from '@/components/shared';
import type { DataTableColumn } from '@/components/shared';
import { KpiCard } from '@/components/lis/KpiCard';
import { AgeBadge } from '@/components/lis/AgeBadge';
import { formatIsoDay } from '@/lib/format';
import { generateActiveSearchPdf } from '@/lib/pdf/active-search';

const AGE_BAND_LABEL: Record<LisBudgetAgeBand, string> = {
  '0-7': '0-7 dias',
  '8-15': '8-15 dias',
  '16-30': '16-30 dias',
  '30+': '30+ dias',
};

/**
 * Busca Ativa (`/active-search`) — orçamentos com requisição mas sem
 * pagamento recebido (PAGES.md §16). Fonte: `GET /lis-budgets/pending` +
 * `GET /lis-budgets/pending/summary` (§10.2).
 */
export default function ActiveSearch() {
  const theme = useAuthStore((s) => s.theme);
  const tenant = useAuthStore((s) => s.tenant);
  const { toast } = useToast();

  const [page, setPage] = useState(1);
  const [attendantId, setAttendantId] = useState('');
  const [ageBand, setAgeBand] = useState<LisBudgetAgeBand | ''>('');

  const { data: filters } = useLisBudgetsFilters();
  const { data: summary } = useLisBudgetsPendingSummary({ attendantId: attendantId || undefined });
  const { data, isLoading } = useLisBudgetsPending({
    page,
    limit: 20,
    attendantId: attendantId || undefined,
    ageBand: ageBand || undefined,
  });

  async function handleExportPdf() {
    if (!summary) return;
    try {
      // PDF cobre a fila inteira (não só a página atual) — refaz o fetch
      // sem paginação, mesmo filtro, para não exportar 20 de 34 linhas.
      const full = await import('@/api/lis').then((m) =>
        m.lisBudgetsApi.pending({ limit: 1000, attendantId: attendantId || undefined, ageBand: ageBand || undefined }),
      );
      await generateActiveSearchPdf(summary, full.budgets, theme?.brandName || tenant?.name || 'Laboratório');
    } catch {
      toast('Não foi possível gerar o PDF.', { tone: 'attention' });
    }
  }

  const columns: Array<DataTableColumn<PendingLisBudget>> = [
    { key: 'number', header: 'Número', render: (b) => b.number },
    { key: 'patientName', header: 'Paciente', render: (b) => b.patientName ?? '—' },
    { key: 'insurance', header: 'Convênio', render: (b) => b.principalInsuranceName ?? '—' },
    { key: 'totalValue', header: 'Valor total', align: 'right', render: (b) => <MoneyDisplay value={b.totalValue} /> },
    { key: 'attendantName', header: 'Atendente', render: (b) => b.attendantName ?? '—' },
    { key: 'requisitionNumber', header: 'Nº requisição', render: (b) => b.requisitionNumber ?? '—' },
    { key: 'issuedOn', header: 'Emitido em', render: (b) => (b.issuedOn ? formatIsoDay(b.issuedOn) : '—') },
    { key: 'age', header: 'Em aberto', render: (b) => <AgeBadge daysOpen={b.daysOpen} ageBand={b.ageBand} /> },
  ];

  return (
    <PageContainer>
      <PageHeader
        title="Busca Ativa"
        description="Orçamentos com requisição emitida, sem pagamento recebido."
        actions={
          <Button variant="primary" onClick={handleExportPdf} disabled={!summary}>
            Exportar PDF
          </Button>
        }
      />

      <div className="space-y-lg">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-lg">
          <KpiCard label="Total em aberto" value={summary?.total.count} variant="number" />
          {LIS_BUDGET_AGE_BANDS.map((band) => (
            <KpiCard
              key={band}
              label={AGE_BAND_LABEL[band]}
              value={summary?.byAgeBand[band]?.count}
              variant="number"
            />
          ))}
        </div>

        <div className="flex flex-wrap gap-md">
          <Select
            label="Atendente"
            value={attendantId}
            onChange={(e) => {
              setAttendantId(e.target.value);
              setPage(1);
            }}
            options={[
              { value: '', label: 'Todos' },
              ...(filters?.attendants.map((a) => ({ value: a.id, label: a.name })) ?? []),
            ]}
          />
          <Select
            label="Faixa"
            value={ageBand}
            onChange={(e) => {
              setAgeBand(e.target.value as LisBudgetAgeBand | '');
              setPage(1);
            }}
            options={[
              { value: '', label: 'Todas' },
              ...LIS_BUDGET_AGE_BANDS.map((band) => ({ value: band, label: AGE_BAND_LABEL[band] })),
            ]}
          />
        </div>

        {isLoading ? (
          <div className="font-body text-body text-neutral-600">Carregando...</div>
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={data?.budgets ?? []}
              rowKey={(b) => b.id}
              emptyMessage="Nenhum orçamento em aberto"
              minWidth={960}
            />
            {data && (
              <Pagination pagination={data.pagination} onPageChange={setPage} itemLabel="orçamentos" />
            )}
          </>
        )}
      </div>
    </PageContainer>
  );
}
