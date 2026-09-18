import { generateExecutiveReportPdf } from '@/lib/pdf/executive-report';
import { generateCommissionReportPdf } from '@/lib/pdf/commission-report';
import { generateCommissionReportExcel } from '@/lib/excel/commission-report';

const period = { startDate: '2026-09-01', endDate: '2026-09-30' };
const report = {
  brandName: 'Lab Teste', period,
  issued: { totalValue: 1800, count: 3 },
  requisition: { totalValue: 1500, count: 2 },
  paid: { totalValue: 1000, count: 1, conversionQty: 33.3, averageTicket: 1000 },
  monthlySeries: [{ month: '2026-08', issuedValue: 1800, paidValue: 1000 }],
  byAttendant: [{ attendantId: 'a1', attendantName: 'Carla', issuedCount: 3, paidValue: 1000 }],
  byInsurance: [{ insuranceId: 'i1', insuranceName: 'Unimed', count: 2, totalValue: 1500 }],
} as never;
const rows = [{
  attendantId: 'a1', attendantName: 'Carla', issuedCount: 3, paidCount: 1, paidValue: 1000,
  conversionQty: 33.3, examsValue: 200, examsCommission: 20, checkupValue: 100,
  checkupCommission: 10, budgetCommission: 20, totalCommission: 50,
}];
const totals = {
  issuedCount: 3, paidValue: 1000, examsValue: 200, examsCommission: 20, checkupValue: 100,
  checkupCommission: 10, budgetCommission: 20, totalCommission: 50,
};

(window as never as Record<string, unknown>).exec = {
  execPdf: () => generateExecutiveReportPdf(report),
  commPdf: () => generateCommissionReportPdf(rows, totals, 'Lab Teste', period),
  commXls: () => generateCommissionReportExcel(rows, totals, period),
  emptyXls: () => generateCommissionReportExcel([], totals, period),
};
