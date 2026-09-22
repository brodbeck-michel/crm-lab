import type jsPDF from 'jspdf';
import type { Theme } from '@crm-lab/shared';

/**
 * Primitivos de marca dos PDFs do LIS — cabeçalho, rodapé, título de seção,
 * cartões de indicador e parágrafo.
 *
 * Existem separados do relatório porque os três PDFs do produto (Executivo,
 * Comissão e Busca Ativa) devem sair com a MESMA identidade: quem recebe os
 * três por e-mail tem que reconhecer o laboratório nos três. Hoje só o
 * Executivo usa; os outros dois migram trocando as chamadas de `doc.text`
 * soltas por estas funções — nada aqui depende do relatório executivo.
 *
 * A cor NUNCA é fixa (D-116): vem do `accent` do tema do tenant. Um verde
 * "Santé" hardcoded faria todo laboratório receber PDF com a cor de outro.
 */

export type Rgb = [number, number, number];

export interface BrandPalette {
  /** `accent` do tenant — faixas, títulos de seção, cabeçalho de tabela. */
  main: Rgb;
  /** `accent` escurecido — valores em destaque sobre fundo claro. */
  deep: Rgb;
  /** `accent` sobre branco — fundo dos cartões e linhas alternadas. */
  softBg: Rgb;
  /** `accent` sobre branco, um passo mais forte — borda dos cartões. */
  border: Rgb;
}

/** Fallback quando o tenant ainda não personalizou (mesmo azul do tema base). */
const DEFAULT_ACCENT: Rgb = [37, 99, 175];

const MUTED: Rgb = [110, 110, 110];
const BODY: Rgb = [55, 65, 81];

export const PAGE_MARGIN = 40;

const DECIMAL_1 = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** `40.9` → `40,9%`. `toFixed` devolveria `40.9%`, com ponto, fora do pt-BR. */
export function pctText(value: number): string {
  return `${DECIMAL_1.format(Number.isFinite(value) ? value : 0)}%`;
}

export function hexToRgb(hex: string | null | undefined): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim());
  if (!m) return null;
  const n = parseInt(m[1] as string, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mistura `color` com branco. `amount` 0 = branco puro, 1 = cor pura. */
function tint(color: Rgb, amount: number): Rgb {
  return color.map((c) => Math.round(255 - (255 - c) * amount)) as Rgb;
}

/** Escurece `color` em direção ao preto. `amount` 1 = cor pura, 0 = preto. */
function shade(color: Rgb, amount: number): Rgb {
  return color.map((c) => Math.round(c * amount)) as Rgb;
}

export function buildPalette(theme?: Pick<Theme, 'accent'> | null): BrandPalette {
  const main = hexToRgb(theme?.accent) ?? DEFAULT_ACCENT;
  return {
    main,
    deep: shade(main, 0.72),
    softBg: tint(main, 0.09),
    border: tint(main, 0.24),
  };
}

/**
 * Baixa o logo do tenant e devolve data URL + formato, prontos para
 * `doc.addImage`. Falha em silêncio: um PDF sem logo é melhor que nenhum PDF,
 * e `logoUrl` pode apontar para um host que o navegador recusa por CORS.
 */
export async function loadLogo(
  logoUrl: string | null,
): Promise<{ dataUrl: string; format: 'PNG' | 'JPEG' } | null> {
  if (!logoUrl) return null;
  try {
    const res = await fetch(logoUrl);
    if (!res.ok) return null;
    const blob = await res.blob();
    const format = blob.type.includes('jpeg') || blob.type.includes('jpg') ? 'JPEG' : 'PNG';
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('logo'));
      reader.readAsDataURL(blob);
    });
    return { dataUrl, format };
  } catch {
    return null;
  }
}

export interface HeaderOptions {
  logo: { dataUrl: string; format: 'PNG' | 'JPEG' } | null;
  title: string;
  /** Linha de contexto sob o título — marca e período. */
  subtitle: string;
  /** Canto superior direito, abaixo do "Gerado em" — ex. "Página 1 — Resumo". */
  pageLabel: string;
}

export function drawHeader(doc: jsPDF, palette: BrandPalette, opts: HeaderOptions): void {
  const pageW = doc.internal.pageSize.getWidth();
  const textLeft = opts.logo ? 110 : PAGE_MARGIN;

  if (opts.logo) {
    try {
      doc.addImage(opts.logo.dataUrl, opts.logo.format, PAGE_MARGIN, 28, 60, 28);
    } catch {
      /* logo corrompido não derruba o relatório */
    }
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(...palette.main);
  doc.text(opts.title, textLeft, 44);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text(opts.subtitle, textLeft, 58);

  const now = new Date();
  doc.text(
    `Gerado em ${now.toLocaleDateString('pt-BR')} ${now.toLocaleTimeString('pt-BR')}`,
    pageW - PAGE_MARGIN,
    44,
    { align: 'right' },
  );
  doc.text(opts.pageLabel, pageW - PAGE_MARGIN, 58, { align: 'right' });

  doc.setDrawColor(...palette.main);
  doc.setLineWidth(1.2);
  doc.line(PAGE_MARGIN, 70, pageW - PAGE_MARGIN, 70);
  doc.setLineWidth(0.2);
}

/** Rodapé de TODAS as páginas — chamar depois de fechar o conteúdo. */
export function drawFooters(doc: jsPDF, brandName: string): void {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const total = doc.getNumberOfPages();

  for (let page = 1; page <= total; page += 1) {
    doc.setPage(page);
    doc.setDrawColor(220);
    doc.setLineWidth(0.2);
    doc.line(PAGE_MARGIN, pageH - 36, pageW - PAGE_MARGIN, pageH - 36);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(brandName, PAGE_MARGIN, pageH - 22);
    doc.text(`Página ${page} de ${total}`, pageW - PAGE_MARGIN, pageH - 22, { align: 'right' });
  }
  doc.setTextColor(20);
}

/** Título de seção em caixa alta com sublinhado curto. Devolve o novo `y`. */
export function sectionTitle(doc: jsPDF, palette: BrandPalette, y: number, label: string): number {
  const text = label.toUpperCase();
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...palette.main);
  doc.text(text, PAGE_MARGIN, y);
  doc.setDrawColor(...palette.main);
  doc.setLineWidth(0.6);
  doc.line(PAGE_MARGIN, y + 4, PAGE_MARGIN + doc.getTextWidth(text) + 6, y + 4);
  doc.setLineWidth(0.2);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(20);
  return y + 16;
}

export interface KpiItem {
  label: string;
  value: string;
  /** Linha menor sob o valor. */
  sub?: string;
}

/** Grade de cartões claros. `tall` abre espaço para a linha `sub`. */
export function kpiGrid(
  doc: jsPDF,
  palette: BrandPalette,
  y: number,
  items: KpiItem[],
  cols: number,
  tall = false,
): number {
  if (!items.length) return y;
  const pageW = doc.internal.pageSize.getWidth();
  const gap = 10;
  const boxW = (pageW - PAGE_MARGIN * 2 - gap * (cols - 1)) / cols;
  const boxH = tall ? 70 : 48;

  items.forEach((item, i) => {
    const x = PAGE_MARGIN + (i % cols) * (boxW + gap);
    const yy = y + Math.floor(i / cols) * (boxH + gap);

    doc.setFillColor(...palette.softBg);
    doc.setDrawColor(...palette.border);
    doc.roundedRect(x, yy, boxW, boxH, 5, 5, 'FD');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...palette.main);
    doc.text(fit(doc, item.label.toUpperCase(), boxW - 20), x + 10, yy + 14);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(tall ? 11 : 13);
    doc.setTextColor(...palette.deep);
    doc.text(fit(doc, item.value, boxW - 20), x + 10, yy + (tall ? 36 : 34));

    if (item.sub) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(...BODY);
      doc.text(fit(doc, item.sub, boxW - 20), x + 10, yy + (tall ? 54 : 44));
    }
  });

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(20);
  return y + Math.ceil(items.length / cols) * (boxH + gap);
}

export interface Variation {
  current: number;
  previous: number;
  /** `rel` = variação percentual relativa; `pp` = diferença em pontos percentuais. */
  unit: 'rel' | 'pp';
}

/** Texto da variação, ou `null` quando não há base de comparação. */
export function variationText(v: Variation): string | null {
  if (!Number.isFinite(v.previous) || v.previous === 0) return null;
  const delta = v.current - v.previous;
  const sign = delta > 0.0001 ? '+' : delta < -0.0001 ? '-' : '';
  return v.unit === 'pp'
    ? `${sign}${DECIMAL_1.format(Math.abs(delta))} p.p. vs. anterior`
    : `${sign}${pctText(Math.abs((delta / Math.abs(v.previous)) * 100))} vs. anterior`;
}

/**
 * Seta da variação desenhada como triângulo vetorial, não como caractere:
 * "▲" não existe na Helvetica embutida do jsPDF e sairia como caixa vazia.
 */
function drawArrow(doc: jsPDF, x: number, baselineY: number, delta: number, color: Rgb): void {
  const size = 5;
  const top = baselineY - 8;
  doc.setFillColor(...color);
  if (delta > 0.0001) doc.triangle(x, top + size, x + size, top + size, x + size / 2, top, 'F');
  else if (delta < -0.0001) doc.triangle(x, top, x + size, top, x + size / 2, top + size, 'F');
  else doc.rect(x, top + 1, size, size - 1, 'F');
}

export interface HeroItem {
  label: string;
  value: string;
  sub?: string;
  variation?: Variation;
}

/** Cartões grandes na cor da marca — o resultado do período, topo da página 1. */
export function kpiHero(doc: jsPDF, palette: BrandPalette, y: number, items: HeroItem[]): number {
  if (!items.length) return y;
  const pageW = doc.internal.pageSize.getWidth();
  const gap = 10;
  const boxW = (pageW - PAGE_MARGIN * 2 - gap * (items.length - 1)) / items.length;
  const boxH = 80;

  items.forEach((item, i) => {
    const x = PAGE_MARGIN + i * (boxW + gap);
    doc.setFillColor(...palette.main);
    doc.roundedRect(x, y, boxW, boxH, 6, 6, 'F');

    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text(fit(doc, item.label.toUpperCase(), boxW - 24), x + 12, y + 18);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(17);
    doc.text(fit(doc, item.value, boxW - 24), x + 12, y + 46);

    const text = item.variation ? variationText(item.variation) : null;
    if (text && item.variation) {
      const delta = item.variation.current - item.variation.previous;
      drawArrow(doc, x + 12, y + 66, delta, [255, 255, 255]);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.text(fit(doc, text, boxW - 46), x + 29, y + 66);
    } else {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8.5);
      doc.text(fit(doc, item.sub ?? 'sem período anterior comparável', boxW - 24), x + 12, y + 66);
    }
  });

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(20);
  return y + boxH + 10;
}

export type AlertTone = 'risk' | 'warn' | 'good' | 'info';

const TONE: Record<AlertTone, { color: Rgb; label: string }> = {
  risk: { color: [185, 28, 28], label: 'RISCO ALTO' },
  warn: { color: [217, 119, 6], label: 'ATENÇÃO' },
  good: { color: [22, 128, 72], label: 'OPORTUNIDADE' },
  info: { color: [37, 99, 175], label: 'INFORMAÇÃO' },
};

export interface AlertCard {
  tone: AlertTone;
  title: string;
  body: string;
}

/** Cartões de alerta em duas colunas, com faixa lateral colorida por severidade. */
export function alertCards(doc: jsPDF, palette: BrandPalette, y: number, alerts: AlertCard[]): number {
  if (!alerts.length) return y;
  const pageW = doc.internal.pageSize.getWidth();
  const cols = 2;
  const gap = 12;
  const boxW = (pageW - PAGE_MARGIN * 2 - gap) / cols;
  const boxH = 72;

  alerts.forEach((alert, i) => {
    const x = PAGE_MARGIN + (i % cols) * (boxW + gap);
    const yy = y + Math.floor(i / cols) * (boxH + gap);
    const { color, label } = TONE[alert.tone];

    doc.setFillColor(...color);
    doc.roundedRect(x, yy, 5, boxH, 2, 2, 'F');
    doc.setFillColor(249, 250, 251);
    doc.setDrawColor(...palette.border);
    doc.roundedRect(x + 5, yy, boxW - 5, boxH, 3, 3, 'FD');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...color);
    doc.text(label, x + 14, yy + 16);

    doc.setFontSize(10);
    doc.setTextColor(...palette.deep);
    doc.text(fit(doc, alert.title, boxW - 24), x + 14, yy + 32);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...BODY);
    doc.text((doc.splitTextToSize(alert.body, boxW - 24) as string[]).slice(0, 3), x + 14, yy + 46);
  });

  doc.setTextColor(20);
  return y + Math.ceil(alerts.length / cols) * (boxH + gap);
}

/** Parágrafo corrido na largura útil da página. Devolve o novo `y`. */
export function paragraph(doc: jsPDF, y: number, text: string, size = 9.5): number {
  const pageW = doc.internal.pageSize.getWidth();
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(size);
  doc.setTextColor(...BODY);
  const lines = doc.splitTextToSize(text, pageW - PAGE_MARGIN * 2) as string[];
  doc.text(lines, PAGE_MARGIN, y);
  doc.setTextColor(20);
  return y + lines.length * (size + 2.5);
}

/** Parágrafo dentro de uma caixa destacada — o fecho de cada relatório. */
export function calloutParagraph(
  doc: jsPDF,
  palette: BrandPalette,
  y: number,
  heading: string,
  text: string,
): number {
  const pageW = doc.internal.pageSize.getWidth();
  const innerW = pageW - PAGE_MARGIN * 2 - 36;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  const lines = doc.splitTextToSize(text, innerW) as string[];
  const boxH = lines.length * 12 + 56;

  doc.setFillColor(...palette.softBg);
  doc.setDrawColor(...palette.main);
  doc.setLineWidth(1.2);
  doc.roundedRect(PAGE_MARGIN, y, pageW - PAGE_MARGIN * 2, boxH, 6, 6, 'FD');
  doc.setLineWidth(0.2);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...palette.deep);
  doc.text(heading, PAGE_MARGIN + 18, y + 26);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...BODY);
  doc.text(lines, PAGE_MARGIN + 18, y + 44);
  doc.setTextColor(20);

  return y + boxH + 10;
}

/** Estilos de `jspdf-autotable` na cor da marca — uma tabela igual em todo PDF. */
export function tableTheme(palette: BrandPalette, fontSize = 8) {
  return {
    styles: { fontSize, cellPadding: 3, textColor: 20 as const },
    headStyles: {
      fillColor: palette.main,
      textColor: 255 as const,
      fontStyle: 'bold' as const,
      fontSize,
    },
    alternateRowStyles: { fillColor: palette.softBg },
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN },
  };
}

/**
 * Opções de `autoTable` para uma tabela que pode transbordar de página.
 *
 * `autoTable` quebra a página sozinho e desenha SÓ a tabela: a página 2 nascia
 * sem cabeçalho nenhum, e uma folha solta de uma lista impressa não diz de que
 * laboratório nem de que recorte ela é. `margin.top` reserva a faixa do
 * cabeçalho para o corpo não subir por baixo dele.
 *
 * Espalhar DEPOIS de `tableTheme`, que também define `margin`.
 */
export function tableContinuation(doc: jsPDF, palette: BrandPalette, opts: HeaderOptions) {
  return {
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN, top: 90 },
    didDrawPage: (data: { pageNumber: number }) => {
      // A primeira página já teve o cabeçalho desenhado pelo chamador.
      if (data.pageNumber > 1) drawHeader(doc, palette, opts);
    },
  };
}

/** `y` logo abaixo da última tabela desenhada por `autoTable`. */
export function afterTable(doc: jsPDF, fallback: number): number {
  const last = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable;
  return (last?.finalY ?? fallback) + 16;
}

/**
 * Trunca com reticências no limite de largura. Cartão tem largura fixa: sem
 * isso, um convênio de nome longo escreveria por cima do cartão vizinho.
 */
function fit(doc: jsPDF, text: string, maxWidth: number): string {
  if (doc.getTextWidth(text) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && doc.getTextWidth(`${out}…`) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}
