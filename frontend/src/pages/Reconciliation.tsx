import { useState } from 'react';
import { useLisBudgetList, useLisBudgetsFilters } from '@/api/lis';
import { useUIStore } from '@/stores/ui.store';
import { PageContainer, PageHeader } from '@/components/layout';
import { Button, SearchInput, Select } from '@/components/ui';
import { DataTable, MoneyDisplay, Pagination } from '@/components/shared';
import type { DataTableColumn } from '@/components/shared';
import type { LisBudget } from '@crm-lab/shared';
import { PeriodFilter } from '@/components/lis/PeriodFilter';
import { ImportModal } from '@/components/lis/ImportModal';
import { formatIsoDay } from '@/lib/format';

/**
 * Conferência (`/reconciliation`) — listagem crua e paginada dos orçamentos
 * importados (PAGES.md §15). Fonte: `GET /lis-budgets` (§10.2).
 */
export default function Reconciliation() {
  const lisFilters = useUIStore((s) => s.lisFilters);
  const setLisFilters = useUIStore((s) => s.setLisFilters);

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [showImport, setShowImport] = useState(false);

  const periodInvalid = lisFilters.endDate < lisFilters.startDate;

  const { data: filters } = useLisBudgetsFilters();
  const { data, isLoading } = useLisBudgetList(
    {
      page,
      limit: 20,
      startDate: lisFilters.startDate,
      endDate: lisFilters.endDate,
      attendantId: lisFilters.attendantId || undefined,
      insuranceId: lisFilters.insuranceId || undefined,
      search: search || undefined,
    },
    { enabled: !periodInvalid },
  );

  const columns: Array<DataTableColumn<LisBudget>> = [
    { key: 'number', header: 'Número', render: (b) => b.number },
    { key: 'issuedOn', header: 'Emitido em', render: (b) => (b.issuedOn ? formatIsoDay(b.issuedOn) : '—') },
    { key: 'patientName', header: 'Paciente', render: (b) => b.patientName ?? '—' },
    { key: 'insurance', header: 'Convênio', render: (b) => b.principalInsuranceName ?? '—' },
    {
      key: 'totalValue',
      header: 'Valor total',
      align: 'right',
      render: (b) => <MoneyDisplay value={b.totalValue} />,
    },
    { key: 'attendantName', header: 'Atendente', render: (b) => b.attendantName ?? '—' },
    { key: 'requisitionNumber', header: 'Nº requisição', render: (b) => b.requisitionNumber ?? '—' },
    {
      key: 'paidValue',
      header: 'Valor pago',
      align: 'right',
      render: (b) => (b.paidValue !== null ? <MoneyDisplay value={b.paidValue} /> : '—'),
    },
    { key: 'paidOn', header: 'Pago em', render: (b) => (b.paidOn ? formatIsoDay(b.paidOn) : '—') },
  ];

  return (
    <PageContainer>
      <PageHeader
        title="Conferência"
        description="Orçamentos do LIS importados, linha por linha."
        actions={
          <Button variant="secondary" onClick={() => setShowImport(true)}>
            Importar
          </Button>
        }
      />

      <div className="space-y-lg">
        <PeriodFilter
          value={{ startDate: lisFilters.startDate, endDate: lisFilters.endDate }}
          onChange={(period) => {
            setLisFilters({ ...lisFilters, ...period });
            setPage(1);
          }}
        />

        <div className="flex flex-wrap gap-md">
          <Select
            label="Atendente"
            value={lisFilters.attendantId}
            onChange={(e) => {
              setLisFilters({ ...lisFilters, attendantId: e.target.value });
              setPage(1);
            }}
            options={[
              { value: '', label: 'Todos' },
              ...(filters?.attendants.map((a) => ({ value: a.id, label: a.name })) ?? []),
            ]}
          />
          <Select
            label="Convênio"
            value={lisFilters.insuranceId}
            onChange={(e) => {
              setLisFilters({ ...lisFilters, insuranceId: e.target.value });
              setPage(1);
            }}
            options={[
              { value: '', label: 'Todos' },
              ...(filters?.insurances.map((i) => ({ value: i.id, label: i.name })) ?? []),
            ]}
          />
          <SearchInput
            placeholder="Buscar paciente"
            onSearch={(term) => {
              setSearch(term);
              setPage(1);
            }}
            aria-label="Buscar por nome do paciente"
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
              emptyMessage="Nenhum orçamento neste filtro"
              minWidth={960}
            />
            {data && (
              <Pagination pagination={data.pagination} onPageChange={setPage} itemLabel="orçamentos" />
            )}
          </>
        )}
      </div>

      {showImport && <ImportModal onClose={() => setShowImport(false)} />}
    </PageContainer>
  );
}
