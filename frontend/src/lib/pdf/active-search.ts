import type { PendingLisBudget, PendingLisBudgetsSummary } from '@crm-lab/shared';
import { formatIsoDay } from '@/lib/format';

/**
 * PDF de Busca Ativa — gerado no CLIENTE (D-116), a partir do MESMO JSON que
 * já preencheu `/active-search` (resumo + fila). Lazy import de `jspdf`.
 */
export async function generateActiveSearchPdf(
  summary: PendingLisBudgetsSummary,
  budgets: PendingLisBudget[],
  brandName: string,
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;

  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text(`Busca Ativa — ${brandName}`, 14, 18);
  doc.setFontSize(10);
  doc.text(`Total em aberto: ${summary.total.count} · ${formatBRL(summary.total.value)}`, 14, 25);

  autoTable(doc, {
    startY: 32,
    head: [['Faixa', 'Contagem', 'Valor (R$)']],
    body: (['0-7', '8-15', '16-30', '30+'] as const).map((band) => [
      band,
      String(summary.byAgeBand[band].count),
      formatBRL(summary.byAgeBand[band].value),
    ]),
  });

  const afterSummaryTable = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
    .finalY;

  autoTable(doc, {
    startY: afterSummaryTable + 10,
    head: [['Número', 'Paciente', 'Convênio', 'Atendente', 'Emitido em', 'Dias em aberto']],
    body: budgets.map((budget) => [
      budget.number,
      budget.patientName ?? '—',
      budget.principalInsuranceName ?? '—',
      budget.attendantName ?? '—',
      budget.issuedOn ? formatIsoDay(budget.issuedOn) : '—',
      String(budget.daysOpen),
    ]),
  });

  doc.save(`busca-ativa-${new Date().toISOString().slice(0, 10)}.pdf`);
}

function formatBRL(value: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}
