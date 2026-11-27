import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LIS_DOCTOR_NO_DOCTOR_KEY, type LisDoctorRevenueRow } from '@crm-lab/shared';
import { useLisDoctorRevenue } from '@/api/lis';
import { Button, Select, useToast } from '@/components/ui';
import { DataTable, MoneyDisplay, sortRows } from '@/components/shared';
import type { DataTableColumn, DataTableSort } from '@/components/shared';
import { generateDoctorRevenueExcel } from '@/lib/excel/doctor-revenue-report';
import { useVisitationResponsibles } from '@/pages/Visitation/visitation-access';

/** Abre por Em requisição (D-338 item 4; era Recebido). */
const DEFAULT_SORT: DataTableSort = { key: 'requisitionValue', direction: 'desc' };

export interface DoctorRevenueTableProps {
  period: { startDate: string; endDate: string };
  insuranceId?: string;
  enabled: boolean;
}

function doctorLabel(row: LisDoctorRevenueRow): { name: string; detail: string; muted: boolean } {
  if (row.doctorKey === null) return { name: 'Sem médico informado', detail: '', muted: true };
  if (row.doctorKey === LIS_DOCTOR_NO_DOCTOR_KEY) {
    return {
      name: 'Sem médico (CRM 1)',
      detail: 'Sem pedido médico ou solicitado pela enfermagem',
      muted: true,
    };
  }
  const name = row.doctorName ?? '—';
  const council = row.council && row.council !== 'CRM' ? row.council : 'CRM';
  return { name, detail: `${council} ${row.crm ?? ''}/${row.uf ?? ''}`, muted: false };
}

/**
 * Faturamento por médico solicitante em `/results` (PAGES.md §14, CRMLAB-198/D-336).
 * Duas janelas, como o por convênio: requisições EMITIDAS no período e o RECEBIDO no
 * período. Respeita o filtro de convênio da tela; o de representante é só deste cartão.
 */
export function DoctorRevenueTable({ period, insuranceId, enabled }: DoctorRevenueTableProps) {
  const navigate = useNavigate();
  const { responsibles } = useVisitationResponsibles();
  const { toast } = useToast();
  const [responsibleId, setResponsibleId] = useState('');
  // Espelha a ordem do `DataTable` para o Excel sair na ordem da tela (CRMLAB-199).
  const [sort, setSort] = useState<DataTableSort>(DEFAULT_SORT);

  const { data, isLoading } = useLisDoctorRevenue(
    { ...period, insuranceId, responsibleId: responsibleId || undefined },
    { enabled },
  );

  const rows = data?.rows ?? [];
  const totals = data?.totals;
  const paidTotal = totals?.paidValue ?? 0;

  const columns: Array<DataTableColumn<LisDoctorRevenueRow>> = [
    {
      key: 'doctor',
      header: 'Médico',
      minWidth: 240,
      // "Sem médico" (CRM 1 e sem os dados) não tem nome: fica no fim, nos dois sentidos.
      sortValue: (row) => (row.identified ? row.doctorName : null),
      render: (row) => {
        const label = doctorLabel(row);
        return (
          <div>
            <p
              className={
                label.muted
                  ? 'font-body italic text-neutral-600'
                  : 'font-body font-semibold text-neutral-800'
              }
            >
              {label.name}
            </p>
            {label.detail && (
              <p className="font-body text-caption text-neutral-600">{label.detail}</p>
            )}
          </div>
        );
      },
    },
    {
      key: 'responsible',
      header: 'Representante',
      sortValue: (row) => row.responsibleName,
      render: (row) => row.responsibleName ?? '—',
    },
    {
      key: 'requisitionCount',
      header: 'Requisições',
      align: 'right',
      sortValue: (row) => row.requisitionCount,
      render: (row) => row.requisitionCount,
    },
    {
      key: 'requisitionValue',
      header: 'Em requisição',
      align: 'right',
      sortValue: (row) => row.requisitionValue,
      render: (row) => <MoneyDisplay value={row.requisitionValue} />,
    },
    {
      key: 'paidValue',
      header: 'Recebido',
      align: 'right',
      sortValue: (row) => row.paidValue,
      render: (row) => <MoneyDisplay value={row.paidValue} />,
    },
    {
      key: 'share',
      header: '% do recebido',
      align: 'right',
      sortValue: (row) => row.paidValue,
      render: (row) =>
        paidTotal > 0
          ? `${((row.paidValue / paidTotal) * 100).toFixed(1).replace('.', ',')}%`
          : '—',
    },
  ];

  async function handleExportExcel() {
    if (!totals || rows.length === 0) return;
    const column = columns.find((c) => c.key === sort.key);
    const ordered = column?.sortValue ? sortRows(rows, column.sortValue, sort.direction) : rows;
    try {
      await generateDoctorRevenueExcel(ordered, totals, period);
    } catch {
      toast('Não foi possível gerar o Excel.', { tone: 'attention' });
    }
  }

  return (
    <section
      aria-label="Faturamento por médico solicitante"
      className="space-y-md rounded-lg border border-neutral-200 bg-neutral-100 p-lg shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-md">
        <div>
          <h3 className="font-heading text-section">Faturamento por médico solicitante</h3>
          <p className="mt-xs font-body text-caption text-neutral-600">
            Todas as requisições do LIS, com ou sem orçamento. Em requisição = paciente + convênio,
            pela data da requisição. Recebido = pagamentos do paciente.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-sm">
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
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExportExcel}
            disabled={rows.length === 0}
          >
            Exportar em Excel
          </Button>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.doctorKey ?? 'sem-medico'}
        defaultSort={DEFAULT_SORT}
        onSortChange={setSort}
        onRowClick={(row) => {
          if (row.doctorId) navigate(`/visitation/doctors/${row.doctorId}`);
        }}
        emptyMessage={
          isLoading
            ? 'Carregando…'
            : responsibleId
              ? 'Nenhum médico desta carteira com requisição no período.'
              : 'Nenhuma requisição com médico neste período.'
        }
        minWidth={900}
      />
      {totals && rows.length > 0 && (
        <div className="flex flex-wrap justify-between gap-sm border-t border-neutral-300 pt-md font-body text-caption font-semibold text-neutral-800">
          <span>TOTAL</span>
          <span>
            {totals.requisitionCount} requisições · <MoneyDisplay value={totals.requisitionValue} />{' '}
            em requisição · <MoneyDisplay value={totals.paidValue} emphasis /> recebido
          </span>
        </div>
      )}
    </section>
  );
}
