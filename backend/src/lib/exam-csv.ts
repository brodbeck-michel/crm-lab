/**
 * Parser puro do CSV de catalogo de exames (CRMLAB-23 — D-177/D-178,
 * API_CONTRACTS.md §4 "Importação do catálogo por CSV"). SEM I/O: recebe o
 * arquivo ja em memoria e devolve linhas tipadas + erros por linha. Quem fala
 * com banco/tenant e o `ExamCatalogService`.
 *
 * Responsabilidades:
 *  - UTF-8 estrito (com ou sem BOM) — nada de adivinhar Windows-1252
 *  - separador `;` ou `,` detectado no cabecalho (empate -> `;`, padrao pt-BR)
 *  - RFC 4180: aspas duplas, `""` escapado, quebra de linha dentro de aspas
 *  - cabecalho sem caixa/acento; coluna desconhecida ignorada
 *  - preco brasileiro (`1.234,56`) e com ponto (`1234.56`), sem adivinhar o
 *    ambiguo (`1.234` tem 3 casas -> erro)
 *  - codigo repetido DENTRO do arquivo = erro em todas as linhas que o repetem
 *
 * Erro do ARQUIVO inteiro -> `ExamCsvError` (vira `VALIDATION_ERROR` com
 * `details.reason`). Erro de LINHA -> entra em `errors`, as demais linhas
 * continuam sendo lidas para a pre-visualizacao mostrar tudo de uma vez.
 */
import {
  EXAM_IMPORT_COLUMNS,
  EXAM_IMPORT_MAX_ROWS,
  EXAM_IMPORT_REQUIRED_COLUMNS,
  type ExamImportColumn,
  type ExamImportInvalidReason,
  type ExamImportRowError,
} from '@crm-lab/shared';

export class ExamCsvError extends Error {
  constructor(
    readonly reason: Exclude<ExamImportInvalidReason, 'invalid_rows'>,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`CSV do catalogo invalido: ${reason}`);
    this.name = 'ExamCsvError';
  }
}

export interface ParsedExamRow {
  /** Linha da planilha (cabecalho = 1). */
  line: number;
  name: string;
  code: string;
  category: string | null;
  description: string | null;
  preparation: string | null;
  turnaroundHours: number | null;
  pricePrivate: number;
  priceInsurance: number;
}

export interface ExamCsvParseResult {
  /** Linhas de dado lidas (sem cabecalho e sem linhas em branco). */
  totalRows: number;
  /** So as linhas sem nenhum erro, na ordem do arquivo. */
  rows: ParsedExamRow[];
  /** Todos os erros, ordenados por linha e pela ordem das colunas. */
  errors: ExamImportRowError[];
  /** Quantas linhas tem pelo menos um erro. */
  errorCount: number;
}

/** NUMERIC(12,2). */
const MAX_PRICE = 9_999_999_999.99;
const MAX_TURNAROUND_HOURS = 100_000;

/** Apelidos de cabecalho, ja dobrados, alem do proprio nome canonico. */
const HEADER_ALIASES: Record<string, ExamImportColumn> = {
  prazo: 'prazo_horas',
};

/** Dobra de cabecalho: sem acento, minusculo, pontuacao/espaco -> `_`. */
export function foldHeader(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function resolveHeader(raw: string): ExamImportColumn | null {
  const folded = foldHeader(raw);
  if ((EXAM_IMPORT_COLUMNS as readonly string[]).includes(folded)) {
    return folded as ExamImportColumn;
  }
  return HEADER_ALIASES[folded] ?? null;
}

/** UTF-8 estrito. O `TextDecoder` ja descarta o BOM (`ignoreBOM: false`). */
export function decodeUtf8(buffer: Buffer): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return text.startsWith('\uFEFF') ? text.slice(1) : text;
  } catch {
    throw new ExamCsvError('invalid_encoding');
  }
}

/** Conta `;` e `,` fora de aspas ate o fim da primeira linha. Empate -> `;`. */
export function detectSeparator(text: string): ';' | ',' {
  let semicolons = 0;
  let commas = 0;
  let inQuotes = false;
  for (const char of text) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (char === '\n' || char === '\r')) break;
    else if (!inQuotes && char === ';') semicolons += 1;
    else if (!inQuotes && char === ',') commas += 1;
  }
  return commas > semicolons ? ',' : ';';
}

/**
 * Quebra o texto em registros (RFC 4180). Um registro com quebra de linha
 * dentro de aspas continua sendo UM registro — e a linha que o Excel mostra.
 */
export function splitRecords(text: string, separator: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (char === separator) {
      row.push(field);
      field = '';
      fieldStarted = false;
    } else if (char === '\r' || char === '\n') {
      row.push(field);
      records.push(row);
      row = [];
      field = '';
      fieldStarted = false;
      if (char === '\r' && text[i + 1] === '\n') i += 1;
    } else {
      field += char;
      fieldStarted = true;
    }
  }

  if (inQuotes) throw new ExamCsvError('malformed');
  if (fieldStarted || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  return records;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Preco pt-BR ou com ponto. Regras (D-178):
 *  - com `.` E `,`: o ULTIMO e o decimal, o outro e milhar;
 *  - so um tipo, aparecendo uma vez: e o decimal;
 *  - so um tipo, aparecendo mais de uma vez: e milhar (sem casas decimais);
 *  - milhar tem que vir em grupos de 3; decimal tem no maximo 2 casas.
 * `1.234` cai na segunda regra com 3 casas -> erro, em vez de adivinhar.
 */
export function parsePrice(raw: string): Parsed<number> {
  const cleaned = raw.trim().replace(/^R\$/i, '').replace(/\s+/g, '');
  const invalid: Parsed<number> = { ok: false, message: `Preço inválido: "${raw.trim()}"` };
  if (cleaned.startsWith('-')) return { ok: false, message: 'Preço não pode ser negativo' };
  if (!/^[\d.,]+$/.test(cleaned) || !/\d/.test(cleaned)) return invalid;

  const commas = cleaned.split(',').length - 1;
  const dots = cleaned.split('.').length - 1;
  let decimalSep: string | null = null;
  let thousandsSep: string | null = null;
  if (commas > 0 && dots > 0) {
    decimalSep = cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.') ? ',' : '.';
    thousandsSep = decimalSep === ',' ? '.' : ',';
    if (cleaned.split(decimalSep).length - 1 > 1) return invalid;
  } else if (commas === 1 || dots === 1) {
    decimalSep = commas === 1 ? ',' : '.';
  } else if (commas > 1 || dots > 1) {
    thousandsSep = commas > 1 ? ',' : '.';
  }

  let integerPart = cleaned;
  let decimalPart = '';
  if (decimalSep !== null) {
    const at = cleaned.lastIndexOf(decimalSep);
    integerPart = cleaned.slice(0, at);
    decimalPart = cleaned.slice(at + 1);
  }
  if (thousandsSep !== null) {
    const escaped = thousandsSep === '.' ? '\\.' : ',';
    if (!new RegExp(`^\\d{1,3}(${escaped}\\d{3})+$`).test(integerPart)) return invalid;
    integerPart = integerPart.split(thousandsSep).join('');
  }
  if (integerPart === '') integerPart = '0';
  if (!/^\d+$/.test(integerPart) || !/^\d*$/.test(decimalPart)) return invalid;
  if (decimalPart.length > 2) {
    return {
      ok: false,
      message: `Preço com mais de 2 casas decimais: "${raw.trim()}" (use 1234,56 ou 1.234,56)`,
    };
  }

  const value = Number(`${integerPart}.${decimalPart || '0'}`);
  if (!Number.isFinite(value) || value > MAX_PRICE) {
    return { ok: false, message: 'Preço acima do máximo permitido' };
  }
  return { ok: true, value: Math.round(value * 100) / 100 };
}

function parseTurnaround(raw: string): Parsed<number> {
  const trimmed = raw.trim();
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TURNAROUND_HOURS) {
    return {
      ok: false,
      message: `Prazo deve ser um número inteiro de horas, de 1 a ${MAX_TURNAROUND_HOURS}`,
    };
  }
  return { ok: true, value };
}

/** Tamanho em caracteres (como o VARCHAR conta), nao em unidades UTF-16. */
function charLength(value: string): number {
  return [...value].length;
}

const TEXT_LIMITS: Record<'nome' | 'codigo' | 'categoria' | 'descricao' | 'preparo', number> = {
  nome: 255,
  codigo: 50,
  categoria: 100,
  descricao: 4000,
  preparo: 4000,
};

const COLUMN_ORDER = new Map(EXAM_IMPORT_COLUMNS.map((column, index) => [column, index]));

/** Le o CSV em memoria e devolve linhas validas + erros por linha. */
export function parseExamCsv(buffer: Buffer): ExamCsvParseResult {
  const text = decodeUtf8(buffer);
  const records = splitRecords(text, detectSeparator(text));

  const header = records[0];
  if (!header || header.every((cell) => cell.trim() === '')) {
    throw new ExamCsvError('empty');
  }

  const columnIndex = new Map<ExamImportColumn, number>();
  const duplicated = new Set<ExamImportColumn>();
  header.forEach((cell, index) => {
    const column = resolveHeader(cell);
    if (column === null) return; // coluna desconhecida: ignorada
    if (columnIndex.has(column)) duplicated.add(column);
    else columnIndex.set(column, index);
  });
  if (duplicated.size > 0) {
    throw new ExamCsvError('duplicate_column', { columns: [...duplicated] });
  }
  const missing = EXAM_IMPORT_REQUIRED_COLUMNS.filter((column) => !columnIndex.has(column));
  if (missing.length > 0) {
    throw new ExamCsvError('missing_column', { columns: missing });
  }

  // Linha = posicao do registro (cabecalho = 1). Linha em branco conta na
  // numeracao (o Excel tambem mostra), mas nao conta como dado.
  const dataRecords = records
    .map((cells, index) => ({ line: index + 1, cells }))
    .slice(1)
    .filter(({ cells }) => cells.some((cell) => cell.trim() !== ''));

  if (dataRecords.length === 0) throw new ExamCsvError('empty');
  if (dataRecords.length > EXAM_IMPORT_MAX_ROWS) {
    throw new ExamCsvError('too_many_rows', { rows: dataRecords.length, max: EXAM_IMPORT_MAX_ROWS });
  }

  const errors: ExamImportRowError[] = [];
  const candidates: ParsedExamRow[] = [];
  const invalidLines = new Set<number>();

  for (const { line, cells } of dataRecords) {
    const cell = (column: ExamImportColumn): string => {
      const index = columnIndex.get(column);
      return index === undefined ? '' : (cells[index] ?? '').trim();
    };
    const fail = (column: ExamImportColumn | null, message: string): void => {
      errors.push({ line, column, message });
      invalidLines.add(line);
    };

    const texts = {} as Record<keyof typeof TEXT_LIMITS, string>;
    for (const [column, max] of Object.entries(TEXT_LIMITS) as Array<[keyof typeof TEXT_LIMITS, number]>) {
      const value = cell(column);
      texts[column] = value;
      if (charLength(value) > max) fail(column, `Máximo de ${max} caracteres`);
    }
    if (texts.nome === '') fail('nome', 'Nome é obrigatório');
    if (texts.codigo === '') fail('codigo', 'Código é obrigatório');

    let turnaroundHours: number | null = null;
    const rawTurnaround = cell('prazo_horas');
    if (rawTurnaround !== '') {
      const parsed = parseTurnaround(rawTurnaround);
      if (parsed.ok) turnaroundHours = parsed.value;
      else fail('prazo_horas', parsed.message);
    }

    const prices: Partial<Record<'preco_convenio' | 'preco_particular', number>> = {};
    for (const column of ['preco_convenio', 'preco_particular'] as const) {
      const raw = cell(column);
      if (raw === '') {
        fail(column, 'Preço é obrigatório');
        continue;
      }
      const parsed = parsePrice(raw);
      if (parsed.ok) prices[column] = parsed.value;
      else fail(column, parsed.message);
    }

    if (invalidLines.has(line)) continue;
    candidates.push({
      line,
      name: texts.nome,
      code: texts.codigo,
      category: texts.categoria === '' ? null : texts.categoria,
      description: texts.descricao === '' ? null : texts.descricao,
      preparation: texts.preparo === '' ? null : texts.preparo,
      turnaroundHours,
      pricePrivate: prices.preco_particular ?? 0,
      priceInsurance: prices.preco_convenio ?? 0,
    });
  }

  // Codigo repetido no arquivo: comparacao EXATA apos trim — a mesma da
  // `UNIQUE (tenant_id, code)`. Considera tambem linhas que ja tinham outro
  // erro, para o admin ver o conflito de uma vez so.
  const linesByCode = new Map<string, number[]>();
  for (const { line, cells } of dataRecords) {
    const index = columnIndex.get('codigo');
    const code = index === undefined ? '' : (cells[index] ?? '').trim();
    if (code === '') continue;
    linesByCode.set(code, [...(linesByCode.get(code) ?? []), line]);
  }
  for (const [code, lines] of linesByCode) {
    if (lines.length < 2) continue;
    for (const line of lines) {
      errors.push({
        line,
        column: null,
        message: `Código "${code}" repetido no arquivo (linhas ${lines.join(', ')})`,
      });
      invalidLines.add(line);
    }
  }

  errors.sort(
    (a, b) =>
      a.line - b.line ||
      (a.column === null ? -1 : (COLUMN_ORDER.get(a.column) ?? 0)) -
        (b.column === null ? -1 : (COLUMN_ORDER.get(b.column) ?? 0)),
  );

  return {
    totalRows: dataRecords.length,
    rows: candidates.filter((row) => !invalidLines.has(row.line)),
    errors,
    errorCount: invalidLines.size,
  };
}
