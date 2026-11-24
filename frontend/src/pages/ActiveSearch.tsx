import { useState } from 'react';
import type { LisBudgetAgeBand, PendingLisBudget } from '@crm-lab/shared';
import { LIS_BUDGET_AGE_BANDS } from '@crm-lab/shared';
import { useLisBudgetsFilters, useLisBudgetsPending, useLisBudgetsPendingSummary } from '@/api/lis';
import { useAuthStore } from '@/stores/auth.store';
import { useUIStore } from '@/stores/ui.store';
import { PageContainer, PageHeader } from '@/components/layout';
import { Button, Select, useToast } from '@/components/ui';
import { DataTable, MoneyDisplay, Pagination } from '@/components/shared';
import type { DataTableColumn } from '@/components/shared';
import { AgeBadge } from '@/components/lis/AgeBadge';
import { isPeriodInvalid, PeriodFilter } from '@/components/lis/PeriodFilter';
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
 * `GET /lis-budgets/pending/summary` (§10.2). Recorta pelo período
 * compartilhado com Resultados e Conferência (D-117, D-334).
 */
export default function ActiveSearch() {
  const theme = useAuthStore((s) => s.theme);
  const tenant = useAuthStore((s) => s.tenant);
  const lisFilters = useUIStore((s) => s.lisFilters);
  const setLisFilters = useUIStore((s) => s.setLisFilters);
  const { toast } = useToast();

  const [page, setPage] = useState(1);
  const [attendantId, setAttendantId] = useState('');
  const [ageBand, setAgeBand] = useState<LisBudgetAgeBand | ''>('');

  const periodInvalid = isPeriodInvalid(lisFilters);
  const period = { startDate: lisFilters.startDate, endDate: lisFilters.endDate };

  const { data: filters } = useLisBudgetsFilters();
  // O summary não aparece na tela (D-334), mas é a base do PDF.
  const { data: summary } = useLisBudgetsPendingSummary(
    { ...period, attendantId: attendantId || undefined },
    { enabled: !periodInvalid },
  );
  const { data, isLoading } = useLisBudgetsPending(
    {
      page,
      limit: 20,
      ...period,
      attendantId: attendantId || undefined,
      ageBand: ageBand || undefined,
    },
    { enabled: !periodInvalid },
  );

  async function handleExportPdf() {
    if (!summary) return;
    try {
      // PDF cobre a fila inteira (não só a página atual) — refaz o fetch
      // sem paginação, mesmo filtro, para não exportar 20 de 34 linhas.
      const full = await import('@/api/lis').then((m) =>
        m.lisBudgetsApi.pending({
          limit: 1000,
          ...period,
          attendantId: attendantId || undefined,
          ageBand: ageBand || undefined,
        }),
      );
      await generateActiveSearchPdf({
        summary,
        budgets: full.budgets,
        brandName: theme?.brandName || tenant?.name || 'Laboratório',
        theme,
        filters: {
          attendantName: filters?.attendants.find((a) => a.id === attendantId)?.name ?? null,
          ageBand: ageBand || null,
          period,
        },
      });
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
          <Button variant="primary" onClick={handleExportPdf} disabled={!summary || periodInvalid}>
            Exportar PDF
          </Button>
        }
      />

      <div className="space-y-lg">
        <PeriodFilter
          value={period}
          onChange={(next) => {
            setLisFilters({ ...lisFilters, ...next });
            setPage(1);
          }}
        />

        <div className="grid max-w-[560px] grid-cols-1 gap-md sm:grid-cols-2">
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
