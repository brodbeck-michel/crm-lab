import type { ProposalReminderReportCounts } from '@crm-lab/shared';
import { useAnalyticsReminders } from '@/api/analytics';
import { DataTable, EmptyState } from '@/components/shared';
import type { DataTableColumn } from '@/components/shared';
import { formatCount, formatIsoDay } from '@/lib/format';

interface ReminderReportSectionProps {
  /** `YYYY-MM-DD` ou vazio (o servidor usa os últimos 30 dias). */
  startDate: string;
  endDate: string;
}

/** Linha da tabela: uma responsável, "Sem responsável" ou o total. */
interface ReminderRow {
  key: string;
  name: string;
  counts: ProposalReminderReportCounts;
  total: boolean;
}

const COLUMNS: Array<{ key: keyof ProposalReminderReportCounts; header: string }> = [
  { key: 'overdueOpen', header: 'Vencidos agora' },
  { key: 'won', header: 'Ganho' },
  { key: 'lost', header: 'Perdido' },
  { key: 'rescheduled', header: 'Reagendado' },
  { key: 'autoClosed', header: 'Encerrado automático' },
  { key: 'resolved', header: 'Resolvidos' },
];

/**
 * Aba "Lembretes" de `/analytics` (CRMLAB-103, D-279, PAGES.md §8) — gestor e
 * admin. Uma linha por RESPONSÁVEL pela proposta (não por quem resolveu).
 * "Vencidos agora" é a foto do momento e não depende do período; os desfechos
 * contam o que foi resolvido dentro do período do topo da página.
 */
export default function ReminderReportSection({ startDate, endDate }: ReminderReportSectionProps) {
  const inverted = startDate !== '' && endDate !== '' && endDate < startDate;

  const { data: report, isLoading, isError } = useAnalyticsReminders(
    {
      startDate: startDate === '' ? undefined : startDate,
      endDate: endDate === '' ? undefined : endDate,
    },
    !inverted,
  );

  if (inverted) {
    return (
      <p role="alert" className="font-body text-body text-accent-700">
        Data final anterior à inicial.
      </p>
    );
  }
  if (isLoading) return <div>Carregando dados...</div>;
  if (isError || !report) return <EmptyState message="Não foi possível carregar os lembretes." />;

  const rows: ReminderRow[] = [
    ...report.rows.map((r) => ({ key: r.userId ?? 'sem-responsavel', name: r.name, counts: r, total: false })),
  ];
  if (rows.length > 0) {
    rows.push({ key: 'total', name: 'Total do laboratório', counts: report.total, total: true });
  }

  const columns: Array<DataTableColumn<ReminderRow>> = [
    {
      key: 'name',
      header: 'Responsável',
      render: (r) => (r.total ? <strong>{r.name}</strong> : r.name),
    },
    ...COLUMNS.map((c) => ({
      key: c.key,
      header: c.header,
      align: 'right' as const,
      render: (r: ReminderRow) => {
        const value = formatCount(r.counts[c.key]);
        return r.total || c.key === 'resolved' ? <strong>{value}</strong> : value;
      },
    })),
  ];

  return (
    <section aria-label="Lembretes" className="space-y-xl">
      <div className="space-y-xs">
        <h2 className="font-heading text-section">Lembretes de contato por atendente</h2>
        <p className="font-body text-caption text-neutral-600">
          Conta para a responsável pela proposta, não para quem resolveu. &quot;Vencidos agora&quot; é a
          situação de hoje ({formatIsoDay(report.today)}), qualquer que seja o período; os desfechos são
          os resolvidos de {formatIsoDay(report.period.startDate)} a {formatIsoDay(report.period.endDate)}.
        </p>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.key}
        minWidth={840}
        emptyMessage="Nenhum lembrete no período"
      />
    </section>
  );
}
