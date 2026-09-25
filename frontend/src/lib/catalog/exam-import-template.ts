import { EXAM_IMPORT_COLUMNS, EXAM_IMPORT_TEMPLATE_EXAMPLE } from '@crm-lab/shared';

/** Nome do arquivo baixado pelo botão "Baixar modelo" (PAGES.md §7). */
export const EXAM_IMPORT_TEMPLATE_FILE_NAME = 'modelo-catalogo-exames.csv';

/** Aspas só quando o valor carrega separador, aspas ou quebra de linha (RFC 4180). */
function csvCell(value: string): string {
  return /[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Modelo do CSV de importação do catálogo (CRMLAB-23, D-178): BOM UTF-8 (o
 * Excel só abre os acentos certos com ele), separador `;` (padrão pt-BR),
 * cabeçalho canônico + uma linha de exemplo. As colunas vêm de
 * `@crm-lab/shared` — o mesmo lugar de onde o backend lê — então o modelo
 * nunca sai com um cabeçalho que o servidor recusaria.
 */
export function buildExamImportTemplate(): string {
  const header = EXAM_IMPORT_COLUMNS.join(';');
  const example = EXAM_IMPORT_COLUMNS.map((column) =>
    csvCell(EXAM_IMPORT_TEMPLATE_EXAMPLE[column]),
  ).join(';');
  return `\uFEFF${header}\r\n${example}\r\n`;
}

export function downloadExamImportTemplate(): void {
  if (typeof URL.createObjectURL !== 'function') return;
  const blob = new Blob([buildExamImportTemplate()], { type: 'text/csv;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = EXAM_IMPORT_TEMPLATE_FILE_NAME;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}
