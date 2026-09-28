/**
 * Parser puro da planilha de orçamentos do LIS (Onda 9 — D-109, BUSINESS_RULES.md
 * §11). SEM I/O: recebe um `Buffer` já em memória e devolve linhas tipadas — quem
 * fala com banco/tenant é o `LisImportService` (`services/lis-import.service.ts`).
 *
 * Preserva o comportamento do FluxoLab (`orcamento.ts` no repo antigo, hoje
 * indisponível neste monorepo — ver D-121 em docs/DECISIONS.md para a lacuna
 * de aliases e a interpretação restritiva adotada aqui).
 *
 * Responsabilidades:
 *  - guard `%PDF` (arquivo é PDF renomeado para .xlsx)
 *  - exigir a coluna `ORCAMENTO` (aliases de BUSINESS_RULES.md §11.9)
 *  - recusar planilha sem nenhuma linha de dado
 *  - converter serial de data do Excel por COMPONENTES (nunca aritmética de
 *    milissegundos que arraste fuso da máquina — D-110/D-078)
 *  - `consolidateLisRows`: dedupe por `number`, maior `total_value` vence
 *    (BUSINESS_RULES.md §11.1) — port de `consolidateOrcamentos`
 */
import ExcelJS from 'exceljs';
import { parseBitlabDateTime } from './bitlab-client.js';

export type LisImportInvalidReason = 'pdf_disguised' | 'missing_column' | 'empty';

export class LisSpreadsheetError extends Error {
  constructor(readonly reason: LisImportInvalidReason) {
    super(`Planilha do LIS invalida: ${reason}`);
    this.name = 'LisSpreadsheetError';
  }
}

export interface LisSpreadsheetRow {
  /** Coluna ORCAMENTO, cru (string) — obrigatoria, mas pode vir vazia numa linha invalida. */
  number: string;
  issuedOn: string | null; // YYYY-MM-DD
  patientName: string | null;
  insurance1: string | null;
  value1: number | null;
  insurance2: string | null;
  value2: number | null;
  insurance3: string | null;
  value3: number | null;
  attendantName: string | null;
  insuranceAverage: number | null;
  requisitionNumber: string | null;
  requisitionValue: number | null;
  paidValue: number | null;
  paidOn: string | null;
  /**
   * Data/hora do pagamento, `YYYY-MM-DD HH:mm:ss` (Brasília, D-187). A planilha e
   * a API trazem os segundos; ausente = só a data de `paidOn` (CRMLAB-53, D-188).
   */
  paidAt?: string | null;
  /** `ID_PAGAMENTO` do Bitlab. Só a API tem (D-188 item 2). */
  paymentId?: string | null;
  /** `SITUACAO_PAGAMENTO`. Ausente = ativo (a planilha não tem situação). */
  paymentStatus?: LisPaymentStatus | null;
  /** `DATA_ESTORNO`, `YYYY-MM-DD HH:mm:ss`. */
  reversedAt?: string | null;
  paymentMethod?: string | null;
  cardBrand?: string | null;
}

export type LisPaymentStatus = 'ativo' | 'estornado';

/** Um pagamento do extrato (`lis_budget_payments`, D-188). */
export interface LisPayment {
  /** `ID_PAGAMENTO`, ou `planilha:<paidAt>:<valor>` quando não há ID. */
  key: string;
  requisitionNumber: string | null;
  paidAt: string | null;
  value: number;
  status: LisPaymentStatus;
  reversedAt: string | null;
  method: string | null;
  brand: string | null;
}

/** Orçamento consolidado + todos os pagamentos das linhas dele (D-188 item 5). */
export interface LisBudgetInput extends LisSpreadsheetRow {
  payments: LisPayment[];
}

/**
 * Campos internos -> aliases de cabecalho aceitos (BUSINESS_RULES.md §11.9).
 * Casamento sem caixa/acento (`foldHeader`). `requisitionNumber`/`paidValue`/
 * `paidOn` tem variantes de grafia cuja lista completa nao sobreviveu no
 * FluxoLab antigo (D-121) — os aliases abaixo cobrem o canonico do contrato +
 * variantes defensaveis; ajustar aqui e o unico ponto de mudanca se surgir
 * uma planilha real com um cabecalho novo.
 */
/** Colunas da planilha. Os campos do pagamento da API (D-188) não têm coluna. */
type SheetField = Exclude<
  keyof LisSpreadsheetRow,
  'paidAt' | 'paymentId' | 'paymentStatus' | 'reversedAt' | 'paymentMethod' | 'cardBrand'
>;

const FIELD_ALIASES: Record<SheetField, string[]> = {
  number: ['ORCAMENTO'],
  issuedOn: ['DATA_ORCAMENTO'],
  patientName: ['NM_PACIENTE'],
  insurance1: ['CONVENIO1'],
  value1: ['VL_TOTAL1'],
  insurance2: ['CONVENIO2'],
  value2: ['VL_TOTAL2'],
  insurance3: ['CONVENIO3'],
  value3: ['VL_TOTAL3'],
  attendantName: ['USUARIO'],
  insuranceAverage: ['MEDIA_CONVENIO'],
  requisitionNumber: [
    'REQUISICAO',
    'NUM_REQUISICAO',
    'NUMERO_REQUISICAO',
    'COD_REQUISICAO',
    'REQUISICAO_NUMERO',
  ],
  requisitionValue: ['VALOR_REQUISICAO'],
  paidValue: ['VALOR_PAGO', 'VL_PAGO', 'VALOR_RECEBIDO'],
  paidOn: ['DATA_PAGAMENTO', 'DT_PAGAMENTO', 'DATA_PGTO', 'DT_PGTO', 'DATA_RECEBIMENTO'],
};

type DateField = 'issuedOn' | 'paidOn';
type NumberField = 'value1' | 'value2' | 'value3' | 'insuranceAverage' | 'requisitionValue' | 'paidValue';

const DATE_FIELDS: readonly DateField[] = ['issuedOn', 'paidOn'];
const NUMBER_FIELDS: readonly NumberField[] = [
  'value1',
  'value2',
  'value3',
  'insuranceAverage',
  'requisitionValue',
  'paidValue',
];

const ACCENTED = 'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ';
const PLAIN = 'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN';

/** Dobra de cabecalho: sem caixa, sem acento, espacos/underscores colapsados. */
function foldHeader(value: string): string {
  let out = '';
  for (const char of value.trim()) {
    const index = ACCENTED.indexOf(char);
    out += index >= 0 ? PLAIN[index] : char;
  }
  return out.toUpperCase().replace(/[\s_]+/g, '_').replace(/^_|_$/g, '');
}

const ALIAS_TO_FIELD = new Map<string, keyof LisSpreadsheetRow>();
for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
  for (const alias of aliases) {
    ALIAS_TO_FIELD.set(foldHeader(alias), field as keyof LisSpreadsheetRow);
  }
}

/** Assinatura de PDF nos primeiros bytes — guard antes de tentar abrir como xlsx. */
function isPdfDisguised(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.subarray(0, 4).toString('latin1') === '%PDF';
}

/**
 * Serial de data do Excel -> {y, m, d}, por componentes. Dia 1 = 1900-01-01,
 * com a correcao do bug de ano bissexto de 1900 que o proprio Excel carrega
 * (BUSINESS_RULES.md §11.9): series >= 60 sao deslocadas 1 dia (fantasma
 * 29/02/1900 nunca existiu).
 */
function excelSerialToIsoDate(serial: number): string {
  const base = Date.UTC(1900, 0, 1);
  let days = Math.trunc(serial) - 1;
  if (serial >= 60) days -= 1;
  const date = new Date(base + days * 86_400_000);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** `Date` (ja resolvida pelo exceljs) -> `YYYY-MM-DD`, por componentes UTC (nunca fuso local). */
function dateToIsoDate(value: Date): string {
  const y = value.getUTCFullYear();
  const m = String(value.getUTCMonth() + 1).padStart(2, '0');
  const d = String(value.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Como `cellToDate`, mas com a hora (`YYYY-MM-DD HH:mm:ss`), sem fuso (D-187). */
function cellToDateTime(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const hh = String(value.getUTCHours()).padStart(2, '0');
    const mi = String(value.getUTCMinutes()).padStart(2, '0');
    const ss = String(value.getUTCSeconds()).padStart(2, '0');
    return `${dateToIsoDate(value)} ${hh}:${mi}:${ss}`;
  }
  const serial =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())
        ? Number(value.trim())
        : null;
  if (serial !== null && Number.isFinite(serial)) {
    const seconds = Math.round((serial - Math.trunc(serial)) * 86_400);
    const hh = String(Math.floor(seconds / 3600) % 24).padStart(2, '0');
    const mi = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
    const ss = String(seconds % 60).padStart(2, '0');
    return `${excelSerialToIsoDate(serial)} ${hh}:${mi}:${ss}`;
  }
  if (typeof value === 'string') {
    const parsed = parseBitlabDateTime(value);
    if (parsed) return parsed;
  }
  const day = cellToDate(value);
  return day === null ? null : `${day} 00:00:00`;
}

function cellToDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return dateToIsoDate(value);
  if (typeof value === 'number' && Number.isFinite(value)) return excelSerialToIsoDate(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber) && trimmed.match(/^\d+(\.\d+)?$/)) {
      return excelSerialToIsoDate(asNumber);
    }
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : dateToIsoDate(parsed);
  }
  return null;
}

/** Numero pt-BR: virgula decimal, ponto como separador de milhar. */
function cellToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object' && 'result' in (value as Record<string, unknown>)) {
    // celula com formula (exceljs): usa o resultado calculado.
    return cellToNumber((value as { result: unknown }).result);
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  let cleaned = trimmed.replace(/[^\d,.-]/g, '');
  if (cleaned.includes(',') && cleaned.includes('.')) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (cleaned.includes(',')) {
    cleaned = cleaned.replace(',', '.');
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function cellToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && 'text' in (value as Record<string, unknown>)) {
    // rich text do exceljs.
    return cellToString((value as { text: unknown }).text);
  }
  if (typeof value === 'object' && 'result' in (value as Record<string, unknown>)) {
    return cellToString((value as { result: unknown }).result);
  }
  const text = String(value).trim();
  return text === '' ? null : text;
}

/** Lê o `.xlsx` em memória e devolve as linhas tipadas, sem consolidar. */
export async function parseLisSpreadsheet(buffer: Buffer): Promise<LisSpreadsheetRow[]> {
  if (isPdfDisguised(buffer)) {
    throw new LisSpreadsheetError('pdf_disguised');
  }

  let workbook: ExcelJS.Workbook;
  try {
    workbook = new ExcelJS.Workbook();
    // Interop de tipos entre a definicao de `Buffer` do exceljs e a deste
    // projeto (generico em @types/node mais novo) — mesmo valor em runtime.
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new LisSpreadsheetError('empty');
  }

  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount < 1) {
    throw new LisSpreadsheetError('empty');
  }

  const headerRow = sheet.getRow(1);
  const columnToField = new Map<number, keyof LisSpreadsheetRow>();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const raw = cellToString(cell.value);
    if (!raw) return;
    const field = ALIAS_TO_FIELD.get(foldHeader(raw));
    if (field) columnToField.set(colNumber, field);
  });

  const hasNumberColumn = [...columnToField.values()].includes('number');
  if (!hasNumberColumn) {
    throw new LisSpreadsheetError('missing_column');
  }

  const rows: LisSpreadsheetRow[] = [];
  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    if (row.cellCount === 0) continue;

    const parsed: Partial<Record<keyof LisSpreadsheetRow, unknown>> = {};
    let hasAnyValue = false;
    for (const [colNumber, field] of columnToField.entries()) {
      const cell = row.getCell(colNumber);
      if (cell.value !== null && cell.value !== undefined && cell.value !== '') hasAnyValue = true;
      parsed[field] = cell.value;
    }
    if (!hasAnyValue) continue;

    const record: Record<string, unknown> = {};
    for (const field of Object.keys(FIELD_ALIASES) as (keyof LisSpreadsheetRow)[]) {
      const raw = parsed[field];
      if (DATE_FIELDS.includes(field as DateField)) {
        record[field] = cellToDate(raw);
        if (field === 'paidOn') record.paidAt = cellToDateTime(raw);
      } else if (NUMBER_FIELDS.includes(field as NumberField)) {
        record[field] = cellToNumber(raw);
      } else {
        record[field] = field === 'number' ? (cellToString(raw) ?? '') : cellToString(raw);
      }
    }

    rows.push(record as unknown as LisSpreadsheetRow);
  }

  if (rows.length === 0) {
    throw new LisSpreadsheetError('empty');
  }

  return rows;
}

/**
 * Convenio principal: o primeiro de c1..c3 com nome E valor > 0; se nenhum
 * tiver valor > 0, o primeiro que tem nome (BUSINESS_RULES.md §11.3).
 */
export function principalInsuranceName(row: LisSpreadsheetRow): string | null {
  const pairs: Array<[string | null, number | null]> = [
    [row.insurance1, row.value1],
    [row.insurance2, row.value2],
    [row.insurance3, row.value3],
  ];
  for (const [name, value] of pairs) {
    if (name !== null && (value ?? 0) > 0) return name;
  }
  for (const [name] of pairs) {
    if (name !== null) return name;
  }
  return null;
}

/**
 * Valor do CONVÊNIO PRINCIPAL (mesma seleção de `principalInsuranceName`) —
 * espelha `lis_budgets.total_value` gerada (SCHEMA.md §26, D-124).
 * `insurance_2`/`insurance_3` são cotações ALTERNATIVAS do mesmo orçamento
 * (o mesmo exame precificado por outro convênio), não valores adicionais —
 * `value1 + value2 + value3` está ERRADO (era o bug de D-124, corrigido pela
 * migração 014 depois de comparar com o app de referência do FluxoLab).
 */
export function totalValue(row: LisSpreadsheetRow): number {
  const pairs: Array<[string | null, number | null]> = [
    [row.insurance1, row.value1],
    [row.insurance2, row.value2],
    [row.insurance3, row.value3],
  ];
  for (const [name, value] of pairs) {
    if (name !== null && (value ?? 0) > 0) return value ?? 0;
  }
  for (const [name, value] of pairs) {
    if (name !== null) return value ?? 0;
  }
  // Nenhum dos três tem nome de convênio (planilha sem essa coluna
  // preenchida) — usa o primeiro valor > 0 mesmo sem nome, igual ao app de
  // referência (`opts.find(o => o.v > 0)`, terceiro fallback).
  for (const [, value] of pairs) {
    if ((value ?? 0) > 0) return value ?? 0;
  }
  return 0;
}

/**
 * O pagamento de uma linha, ou `null` se ela não tem `Valor_Pago` (D-188).
 * Sem `ID_PAGAMENTO` (planilha), a chave é a data/hora + o valor: a mesma linha
 * importada duas vezes cai na mesma chave e não soma em dobro.
 */
export function paymentOf(row: LisSpreadsheetRow): LisPayment | null {
  if (row.paidValue === null) return null;
  const paidAt = row.paidAt ?? (row.paidOn ? `${row.paidOn} 00:00:00` : null);
  const id = row.paymentId?.trim();
  return {
    key: id ? id : `planilha:${paidAt ?? ''}:${row.paidValue.toFixed(2)}`,
    requisitionNumber: row.requisitionNumber,
    paidAt,
    value: row.paidValue,
    status: row.paymentStatus ?? 'ativo',
    reversedAt: row.reversedAt ?? null,
    method: row.paymentMethod ?? null,
    brand: row.cardBrand ?? null,
  };
}

/**
 * Dedupe por `number` — a de maior `total_value` vence para os campos do
 * orçamento (BUSINESS_RULES.md §11.1); a requisição é mesclada entre as linhas
 * (D-126) e o valor da requisição fica com o maior.
 *
 * Pagamento NÃO é decidido aqui (CRMLAB-53, D-188 item 5): cada linha é um
 * pagamento, e todos vão em `payments` (sem repetir chave; a última vista
 * vence, que é a mais nova numa mesma resposta). O recebido é calculado no
 * banco, a partir do extrato. `paidValue`/`paidOn` da linha consolidada ficam
 * só como vieram da linha representante e não são gravados.
 *
 * Linhas sem `number` (string vazia) NAO entram aqui — filtre antes de
 * chamar. Empate de `total_value`: mantém a primeira vista (ordem estável).
 */
export function consolidateLisRows(rows: LisSpreadsheetRow[]): LisBudgetInput[] {
  const byNumber = new Map<string, LisBudgetInput>();
  const paymentsByNumber = new Map<string, Map<string, LisPayment>>();
  for (const row of rows) {
    const key = row.number.trim();
    if (key === '') continue;

    const payment = paymentOf(row);
    if (payment) {
      const payments = paymentsByNumber.get(key) ?? new Map<string, LisPayment>();
      payments.set(payment.key, payment);
      paymentsByNumber.set(key, payments);
    }

    const existing = byNumber.get(key);
    if (!existing) {
      byNumber.set(key, { ...row, payments: [] });
      continue;
    }

    const rep = totalValue(row) > totalValue(existing) ? row : existing;
    const other = rep === row ? existing : row;
    byNumber.set(key, {
      ...rep,
      payments: [],
      requisitionNumber: rep.requisitionNumber ?? other.requisitionNumber,
      requisitionValue: Math.max(rep.requisitionValue ?? 0, other.requisitionValue ?? 0),
    });
  }
  return [...byNumber.entries()].map(([key, budget]) => ({
    ...budget,
    payments: [...(paymentsByNumber.get(key)?.values() ?? [])],
  }));
}
