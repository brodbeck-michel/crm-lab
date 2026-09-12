import type { CommissionDetailRow, CommissionDetailTotals } from '@/lib/lis/commission-detail';

/**
 * Excel "Relatório de comissão" — gerado no CLIENTE com `xlsx` (SheetJS,
 * D-123, mesmo princípio de D-116: nunca um segundo fetch, sempre a MESMA
 * tabela "Detalhe por atendente" já montada em `/results`, PAGES.md §14).
 */
export async function generateCommissionReportExcel(
  rows: CommissionDetailRow[],
  totals: CommissionDetailTotals,
  period: { startDate: string; endDate: string },
): Promise<void> {
  const XLSX = await import('xlsx');

  const header = [
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
  ];

  const body = rows.map((row) => [
    row.attendantName,
    row.issuedCount,
    row.paidValue,
    Number(row.conversionQty.toFixed(1)),
    row.budgetCommission,
    row.examsValue,
    row.examsCommission,
    row.checkupValue,
    row.checkupCommission,
    row.totalCommission,
  ]);

  const totalRow = [
    'TOTAL',
    totals.issuedCount,
    totals.paidValue,
    null,
    totals.budgetCommission,
    totals.examsValue,
    totals.examsCommission,
    totals.checkupValue,
    totals.checkupCommission,
    totals.totalCommission,
  ];

  const sheet = XLSX.utils.aoa_to_sheet([header, ...body, totalRow]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Comissões');
  XLSX.writeFile(workbook, `comissoes-${period.startDate}-${period.endDate}.xlsx`);
}
