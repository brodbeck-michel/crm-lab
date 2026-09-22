import type jsPDF from 'jspdf';
import type {
  CommissionSettings,
  ExecutiveReport,
  LisBudgetsSummary,
  PendingLisBudgetsSummary,
  Theme,
} from '@crm-lab/shared';
import type { CommissionDetailRow, CommissionDetailTotals } from '@/lib/lis/commission-detail';
import { formatIsoDay } from '@/lib/format';
import type { AlertCard, BrandPalette, HeroItem, KpiItem } from './brand';
import {
  PAGE_MARGIN,
  afterTable,
  alertCards,
  buildPalette,
  calloutParagraph,
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
 * PDF do Relatório Executivo — gerado no CLIENTE (D-116), a partir dos MESMOS
 * JSONs que já preencheram `/results` (nunca um segundo fetch). `jspdf` +
 * `jspdf-autotable` importados sob demanda (lazy) — só quando alguém clica
 * em "Exportar relatório executivo".
 *
 * Quatro páginas: resumo, equipe, convênios e fecho gerencial. Só `report` é
 * obrigatório; `previous`, `commission`, `pending` e `theme` são opcionais e
 * cada seção que depende deles some quando faltam, em vez de imprimir zero.
 * É o contrato que deixa a tela ligar as fontes uma a uma sem tocar aqui.
 */

/** Cabeçalho das páginas que nascem de transbordo — a numeração real fica no rodapé. */
const CONTINUATION = 'Continuação';

/** Espelha `MIN_ORC_RANKING` do backend (`lis-analytics.service.ts`). */
const MIN_RANKING_BUDGETS = 20;

/** A partir daqui a carteira é considerada dependente dos dois maiores convênios. */
const CONCENTRATION_HIGH = 70;
const CONCENTRATION_MODERATE = 50;

export interface ExecutiveReportPdfInput {
  report: ExecutiveReport;
  /** Tema do tenant — só `accent` é usado. Sem ele, o PDF sai na cor padrão. */
  theme?: Pick<Theme, 'accent'> | null;
  /**
   * Resumo do período EQUIVALENTE ANTERIOR, para as variações. A tela já o
   * busca para o `deltaPct` dos cartões; aqui ele vira as setas do topo e os
   * alertas de queda/crescimento.
   */
  previous?: LisBudgetsSummary | null;
  /**
   * Tabela "Detalhe por atendente" já montada em `/results` (D-122/D-123).
   * Traz TODOS os atendentes, sem o corte de top-6 de `report.byAttendant`,
   * e é a única fonte das comissões — o relatório executivo do servidor não
   * as calcula.
   */
  commission?: {
    rows: CommissionDetailRow[];
    totals: CommissionDetailTotals;
    settings: CommissionSettings;
  } | null;
  /**
   * Busca ativa. ATENÇÃO: `/lis-budgets/pending/summary` devolve o backlog
   * INTEIRO em aberto, não o recorte do período — por isso a seção é rotulada
   * como "carteira em aberto" e nunca comparada com a receita do período.
   * Quando o endpoint ganhar filtro de data, basta passar o recorte aqui.
   */
  pending?: PendingLisBudgetsSummary | null;
}

export async function generateExecutiveReportPdf(input: ExecutiveReportPdfInput): Promise<void> {
  const { report, previous, commission, pending } = input;
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const palette = buildPalette(input.theme);
  const logo = await loadLogo(report.logoUrl);
  const brand = report.brandName || 'Laboratório';
  const periodLabel = `${formatIsoDay(report.period.startDate)} a ${formatIsoDay(report.period.endDate)}`;

  const headerOpts = (pageLabel: string) => ({
    logo,
    title: 'Relatório Executivo Comercial',
    subtitle: `${brand} · Período: ${periodLabel}`,
    pageLabel,
  });
  const header = (pageLabel: string) => drawHeader(doc, palette, headerOpts(pageLabel));

  /** Abre página nova quando `needed` pontos não cabem antes do rodapé. */
  const space = (y: number, needed: number, pageLabel: string): number => {
    if (y + needed <= doc.internal.pageSize.getHeight() - 56) return y;
    doc.addPage();
    header(pageLabel);
    return 90;
  };

  const facts = deriveFacts(report, previous, commission, pending);

  // ── Página 1 — Resumo Executivo ────────────────────────────────────────
  header('Página 1 — Resumo Executivo');
  let y = 90;

  y = sectionTitle(doc, palette, y, 'Resultado Comercial do Período');
  y = kpiHero(doc, palette, y, heroItems(report, previous));

  y = sectionTitle(doc, palette, y, 'Indicadores Gerais');
  y = kpiGrid(doc, palette, y, generalKpis(report, facts), 3);

  if (commission) {
    y = sectionTitle(doc, palette, y, 'Detalhamento de Comissões');
    y = kpiGrid(doc, palette, y, commissionKpis(commission, facts), 4);
  }

  y = sectionTitle(doc, palette, y, 'Destaques do Período');
  y = kpiGrid(doc, palette, y, highlights(report, facts, pending), 4, true);

  y = sectionTitle(doc, palette, y, 'Parecer Executivo');
  paragraph(doc, y, opinionText(report, facts, brand));

  // ── Página 2 — Performance Comercial da Equipe ─────────────────────────
  doc.addPage();
  header('Página 2 — Performance Comercial da Equipe');
  y = 90;

  y = sectionTitle(doc, palette, y, 'Detalhamento por Atendente');
  if (commission && commission.rows.length) {
    const pct = commission.settings;
    autoTable(doc, {
      startY: y,
      head: [
        [
          'Atendente',
          'Orç.',
          'Recebido',
          'Conv.',
          `Com. Orç. (${rate(pct.commissionBudgetPct)}%)`,
          'Vd. Exames',
          `Com. Ex. (${rate(pct.commissionExamsPct)}%)`,
          'Vd. Check-up',
          `Com. Ck. (${rate(pct.commissionCheckupPct)}%)`,
          'Com. Total',
        ],
      ],
      body: commission.rows.map((row) => [
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
          String(commission.totals.issuedCount),
          brl(commission.totals.paidValue),
          '—',
          brl(commission.totals.budgetCommission),
          brl(commission.totals.examsValue),
          brl(commission.totals.examsCommission),
          brl(commission.totals.checkupValue),
          brl(commission.totals.checkupCommission),
          brl(commission.totals.totalCommission),
        ],
      ],
      ...tableTheme(palette, 7),
      ...tableContinuation(doc, palette, headerOpts(CONTINUATION)),
      footStyles: { fillColor: palette.softBg, textColor: palette.deep, fontStyle: 'bold' },
      columnStyles: { 0: { cellWidth: 'auto' }, 1: { halign: 'center' }, 3: { halign: 'center' } },
    });
  } else {
    // Sem as comissões da tela, resta o top-6 do relatório do servidor.
    autoTable(doc, {
      startY: y,
      head: [['Atendente', 'Orçamentos', 'Requisições pagas', 'Recebido']],
      body: report.byAttendant.map((row) => [
        row.attendantName,
        String(row.issuedCount),
        String(row.paidCount),
        brl(row.paidValue),
      ]),
      ...tableTheme(palette),
    });
  }
  y = afterTable(doc, y);

  y = space(y, 190, 'Página 2 — Performance Comercial da Equipe');
  y = sectionTitle(doc, palette, y, 'Indicadores da Equipe');
  y = kpiGrid(doc, palette, y, teamKpis(facts), 2);

  y = sectionTitle(doc, palette, y, 'Resumo Executivo da Equipe');
  paragraph(doc, y, teamText(facts));

  // ── Página 3 — Convênios e Dependência Comercial ───────────────────────
  doc.addPage();
  header('Página 3 — Convênios e Dependência Comercial');
  y = 90;

  y = sectionTitle(doc, palette, y, 'Performance por Convênio');
  if (report.byInsurance.length) {
    autoTable(doc, {
      startY: y,
      head: [['Convênio', 'Orçamentos', 'Orçado', 'Recebido', '% da receita']],
      body: report.byInsurance.map((row) => [
        row.insuranceName,
        String(row.count),
        brl(row.totalValue),
        brl(row.paidValue),
        pctText(share(row.paidValue, facts.insuranceRevenue)),
      ]),
      ...tableTheme(palette),
      columnStyles: { 1: { halign: 'center' }, 4: { halign: 'right' } },
    });
    y = afterTable(doc, y);

    y = sectionTitle(doc, palette, y, 'Análise de Concentração de Receita');
    y = concentrationCard(doc, palette, y, facts);
    y = paragraph(doc, y, concentrationAdvice(facts.top2Share)) + 8;

    y = space(y, 140, 'Página 3 — Convênios e Dependência Comercial');
    y = sectionTitle(doc, palette, y, 'Insight Executivo');
    paragraph(doc, y, insuranceInsight(report, facts));
  } else {
    // O servidor omite o recorte por convênio abaixo do volume mínimo.
    paragraph(
      doc,
      y,
      `O período não atingiu o volume mínimo de ${MIN_RANKING_BUDGETS} orçamentos emitidos exigido para o recorte por convênio, ou nenhum convênio registrou receita. Amplie o período para obter a análise de concentração.`,
    );
  }

  // ── Página 4 — Evolução, Busca Ativa e Conclusão ───────────────────────
  doc.addPage();
  header('Página 4 — Evolução, Busca Ativa e Conclusão');
  y = 90;

  y = sectionTitle(doc, palette, y, 'Evolução Mensal');
  autoTable(doc, {
    startY: y,
    head: [['Mês', 'Orçado', 'Em requisição', 'Recebido']],
    body: report.monthlySeries
      .slice(-12)
      .map((point) => [
        monthLabel(point.month),
        brl(point.issuedValue),
        brl(point.requisitionValue),
        brl(point.paidValue),
      ]),
    ...tableTheme(palette),
    columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } },
  });
  y = afterTable(doc, y);

  if (pending) {
    y = space(y, 150, CONTINUATION);
    y = sectionTitle(doc, palette, y, 'Busca Ativa — Carteira em Aberto');
    y = kpiGrid(
      doc,
      palette,
      y,
      [
        {
          label: 'Potencial de recuperação',
          value: brl(pending.total.value),
          sub: `${int(pending.total.count)} requisições em aberto`,
        },
        {
          label: 'Até 15 dias',
          value: brl(pending.byAgeBand['0-7'].value + pending.byAgeBand['8-15'].value),
          sub: `${pending.byAgeBand['0-7'].count + pending.byAgeBand['8-15'].count} requisições`,
        },
        {
          label: 'Acima de 30 dias',
          value: brl(pending.byAgeBand['30+'].value),
          sub: `${pending.byAgeBand['30+'].count} requisições — prioridade`,
        },
      ],
      3,
      true,
    );
    y = paragraph(
      doc,
      y,
      'Carteira total em aberto na data de emissão deste relatório, não recortada pelo período acima: são requisições sem pagamento de qualquer data, que seguem passíveis de conversão pela busca ativa.',
      8.5,
    );
    y += 8;
  }

  const alerts = buildAlerts(facts);
  y = space(y, 100 + Math.ceil(alerts.length / 2) * 84, CONTINUATION);
  y = sectionTitle(doc, palette, y, 'Alertas Estratégicos para a Diretoria');
  y = alertCards(doc, palette, y, alerts);

  y = space(y, 160, CONTINUATION);
  y = sectionTitle(doc, palette, y, 'Conclusão Gerencial');
  calloutParagraph(doc, palette, y, 'Encerramento Executivo do Período', conclusionText(report, facts));

  drawFooters(doc, `${brand} · Relatório Executivo Comercial`);
  doc.save(`relatorio-executivo-${report.period.startDate}-a-${report.period.endDate}.pdf`);
}

/* ── Números derivados ──────────────────────────────────────────────────── */

interface Facts {
  /** Receita somada dos convênios listados — base dos percentuais da página 3. */
  insuranceRevenue: number;
  /** Fatia dos dois maiores convênios sobre `insuranceRevenue`. */
  top2Share: number;
  topInsurance: { name: string; paidValue: number } | null;
  secondInsurance: { name: string; paidValue: number } | null;
  topAttendant: { name: string; paidValue: number } | null;
  /** Melhor conversão entre atendentes com volume mínimo. */
  bestConversion: { name: string; conversion: number } | null;
  bestTicket: { name: string; ticket: number } | null;
  bestCommission: { name: string; value: number } | null;
  attendantCount: number;
  rankedCount: number;
  commissionTotal: number;
  /** Comissão total sobre a receita recebida. */
  commissionShare: number;
  pendingValue: number;
  pendingCount: number;
  /** Variação da receita recebida vs. período anterior, em %. `null` sem base. */
  revenueDelta: number | null;
  /** Variação da conversão vs. período anterior, em p.p. `null` sem base. */
  conversionDelta: number | null;
  previousPaid: number | null;
  paidValue: number;
  conversion: number;
}

function deriveFacts(
  report: ExecutiveReport,
  previous: LisBudgetsSummary | null | undefined,
  commission: ExecutiveReportPdfInput['commission'],
  pending: PendingLisBudgetsSummary | null | undefined,
): Facts {
  const insurances = [...report.byInsurance].sort((a, b) => b.paidValue - a.paidValue);
  const insuranceRevenue = insurances.reduce((sum, row) => sum + row.paidValue, 0);
  const top2 = insurances.slice(0, 2).reduce((sum, row) => sum + row.paidValue, 0);

  const rows = commission?.rows ?? [];
  const ranked = rows.filter((row) => row.issuedCount >= MIN_RANKING_BUDGETS);
  const byPaid = [...rows].sort((a, b) => b.paidValue - a.paidValue);
  const topAttendantRow = byPaid[0];
  // Sem as linhas de comissão, o top-6 do servidor ainda dá o líder de receita.
  const fallbackTop = [...report.byAttendant].sort((a, b) => b.paidValue - a.paidValue)[0];

  const bestConversionRow = [...ranked].sort((a, b) => b.conversionQty - a.conversionQty)[0];
  const withPaid = ranked.filter((row) => row.paidCount > 0);
  const bestTicketRow = [...withPaid].sort(
    (a, b) => b.paidValue / b.paidCount - a.paidValue / a.paidCount,
  )[0];
  const bestCommissionRow = [...rows].sort((a, b) => b.totalCommission - a.totalCommission)[0];

  const previousPaid = previous ? previous.paid.totalValue : null;
  const commissionTotal = commission?.totals.totalCommission ?? 0;

  return {
    insuranceRevenue,
    top2Share: share(top2, insuranceRevenue),
    topInsurance: insurances[0]
      ? { name: insurances[0].insuranceName, paidValue: insurances[0].paidValue }
      : null,
    secondInsurance: insurances[1]
      ? { name: insurances[1].insuranceName, paidValue: insurances[1].paidValue }
      : null,
    topAttendant: topAttendantRow
      ? { name: topAttendantRow.attendantName, paidValue: topAttendantRow.paidValue }
      : fallbackTop
        ? { name: fallbackTop.attendantName, paidValue: fallbackTop.paidValue }
        : null,
    bestConversion: bestConversionRow
      ? { name: bestConversionRow.attendantName, conversion: bestConversionRow.conversionQty }
      : null,
    bestTicket: bestTicketRow
      ? { name: bestTicketRow.attendantName, ticket: bestTicketRow.paidValue / bestTicketRow.paidCount }
      : null,
    bestCommission: bestCommissionRow
      ? { name: bestCommissionRow.attendantName, value: bestCommissionRow.totalCommission }
      : null,
    attendantCount: rows.length,
    rankedCount: ranked.length,
    commissionTotal,
    commissionShare: share(commissionTotal, report.paid.totalValue),
    pendingValue: pending?.total.value ?? 0,
    pendingCount: pending?.total.count ?? 0,
    revenueDelta:
      previousPaid && previousPaid > 0
        ? ((report.paid.totalValue - previousPaid) / previousPaid) * 100
        : null,
    conversionDelta:
      previous && previous.paid.conversionQty > 0
        ? report.paid.conversionQty - previous.paid.conversionQty
        : null,
    previousPaid,
    paidValue: report.paid.totalValue,
    conversion: report.paid.conversionQty,
  };
}

/* ── Blocos da página 1 ─────────────────────────────────────────────────── */

function heroItems(report: ExecutiveReport, previous: LisBudgetsSummary | null | undefined): HeroItem[] {
  return [
    {
      label: 'Receita Recebida',
      value: brl(report.paid.totalValue),
      variation: previous
        ? { current: report.paid.totalValue, previous: previous.paid.totalValue, unit: 'rel' }
        : undefined,
    },
    {
      label: 'Total Orçado',
      value: brl(report.issued.totalValue),
      variation: previous
        ? { current: report.issued.totalValue, previous: previous.issued.totalValue, unit: 'rel' }
        : undefined,
    },
    {
      label: 'Taxa de Conversão',
      value: pctText(report.paid.conversionQty),
      variation: previous
        ? { current: report.paid.conversionQty, previous: previous.paid.conversionQty, unit: 'pp' }
        : undefined,
    },
  ];
}

function generalKpis(report: ExecutiveReport, facts: Facts): KpiItem[] {
  return [
    { label: 'Orçamentos emitidos', value: int(report.issued.count) },
    { label: 'Ticket médio orçado', value: brl(report.issued.averageTicket) },
    {
      label: 'Em requisição',
      value: brl(report.requisition.totalValue),
      sub: `${int(report.requisition.count)} requisições`,
    },
    { label: 'Requisições pagas', value: int(report.paid.count) },
    { label: 'Ticket médio recebido', value: brl(report.paid.averageTicket) },
    {
      label: 'Atendentes com produção',
      value: facts.attendantCount ? int(facts.attendantCount) : '—',
      sub: facts.attendantCount ? `${int(facts.rankedCount)} no ranking qualitativo` : undefined,
    },
  ];
}

function commissionKpis(
  commission: NonNullable<ExecutiveReportPdfInput['commission']>,
  facts: Facts,
): KpiItem[] {
  const { settings, totals } = commission;
  return [
    { label: `Orçamentos (${rate(settings.commissionBudgetPct)}%)`, value: brl(totals.budgetCommission) },
    { label: `Exames (${rate(settings.commissionExamsPct)}%)`, value: brl(totals.examsCommission) },
    { label: `Check-up (${rate(settings.commissionCheckupPct)}%)`, value: brl(totals.checkupCommission) },
    {
      label: 'Comissão total',
      value: brl(totals.totalCommission),
      sub: `${pctText(facts.commissionShare)} da receita`,
    },
  ];
}

function highlights(
  report: ExecutiveReport,
  facts: Facts,
  pending: PendingLisBudgetsSummary | null | undefined,
): KpiItem[] {
  return [
    {
      label: 'Melhor atendente',
      value: facts.topAttendant?.name ?? '—',
      sub: facts.topAttendant ? brl(facts.topAttendant.paidValue) : 'Sem dados no período',
    },
    {
      label: 'Melhor convênio',
      value: facts.topInsurance?.name ?? '—',
      sub: facts.topInsurance ? brl(facts.topInsurance.paidValue) : 'Sem dados no período',
    },
    {
      label: 'Melhor conversão',
      value: facts.bestConversion?.name ?? '—',
      sub: facts.bestConversion
        ? `${pctText(facts.bestConversion.conversion)} de conversão`
        : `Mínimo de ${MIN_RANKING_BUDGETS} orçamentos`,
    },
    pending
      ? {
          label: 'Carteira em aberto',
          value: brl(pending.total.value),
          sub: `${int(pending.total.count)} requisições pendentes`,
        }
      : {
          label: 'Em requisição',
          value: brl(report.requisition.totalValue),
          sub: `${int(report.requisition.count)} requisições no período`,
        },
  ];
}

function opinionText(report: ExecutiveReport, facts: Facts, brand: string): string {
  const parts = [
    `O período apresentou receita recebida de ${brl(report.paid.totalValue)} sobre ${int(report.issued.count)} orçamentos emitidos (${brl(report.issued.totalValue)}), com taxa de conversão de ${pctText(report.paid.conversionQty)} e ticket médio de ${brl(report.paid.averageTicket)}.`,
  ];

  if (facts.revenueDelta !== null && facts.previousPaid !== null) {
    const direction = facts.revenueDelta >= 0 ? 'avançou' : 'recuou';
    parts.push(
      `Frente ao período equivalente anterior, a receita ${direction} ${pctText(Math.abs(facts.revenueDelta))} (de ${brl(facts.previousPaid)} para ${brl(report.paid.totalValue)}).`,
    );
  }

  if (facts.topAttendant) {
    parts.push(
      `${facts.topAttendant.name} liderou o volume de receita da equipe, com ${brl(facts.topAttendant.paidValue)}.`,
    );
  }

  if (facts.topInsurance) {
    parts.push(
      `Os dois maiores convênios concentram ${pctText(facts.top2Share)} do faturamento recebido, com destaque para ${facts.topInsurance.name}.`,
    );
  }

  if (facts.commissionTotal > 0) {
    parts.push(
      `O custo comercial do período — comissões de orçamentos, exames e check-ups — totalizou ${brl(facts.commissionTotal)}, equivalente a ${pctText(facts.commissionShare)} da receita recebida.`,
    );
  }

  if (facts.pendingValue > 0) {
    parts.push(
      `A carteira em aberto soma ${brl(facts.pendingValue)} em ${int(facts.pendingCount)} requisições passíveis de recuperação pela busca ativa.`,
    );
  }

  parts.push(`Relatório emitido para a diretoria do ${brand}.`);
  return parts.join(' ');
}

/* ── Blocos da página 2 ─────────────────────────────────────────────────── */

function teamKpis(facts: Facts): KpiItem[] {
  return [
    {
      label: 'Maior faturamento',
      value: facts.topAttendant?.name ?? '—',
      sub: facts.topAttendant ? brl(facts.topAttendant.paidValue) : undefined,
    },
    {
      label: 'Melhor conversão',
      value: facts.bestConversion?.name ?? '—',
      sub: facts.bestConversion ? pctText(facts.bestConversion.conversion) : `Mínimo de ${MIN_RANKING_BUDGETS} orçamentos`,
    },
    {
      label: 'Maior ticket médio',
      value: facts.bestTicket?.name ?? '—',
      sub: facts.bestTicket ? brl(facts.bestTicket.ticket) : `Mínimo de ${MIN_RANKING_BUDGETS} orçamentos`,
    },
    {
      label: 'Maior comissão',
      value: facts.bestCommission?.name ?? '—',
      sub: facts.bestCommission ? brl(facts.bestCommission.value) : undefined,
    },
  ];
}

function teamText(facts: Facts): string {
  if (!facts.attendantCount) {
    return 'Não há atendentes com produção registrada no período selecionado.';
  }

  const parts = [
    `A equipe reúne ${int(facts.attendantCount)} atendente(s) com produção registrada no período, dos quais ${int(facts.rankedCount)} atingiram o volume mínimo de ${MIN_RANKING_BUDGETS} orçamentos exigido para os rankings qualitativos — conversão e ticket médio só comparam quem tem amostra suficiente.`,
  ];

  if (facts.topAttendant) {
    parts.push(`${facts.topAttendant.name} liderou em receita recebida (${brl(facts.topAttendant.paidValue)}).`);
  }
  if (facts.bestConversion) {
    parts.push(
      `${facts.bestConversion.name} obteve a melhor taxa de conversão (${pctText(facts.bestConversion.conversion)}).`,
    );
  }
  if (facts.bestTicket) {
    parts.push(`${facts.bestTicket.name} apresentou o ticket médio mais elevado (${brl(facts.bestTicket.ticket)}).`);
  }
  if (facts.commissionTotal > 0) {
    parts.push(
      `A massa de comissões somou ${brl(facts.commissionTotal)}, ou ${pctText(facts.commissionShare)} da receita recebida.`,
    );
  }

  return parts.join(' ');
}

/* ── Blocos da página 3 ─────────────────────────────────────────────────── */

function concentrationCard(
  doc: jsPDF,
  palette: BrandPalette,
  y: number,
  facts: Facts,
): number {
  const pageW = doc.internal.pageSize.getWidth();
  const cardH = 78;

  doc.setFillColor(...palette.main);
  doc.roundedRect(PAGE_MARGIN, y, pageW - PAGE_MARGIN * 2, cardH, 6, 6, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(28);
  doc.text(pctText(facts.top2Share), PAGE_MARGIN + 16, y + 46);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text('da receita concentrada nos 2 maiores convênios', PAGE_MARGIN + 16, y + 64);

  const badge =
    facts.top2Share > CONCENTRATION_HIGH
      ? { text: 'ALTA DEPENDÊNCIA COMERCIAL', color: [185, 28, 28] as const }
      : facts.top2Share >= CONCENTRATION_MODERATE
        ? { text: 'DEPENDÊNCIA MODERADA', color: [217, 119, 6] as const }
        : { text: 'BAIXA DEPENDÊNCIA', color: [22, 128, 72] as const };

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  const badgeW = doc.getTextWidth(badge.text) + 18;
  doc.setFillColor(badge.color[0], badge.color[1], badge.color[2]);
  doc.roundedRect(pageW - PAGE_MARGIN - 16 - badgeW, y + 22, badgeW, 22, 4, 4, 'F');
  doc.setTextColor(255, 255, 255);
  doc.text(badge.text, pageW - PAGE_MARGIN - 16 - badgeW + 9, y + 37);

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(20);
  return y + cardH + 10;
}

function concentrationAdvice(top2Share: number): string {
  if (top2Share > CONCENTRATION_HIGH) {
    return 'A carteira apresenta forte dependência dos principais convênios: uma renegociação desfavorável ou a perda de um deles atingiria a maior parte da receita. Recomenda-se ampliar a diversificação comercial e reduzir o risco de concentração.';
  }
  if (top2Share >= CONCENTRATION_MODERATE) {
    return 'Há dependência moderada dos principais convênios. Recomenda-se monitorar a evolução da participação e iniciar ações preventivas de diversificação.';
  }
  return 'A carteira apresenta boa distribuição de receita entre convênios, indicando baixo risco de concentração comercial.';
}

function insuranceInsight(report: ExecutiveReport, facts: Facts): string {
  if (!facts.topInsurance) return 'Não há convênios com receita registrada no período.';
  const level =
    facts.top2Share > CONCENTRATION_HIGH ? 'alta' : facts.top2Share >= CONCENTRATION_MODERATE ? 'moderada' : 'baixa';
  const second = facts.secondInsurance
    ? ` O segundo colocado, ${facts.secondInsurance.name}, responde por ${pctText(share(facts.secondInsurance.paidValue, facts.insuranceRevenue))}.`
    : '';
  return `Os dois principais convênios representam ${pctText(facts.top2Share)} da receita do período, o que caracteriza ${level} concentração comercial. O principal convênio foi ${facts.topInsurance.name}, responsável por ${pctText(share(facts.topInsurance.paidValue, facts.insuranceRevenue))} do faturamento recebido, sobre ${int(report.byInsurance.length)} convênio(s) com movimento no período.${second}`;
}

/* ── Blocos da página 4 ─────────────────────────────────────────────────── */

function buildAlerts(facts: Facts): AlertCard[] {
  const alerts: AlertCard[] = [];

  if (facts.insuranceRevenue > 0) {
    if (facts.top2Share > CONCENTRATION_HIGH) {
      alerts.push({
        tone: 'risk',
        title: 'Concentração de receita elevada',
        body: `${pctText(facts.top2Share)} do faturamento recebido vem dos 2 maiores convênios. Forte dependência comercial.`,
      });
    } else if (facts.top2Share >= CONCENTRATION_MODERATE) {
      alerts.push({
        tone: 'warn',
        title: 'Concentração moderada',
        body: `${pctText(facts.top2Share)} do faturamento recebido vem dos 2 maiores convênios.`,
      });
    }
  }

  if (facts.revenueDelta !== null && facts.previousPaid !== null) {
    if (facts.revenueDelta <= -10) {
      alerts.push({
        tone: 'risk',
        title: 'Queda de faturamento',
        body: `Receita recuou ${pctText(Math.abs(facts.revenueDelta))} frente ao período anterior (de ${brl(facts.previousPaid)} para ${brl(facts.paidValue)}).`,
      });
    } else if (facts.revenueDelta >= 10) {
      alerts.push({
        tone: 'good',
        title: 'Crescimento de faturamento',
        body: `Receita avançou ${pctText(facts.revenueDelta)} frente ao período anterior (de ${brl(facts.previousPaid)} para ${brl(facts.paidValue)}).`,
      });
    }
  }

  if (facts.conversionDelta !== null && facts.conversionDelta <= -5) {
    alerts.push({
      tone: 'warn',
      title: 'Queda de conversão',
      body: `A taxa caiu ${pctText(Math.abs(facts.conversionDelta)).replace('%', '')} p.p. em relação ao período anterior, chegando a ${pctText(facts.conversion)}.`,
    });
  }

  if (facts.pendingValue > 0) {
    alerts.push({
      tone: 'good',
      title: 'Potencial de recuperação',
      body: `${brl(facts.pendingValue)} em ${int(facts.pendingCount)} requisições em aberto na carteira, passíveis de conversão pela busca ativa.`,
    });
  }

  if (facts.commissionShare >= 5) {
    alerts.push({
      tone: 'warn',
      title: 'Custo comercial acima do usual',
      body: `As comissões consumiram ${pctText(facts.commissionShare)} da receita recebida (${brl(facts.commissionTotal)}).`,
    });
  }

  if (!alerts.length) {
    alerts.push({
      tone: 'info',
      title: 'Operação estável',
      body: 'Nenhum indicador crítico identificado no período analisado.',
    });
  }

  // Quatro cartões cabem em duas linhas; além disso a página vira ruído.
  return alerts.slice(0, 4);
}

function conclusionText(report: ExecutiveReport, facts: Facts): string {
  const parts = [
    `O resultado comercial do período totalizou ${brl(report.paid.totalValue)} recebidos, com taxa de conversão de ${pctText(report.paid.conversionQty)} sobre ${int(report.issued.count)} orçamentos emitidos.`,
  ];

  if (facts.insuranceRevenue > 0) {
    parts.push(
      `A carteira de convênios mantém ${pctText(facts.top2Share)} concentrados nos dois principais parceiros, o que reforça a importância da diversificação.`,
    );
  }
  if (facts.pendingValue > 0) {
    parts.push(
      `A busca ativa apresenta oportunidade direta de ${brl(facts.pendingValue)} em ${int(facts.pendingCount)} requisições pendentes de pagamento.`,
    );
  }

  parts.push(
    'Recomenda-se priorizar a conversão das pendências, monitorar a concentração por convênio e reforçar as ações de fechamento junto aos atendentes com menor taxa de conversão.',
  );
  return parts.join(' ');
}

/* ── Formatação ─────────────────────────────────────────────────────────── */

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const INT = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
/** Percentual de CONFIGURAÇÃO (`1.5` → `1,5`), não de cálculo — sem casa fixa. */
const RATE = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

function rate(value: number): string {
  return RATE.format(Number.isFinite(value) ? value : 0);
}

function brl(value: number): string {
  return BRL.format(Number.isFinite(value) ? value : 0);
}

function int(value: number): string {
  return INT.format(Number.isFinite(value) ? value : 0);
}

function share(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

/** `2026-09` → `set/2026`. */
function monthLabel(month: string): string {
  const [year, m] = month.split('-');
  const names = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const name = names[Number(m) - 1];
  return name ? `${name}/${year}` : month;
}
