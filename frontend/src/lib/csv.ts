/**
 * CSV para o Excel pt-BR (CRMLAB-193, D-333 item 11): separador `;`, BOM UTF-8
 * (acento certo ao abrir com dois cliques), decimal com vírgula e proteção
 * contra injeção de fórmula (célula iniciada por `= + - @` ganha `'`).
 * Gerado no navegador — o backend não exporta CSV.
 */
export type CsvCell = string | number | null | undefined;

/** Marca de ordem de bytes UTF-8 — escrita por código, nunca como caractere literal. */
const BOM = String.fromCharCode(0xfeff);

const FORMULA_START =/^[=+\-@\t\r]/;

function formatCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'number' ? String(value).replace('.', ',') : value;
  if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`;
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Linhas (a primeira é o cabeçalho) → texto CSV com BOM. */
export function toCsv(rows: readonly (readonly CsvCell[])[]): string {
  return BOM + rows.map((row) => row.map(formatCell).join(';')).join('\r\n');
}

/** Baixa o CSV como arquivo (`<a download>` temporário). */
export function downloadCsv(fileName: string, rows: readonly (readonly CsvCell[])[]): void {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
