import { describe, expect, it, vi } from 'vitest';
import { generateExecutiveReportPdf } from '@/lib/pdf/executive-report';
import { generateCommissionReportPdf } from '@/lib/pdf/commission-report';
import { generateCommissionReportExcel } from '@/lib/excel/commission-report';
import type { CommissionDetailRow, CommissionDetailTotals } from '@/lib/lis/commission-detail';

const period = { startDate: '2026-09-01', endDate: '2026-09-30' };

const report = {
  brandName: 'Lab Teste',
  period,
  issued: { totalValue: 1000, count: 10 },
  requisition: { totalValue: 800, count: 8 },
  paid: { totalValue: 500, count: 5, conversionQty: 50, averageTicket: 100 },
  monthlySeries: [{ month: '2026-09', issuedValue: 1000, paidValue: 500 }],
  byAttendant: [{ attendantId: 'a1', attendantName: 'Ana', issuedCount: 10, paidValue: 500 }],
  byInsurance: [{ insuranceId: 'i1', insuranceName: 'Unimed', count: 4, totalValue: 400 }],
} as never;

const rows: CommissionDetailRow[] = [
  {
    attendantId: 'a1', attendantName: 'Ana', issuedCount: 10, paidCount: 5, paidValue: 500,
    conversionQty: 50, examsValue: 200, examsCommission: 20, checkupValue: 100,
    checkupCommission: 10, budgetCommission: 25, totalCommission: 55,
  },
];
const totals: CommissionDetailTotals = {
  issuedCount: 10, paidValue: 500, examsValue: 200, examsCommission: 20, checkupValue: 100,
  checkupCommission: 10, budgetCommission: 25, totalCommission: 55,
};

const pdfSizes: number[] = [];
const excelSheets: unknown[][][] = [];

vi.mock('jspdf', async () => {
  const actual = await vi.importActual<typeof import('jspdf')>('jspdf');
  class CapturingPdf extends actual.jsPDF {
    constructor(...args: ConstructorParameters<typeof actual.jsPDF>) {
      super(...args);
      Object.defineProperty(this, 'save', {
        value: () => {
          pdfSizes.push((this.output('arraybuffer') as ArrayBuffer).byteLength);
          return this;
        },
      });
    }
  }
  return { ...actual, jsPDF: CapturingPdf, default: CapturingPdf };
});

vi.mock('xlsx', async () => {
  const actual = await vi.importActual<typeof import('xlsx')>('xlsx');
  return {
    ...actual,
    writeFile: (wb: import('xlsx').WorkBook) => {
      const sheet = wb.Sheets[wb.SheetNames[0]];
      excelSheets.push(actual.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][]);
    },
  };
});

async function pdfBytes(run: () => Promise<void>): Promise<number> {
  pdfSizes.length = 0;
  await run();
  return pdfSizes.at(-1) ?? 0;
}

async function excelRows(run: () => Promise<void>): Promise<unknown[][]> {
  excelSheets.length = 0;
  await run();
  return excelSheets.at(-1) ?? [];
}

describe('exportações da página de Resultados', () => {
  it('PDF executivo gera arquivo com dados', async () => {
    expect(await pdfBytes(() => generateExecutiveReportPdf(report))).toBeGreaterThan(1000);
  });

  it('PDF executivo gera arquivo com relatório vazio', async () => {
    const empty = { ...report, monthlySeries: [], byAttendant: [], byInsurance: [] } as never;
    expect(await pdfBytes(() => generateExecutiveReportPdf(empty))).toBeGreaterThan(1000);
  });

  it('PDF de comissão gera arquivo com dados e vazio', async () => {
    expect(await pdfBytes(() => generateCommissionReportPdf(rows, totals, 'Lab', period))).toBeGreaterThan(1000);
    expect(await pdfBytes(() => generateCommissionReportPdf([], totals, 'Lab', period))).toBeGreaterThan(1000);
  });

  it('Excel de comissão traz cabeçalho, linhas e TOTAL', async () => {
    const aoa = await excelRows(() => generateCommissionReportExcel(rows, totals, period));
    expect(aoa[0]).toEqual([
      'Atendente', 'Orç.', 'Recebido', 'Conv. %', 'Com. Orç.', 'Vendas Exames',
      'Com. Exames', 'Vendas Check-up', 'Com. Check-up', 'Comissão Total',
    ]);
    expect(aoa[1]?.[0]).toBe('Ana');
    expect(aoa[1]?.[9]).toBe(55);
    expect(aoa[2]?.[0]).toBe('TOTAL');
    expect(aoa[2]?.[9]).toBe(55);
  });

  it('Excel de comissão gera planilha sem linhas', async () => {
    const aoa = await excelRows(() => generateCommissionReportExcel([], totals, period));
    expect(aoa[1]?.[0]).toBe('TOTAL');
  });
});
