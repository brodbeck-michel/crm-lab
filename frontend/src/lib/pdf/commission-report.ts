import type { CommissionSettings, Theme } from '@crm-lab/shared';
import type { CommissionDetailRow, CommissionDetailTotals } from '@/lib/lis/commission-detail';
import { formatIsoDay } from '@/lib/format';
import {
  buildPalette,
  drawFooters,
  drawHeader,
  kpiGrid,
  loadLogo,
  paragraph,
  pctText,
  sectionTitle,
  tableContinuation,
  tableTheme,
} from './brand';

/**
 * PDF "Relatório de Comissões por Atendente" — gerado no CLIENTE (D-123, mesmo
 * princípio de D-116) a partir da MESMA tabela "Detalhe por atendente" já
 * montada em `/results` (PAGES.md §14), nunca de um segundo fetch.
 *
 * Usa os primitivos de `brand.ts`, os mesmos do Relatório Executivo: quem
 * recebe os dois por e-mail tem que reconhecer o laboratório nos dois.
 *
 * Retrato, não paisagem. São 10 colunas, mas a página 2 do Executivo já provou
 * que elas cabem em A4 retrato a 7pt — e misturar orientação entre dois
 * relatórios que saem da mesma tela é desconforto sem contrapartida.
 */
export interface CommissionReportPdfInput {
  rows: CommissionDetailRow[];
  totals: CommissionDetailTotals;
  period: { startDate: string; endDate: string };
  brandName: string;
  /** Percentuais vigentes — vão no subtítulo, porque mudam o resultado. */
  settings: CommissionSettings;
  /** Tema do tenant: `accent` dá a cor e `logoUrl` o logo. */
  theme?: Pick<Theme, 'accent' | 'logoUrl'> | null;
}

export async function generateCommissionReportPdf(input: CommissionReportPdfInput): Promise<void> {
  const { rows, totals, period, brandName, settings } = input;
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const palette = buildPalette(input.theme);
  const logo = await loadLogo(input.theme?.logoUrl ?? null);
  const periodLabel = `${formatIsoDay(period.startDate)} a ${formatIsoDay(period.endDate)}`;

  const header = {
    logo,
    title: 'Relatório de Comissões por Atendente',
    subtitle: `${brandName} · Período: ${periodLabel}`,
    pageLabel: `${rows.length} atendente(s)`,
  };
  drawHeader(doc, palette, header);

  let y = 90;
  y = paragraph(
    doc,
    y,
    `Percentuais aplicados — Orçamentos: ${rate(settings.commissionBudgetPct)}%  ·  ` +
      `Exames: ${rate(settings.commissionExamsPct)}%  ·  ` +
      `Check-up: ${rate(settings.commissionCheckupPct)}%`,
    9,
  );
  y += 6;

  if (rows.length) {
    autoTable(doc, {
      startY: y,
      head: [
        [
          'Atendente',
          'Orç.',
          'Recebido',
          'Conv.',
          `Com. Orç. (${rate(settings.commissionBudgetPct)}%)`,
          'Vd. Exames',
          `Com. Ex. (${rate(settings.commissionExamsPct)}%)`,
          'Vd. Check-up',
          `Com. Ck. (${rate(settings.commissionCheckupPct)}%)`,
          'Comissão Total',
        ],
      ],
      body: rows.map((row) => [
        row.attendantName,
        String(row.issuedCount),
        brl(row.paidValue),
        pctText(row.conversionQty),
        brl(row.budgetCommission),
        brl(row.examsValue),
        brl(row.examsCommission),
        brl(row.checkupValue),
        brl(row.checkupCommission),
        brl(row.totalCommission),
      ]),
      foot: [
        [
          'TOTAL',
          String(totals.issuedCount),
          brl(totals.paidValue),
          '—',
          brl(totals.budgetCommission),
          brl(totals.examsValue),
          brl(totals.examsCommission),
          brl(totals.checkupValue),
          brl(totals.checkupCommission),
          brl(totals.totalCommission),
        ],
      ],
      ...tableTheme(palette, 7),
      ...tableContinuation(doc, palette, header),
      footStyles: { fillColor: palette.softBg, textColor: palette.deep, fontStyle: 'bold' },
      columnStyles: { 1: { halign: 'center' }, 3: { halign: 'center' } },
    });

    const last = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable;
    y = (last?.finalY ?? y) + 20;

    // O fecho repete o número que motivou o relatório. Quem só quer saber
    // "quanto deu no mês" não devia ter que somar a última linha da tabela.
    y = sectionTitle(doc, palette, y, 'Fecho do Período');
    kpiGrid(
      doc,
      palette,
      y,
      [
        { label: 'Comissão total', value: brl(totals.totalCommission) },
        {
          label: 'Receita recebida',
          value: brl(totals.paidValue),
          sub: `${pctText(share(totals.totalCommission, totals.paidValue))} em comissão`,
        },
        { label: 'Atendentes no período', value: String(rows.length) },
      ],
      3,
      true,
    );
  } else {
    paragraph(doc, y, 'Nenhum atendente com produção registrada no período selecionado.');
  }

  drawFooters(doc, `${brandName} · Relatório de Comissões`);
  doc.save(`comissoes-${period.startDate}-a-${period.endDate}.pdf`);
}

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
/** Percentual de CONFIGURAÇÃO (`1.5` → `1,5`), não de cálculo — sem casa fixa. */
const RATE = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

function brl(value: number): string {
  return BRL.format(Number.isFinite(value) ? value : 0);
}

function rate(value: number): string {
  return RATE.format(Number.isFinite(value) ? value : 0);
}

function share(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}
