import type { CommissionDetailRow, CommissionDetailTotals } from '@/lib/lis/commission-detail';

function formatBRL(value: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

function formatPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

/**
 * PDF "Relatório de comissão" — gerado no CLIENTE (D-123, mesmo princípio de
 * D-116) a partir da MESMA tabela "Detalhe por atendente" já montada em
 * `/results` (PAGES.md §14) — nunca um segundo fetch.
 */
export async function generateCommissionReportPdf(
  rows: CommissionDetailRow[],
  totals: CommissionDetailTotals,
  brandName: string,
  period: { startDate: string; endDate: string },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;

  const doc = new jsPDF({ orientation: 'landscape' });

  doc.setFontSize(16);
  doc.text(`Relatório de Comissão — ${brandName}`, 14, 18);
  doc.setFontSize(10);
  doc.text(`Período: ${period.startDate} a ${period.endDate}`, 14, 25);

  const head = [
    [
      'Atendente',
      'Orç.',
      'Recebido',
      'Conv. %',
      'Com. Orç.',
      'Vendas Exames',
      'Com. Exames',
      'Vendas Check-up',
      'Com. Check-up',
      'Comissão Total',
    ],
  ];

  const body = rows.map((row) => [
    row.attendantName,
    String(row.issuedCount),
    formatBRL(row.paidValue),
    formatPct(row.conversionQty),
    formatBRL(row.budgetCommission),
    formatBRL(row.examsValue),
    formatBRL(row.examsCommission),
    formatBRL(row.checkupValue),
    formatBRL(row.checkupCommission),
    formatBRL(row.totalCommission),
  ]);

  body.push([
    'TOTAL',
    String(totals.issuedCount),
    formatBRL(totals.paidValue),
    '—',
    formatBRL(totals.budgetCommission),
    formatBRL(totals.examsValue),
    formatBRL(totals.examsCommission),
    formatBRL(totals.checkupValue),
    formatBRL(totals.checkupCommission),
    formatBRL(totals.totalCommission),
  ]);

  autoTable(doc, { startY: 32, head, body });

  doc.save(`comissoes-${period.startDate}-${period.endDate}.pdf`);
}
