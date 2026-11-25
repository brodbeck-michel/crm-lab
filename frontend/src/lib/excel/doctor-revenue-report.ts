import {
  LIS_DOCTOR_NO_DOCTOR_KEY,
  type LisDoctorRevenueRow,
  type LisDoctorRevenueTotals,
} from '@crm-lab/shared';

/**
 * Excel "Faturamento por médico solicitante" (PAGES.md §14, CRMLAB-199) — gerado no CLIENTE com
 * `xlsx`, como o de comissão (D-123): sem segundo fetch, as MESMAS linhas que a tela mostra, na
 * ordem da tela (filtros de período, convênio e representante já aplicados).
 */

export const DOCTOR_REVENUE_EXCEL_HEADER = [
  'Médico',
  'Conselho',
  'CRM',
  'UF',
  'Representante',
  'Requisições',
  'Em requisição',
  'Recebido',
  '% do recebido',
] as const;

type Cell = string | number | null;

function doctorName(row: LisDoctorRevenueRow): string {
  if (row.doctorKey === null) return 'Sem médico informado';
  if (row.doctorKey === LIS_DOCTOR_NO_DOCTOR_KEY)
    return 'Sem médico (CRM 1: sem pedido médico ou enfermagem)';
  return row.doctorName ?? '—';
}

/** Linhas da planilha (cabeçalho, uma por médico e TOTAL). Função pura — testada sem o `xlsx`. */
export function buildDoctorRevenueSheet(
  rows: LisDoctorRevenueRow[],
  totals: LisDoctorRevenueTotals,
): Cell[][] {
  const share = (value: number): number | null =>
    totals.paidValue > 0 ? Number(((value / totals.paidValue) * 100).toFixed(1)) : null;
  const body: Cell[][] = rows.map((row) => [
    doctorName(row),
    row.identified ? row.council : null,
    row.identified ? row.crm : null,
    row.identified ? row.uf : null,
    row.responsibleName,
    row.requisitionCount,
    row.requisitionValue,
    row.paidValue,
    share(row.paidValue),
  ]);
  const totalRow: Cell[] = [
    'TOTAL',
    null,
    null,
    null,
    null,
    totals.requisitionCount,
    totals.requisitionValue,
    totals.paidValue,
    totals.paidValue > 0 ? 100 : null,
  ];
  return [[...DOCTOR_REVENUE_EXCEL_HEADER], ...body, totalRow];
}

export async function generateDoctorRevenueExcel(
  rows: LisDoctorRevenueRow[],
  totals: LisDoctorRevenueTotals,
  period: { startDate: string; endDate: string },
): Promise<void> {
  const XLSX = await import('xlsx');
  const sheet = XLSX.utils.aoa_to_sheet(buildDoctorRevenueSheet(rows, totals));
  // Larguras para abrir legível (mesmo cuidado do Excel de comissão).
  sheet['!cols'] = [
    { wch: 40 },
    { wch: 10 },
    { wch: 12 },
    { wch: 6 },
    { wch: 22 },
    ...[0, 1, 2, 3].map(() => ({ wch: 16 })),
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Médicos');
  XLSX.writeFile(workbook, `faturamento-medicos-${period.startDate}-${period.endDate}.xlsx`);
}
