import type { ExecutiveReport } from '@crm-lab/shared';
import { formatIsoDay } from '@/lib/format';

/**
 * PDF do Relatório Executivo — gerado no CLIENTE (D-116), a partir do MESMO
 * JSON que já preencheu `/results` (nunca um segundo fetch). `jspdf` +
 * `jspdf-autotable` importados sob demanda (lazy) — só quando alguém clica
 * em "Exportar PDF".
 */
export async function generateExecutiveReportPdf(report: ExecutiveReport): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;

  const doc = new jsPDF();
  const brand = report.brandName || 'Laboratório';

  doc.setFontSize(16);
  doc.text(`Relatório Executivo — ${brand}`, 14, 18);
  doc.setFontSize(10);
  doc.text(
    `Período: ${formatIsoDay(report.period.startDate)} a ${formatIsoDay(report.period.endDate)}`,
    14,
    25,
  );

  autoTable(doc, {
    startY: 32,
    head: [['Indicador', 'Valor']],
    body: [
      ['Total Orçado', formatBRL(report.issued.totalValue)],
      ['Total em Requisição', formatBRL(report.requisition.totalValue)],
      ['Total Recebido', formatBRL(report.paid.totalValue)],
      ['Taxa de Conversão', `${report.paid.conversionQty.toFixed(1)}%`],
      ['Ticket Médio', formatBRL(report.paid.averageTicket)],
    ],
  });

  const afterFirstTable = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
    .finalY;

  autoTable(doc, {
    startY: afterFirstTable + 10,
    head: [['Mês', 'Emitido', 'Pago']],
    body: report.monthlySeries.map((point) => [
      point.month,
      formatBRL(point.issuedValue),
      formatBRL(point.paidValue),
    ]),
  });

  const afterSeriesTable = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
    .finalY;

  autoTable(doc, {
    startY: afterSeriesTable + 10,
    head: [['Atendente', 'Emitidos', 'Pago (R$)']],
    body: report.byAttendant.map((row) => [
      row.attendantName,
      String(row.issuedCount),
      formatBRL(row.paidValue),
    ]),
  });

  const afterAttendantTable = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
    .finalY;

  autoTable(doc, {
    startY: afterAttendantTable + 10,
    head: [['Convênio', 'Contagem', 'Valor (R$)']],
    body: report.byInsurance.map((row) => [row.insuranceName, String(row.count), formatBRL(row.totalValue)]),
  });

  doc.save(`relatorio-executivo-${report.period.startDate}-a-${report.period.endDate}.pdf`);
}

function formatBRL(value: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}
