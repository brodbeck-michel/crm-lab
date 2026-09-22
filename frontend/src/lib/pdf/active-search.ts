import type {
  LisBudgetAgeBand,
  PendingLisBudget,
  PendingLisBudgetsSummary,
  Theme,
} from '@crm-lab/shared';
import { LIS_BUDGET_AGE_BANDS } from '@crm-lab/shared';
import { formatIsoDay } from '@/lib/format';
import {
  buildPalette,
  drawFooters,
  drawHeader,
  kpiGrid,
  kpiHero,
  loadLogo,
  paragraph,
  pctText,
  sectionTitle,
  tableContinuation,
  tableTheme,
} from './brand';

/**
 * PDF de Busca Ativa — gerado no CLIENTE (D-116), a partir do MESMO JSON que
 * já preencheu `/active-search` (resumo + fila), nunca de um segundo fetch.
 *
 * Paisagem, ao contrário dos outros dois: são 6 colunas de texto livre (nome
 * de paciente, convênio e atendente competindo pela mesma linha) e é a lista
 * que a equipe imprime para trabalhar em cima. Em retrato os nomes truncavam.
 * A identidade continua a mesma — os primitivos de `brand.ts` se viram na
 * largura que receberem.
 */
export interface ActiveSearchPdfInput {
  summary: PendingLisBudgetsSummary;
  budgets: PendingLisBudget[];
  brandName: string;
  theme?: Pick<Theme, 'accent' | 'logoUrl'> | null;
  /** Filtros ligados na tela, para o PDF não mentir sobre o próprio recorte. */
  filters?: { attendantName?: string | null; ageBand?: LisBudgetAgeBand | null };
}

const BAND_LABEL: Record<LisBudgetAgeBand, string> = {
  '0-7': 'Até 7 dias',
  '8-15': '8 a 15 dias',
  '16-30': '16 a 30 dias',
  '30+': 'Mais de 30 dias',
};

export async function generateActiveSearchPdf(input: ActiveSearchPdfInput): Promise<void> {
  const { summary, budgets, brandName, filters } = input;
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;

  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const palette = buildPalette(input.theme);
  const logo = await loadLogo(input.theme?.logoUrl ?? null);

  const header = {
    logo,
    title: 'Relatório de Busca Ativa',
    subtitle: `${brandName} · Requisições pendentes de pagamento`,
    pageLabel: `${int(budgets.length)} registro(s)`,
  };
  drawHeader(doc, palette, header);

  let y = 90;

  // O recorte da tela precisa estar impresso: uma lista filtrada por atendente
  // que não diz isso vira, na mão de quem recebe, "a carteira inteira".
  const applied: string[] = [];
  if (filters?.attendantName) applied.push(`Atendente: ${filters.attendantName}`);
  if (filters?.ageBand) applied.push(`Dias em aberto: ${BAND_LABEL[filters.ageBand]}`);
  y = paragraph(doc, y, `Filtros: ${applied.length ? applied.join('  ·  ') : 'nenhum'}`, 9);
  y += 6;

  const ticket = summary.total.count > 0 ? summary.total.value / summary.total.count : 0;
  y = sectionTitle(doc, palette, y, 'Potencial de Recuperação');
  y = kpiHero(doc, palette, y, [
    {
      label: 'Valor potencial de recuperação',
      value: brl(summary.total.value),
      sub: 'Receita que ainda pode ser convertida',
    },
    { label: 'Requisições pendentes', value: int(summary.total.count), sub: 'Aguardando pagamento' },
    { label: 'Ticket médio das pendências', value: brl(ticket), sub: 'Valor médio por requisição' },
  ]);

  y = sectionTitle(doc, palette, y, 'Distribuição por Tempo em Aberto');
  y = kpiGrid(
    doc,
    palette,
    y,
    LIS_BUDGET_AGE_BANDS.map((band) => ({
      label: BAND_LABEL[band],
      value: brl(summary.byAgeBand[band].value),
      sub: `${int(summary.byAgeBand[band].count)} req. · ${pctText(share(summary.byAgeBand[band].value, summary.total.value))} do total`,
    })),
    4,
    true,
  );

  y = sectionTitle(doc, palette, y, 'Fila de Trabalho');
  if (budgets.length) {
    autoTable(doc, {
      startY: y,
      head: [['Requisição', 'Emitido em', 'Paciente', 'Convênio', 'Atendente', 'Valor', 'Dias']],
      body: budgets.map((budget) => [
        budget.requisitionNumber ?? budget.number,
        budget.issuedOn ? formatIsoDay(budget.issuedOn) : '—',
        budget.patientName ?? '—',
        budget.principalInsuranceName ?? '—',
        budget.attendantName ?? '—',
        brl(budget.requisitionValue ?? budget.totalValue),
        String(budget.daysOpen),
      ]),
      ...tableTheme(palette, 8),
      ...tableContinuation(doc, palette, header),
      columnStyles: { 5: { halign: 'right' }, 6: { halign: 'center' } },
    });
  } else {
    paragraph(doc, y, 'Nenhuma requisição pendente no recorte selecionado.');
  }

  drawFooters(doc, `${brandName} · Busca Ativa`);
  doc.save(`busca-ativa-${new Date().toISOString().slice(0, 10)}.pdf`);
}

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const INT = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

function brl(value: number): string {
  return BRL.format(Number.isFinite(value) ? value : 0);
}

function int(value: number): string {
  return INT.format(Number.isFinite(value) ? value : 0);
}

function share(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}
