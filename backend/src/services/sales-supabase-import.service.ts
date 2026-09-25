/**
 * Carga pontual das vendas (`public.vendas`) dos dois Supabases do Santé —
 * FluxoLab/Vercel e app original/Lovable — para `sales` de um tenant
 * (CRMLAB-45). Regras: D-179 (uniao por id, vence o `updated_at` mais recente,
 * idempotencia) e D-180 (como grava). Passo a passo: docs/guides/MIGRACAO_SANTE.md §1.
 *
 * Tres etapas puras + uma que toca o banco:
 *   1. `parseVendasCsv`  — CSV -> linhas validadas | rejeitadas com motivo;
 *   2. `mergeSources`    — uniao por id, conflitos;
 *   3. `importSales`     — resolve atendente/created_by, grava (ou ensaia) e
 *                          mede a paridade, tudo num unico `withTenant`.
 *
 * Dinheiro e sempre CENTAVOS INTEIROS (`number` inteiro), nunca float.
 * Comissao nao e gravada na linha (D-002): este script nem a calcula.
 */
import type { DbClient, DbTx } from '../db/types.js';
import { parseCsv } from '../lib/csv.js';
import * as repo from '../repositories/sales-import.repository.js';

export type SourceName = 'fluxolab' | 'lovable';
export type SaleKind = 'exams' | 'checkup';

export interface SourceSale {
  source: SourceName;
  line: number;
  id: string;
  attendantName: string;
  soldOn: string;
  code: string | null;
  cents: number;
  exams: string | null;
  kind: SaleKind;
  createdBy: string | null;
  /** UTC em `YYYY-MM-DD HH:MM:SS.ffffff` — comparavel como string. */
  createdAt: string;
  updatedAt: string;
}

export interface RejectedRow {
  source: SourceName;
  /** Linha do CSV; `null` quando a rejeicao acontece na gravacao. */
  line: number | null;
  id: string | null;
  reason: string;
}

export interface ParsedSource {
  source: SourceName;
  /** Linhas de dados lidas (validas + rejeitadas). */
  read: number;
  rows: SourceSale[];
  rejected: RejectedRow[];
}

export interface Conflict {
  id: string;
  winner: SourceName;
  winnerUpdatedAt: string;
  loser: SourceName;
  loserUpdatedAt: string;
  /** Campos de negocio que diferem entre as duas versoes. */
  fields: string[];
}

export interface MergeResult {
  rows: SourceSale[];
  inBoth: number;
  onlyFluxolab: number;
  onlyLovable: number;
  conflicts: Conflict[];
}

// ---------------------------------------------------------------------------
// Normalizacao e validacao
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const MONEY_RE = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

/** Dobra de nome para casar atendente: sem acento, caixa, espacos extras (D-180 item 2). */
export function foldAttendantName(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function isValidDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function parseDate(value: string): string | null {
  const match = DATE_RE.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  return isValidDate(Number(y), Number(m), Number(d)) ? `${y}-${m}-${d}` : null;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** `timestamptz` do export -> UTC `YYYY-MM-DD HH:MM:SS.ffffff`. Sem fuso = UTC. */
export function parseTimestamp(value: string): string | null {
  const match = TIMESTAMP_RE.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s, frac = '', tz = 'Z'] = match;
  if (!isValidDate(Number(y), Number(mo), Number(d))) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;

  let offsetMinutes = 0;
  if (tz.toUpperCase() !== 'Z') {
    const sign = tz.startsWith('-') ? -1 : 1;
    const digits = tz.slice(1).replace(':', '');
    offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || '0'));
  }
  const ms =
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) -
    offsetMinutes * 60_000;
  const t = new Date(ms);
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}.` +
    frac.padEnd(6, '0')
  );
}

/** Decimal com ate 2 casas -> centavos inteiros. `null` se nao for numero. */
export function toCents(value: string): number | null {
  const match = MONEY_RE.exec(value.trim());
  if (!match) return null;
  const [, minus, int, frac = ''] = match;
  const cents = Number(int) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return null;
  return minus && cents !== 0 ? -cents : cents;
}

/** Centavos -> decimal em texto (`12345` -> `"123.45"`). */
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${pad(abs % 100)}`;
}

/** Centavos -> `R$ 1.234,56` para o relatorio de terminal. */
export function formatBrl(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const int = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}R$ ${int},${pad(abs % 100)}`;
}

function mapKind(value: string): SaleKind | null {
  const v = value.trim().toLowerCase();
  if (v === 'exames' || v === 'exams') return 'exams';
  if (v === 'checkup' || v === 'check-up') return 'checkup';
  return null;
}

// ---------------------------------------------------------------------------
// 1. CSV -> linhas
// ---------------------------------------------------------------------------

const REQUIRED_COLUMNS = [
  'id',
  'atendente',
  'data_venda',
  'valor',
  'tipo',
  'created_at',
  'updated_at',
] as const;
/** Opcionais: `codigo`, `exames`, `created_by` (ausentes = vazio). */
type Column = (typeof REQUIRED_COLUMNS)[number] | 'codigo' | 'exames' | 'created_by';

export const MAX_CODE_LENGTH = 50;

/**
 * Le o CSV exportado de `public.vendas`. Cabecalho sem coluna obrigatoria e
 * erro do ARQUIVO (lanca) — nao da para rejeitar linha por linha algo que
 * falta em todas.
 */
export function parseVendasCsv(text: string, source: SourceName): ParsedSource {
  const records = parseCsv(text);
  const header = records.shift();
  if (!header) throw new Error(`CSV de ${source} vazio (sem cabecalho)`);

  const index = new Map<string, number>();
  header.fields.forEach((name, i) => index.set(name.trim().toLowerCase(), i));
  const missing = REQUIRED_COLUMNS.filter((c) => !index.has(c));
  if (missing.length > 0) {
    throw new Error(`CSV de ${source} sem as colunas obrigatorias: ${missing.join(', ')}`);
  }

  const rows: SourceSale[] = [];
  const rejected: RejectedRow[] = [];

  for (const record of records) {
    const get = (col: Column): string => {
      const i = index.get(col);
      return i === undefined ? '' : (record.fields[i] ?? '');
    };
    const rawId = get('id').trim();
    const reject = (reason: string): void => {
      rejected.push({ source, line: record.line, id: rawId || null, reason });
    };

    if (record.fields.length !== header.fields.length) {
      reject(
        `numero de colunas (${record.fields.length}) difere do cabecalho (${header.fields.length})`,
      );
      continue;
    }
    if (!UUID_RE.test(rawId)) {
      reject(`id invalido: "${rawId}"`);
      continue;
    }
    const attendantName = get('atendente').trim().replace(/\s+/g, ' ');
    if (!attendantName) {
      reject('atendente vazio');
      continue;
    }
    const soldOn = parseDate(get('data_venda'));
    if (!soldOn) {
      reject(`data_venda invalida: "${get('data_venda')}"`);
      continue;
    }
    const cents = toCents(get('valor'));
    if (cents === null) {
      reject(`valor invalido: "${get('valor')}"`);
      continue;
    }
    if (cents <= 0) {
      reject(`valor <= 0 (${get('valor').trim()}): sales exige value > 0`);
      continue;
    }
    const kind = mapKind(get('tipo'));
    if (!kind) {
      reject(`tipo invalido: "${get('tipo')}" (esperado exames ou checkup)`);
      continue;
    }
    const code = get('codigo').trim() || null;
    if (code !== null && code.length > MAX_CODE_LENGTH) {
      reject(`codigo com mais de ${MAX_CODE_LENGTH} caracteres`);
      continue;
    }
    const rawCreatedBy = get('created_by').trim();
    if (rawCreatedBy && !UUID_RE.test(rawCreatedBy)) {
      reject(`created_by invalido: "${rawCreatedBy}"`);
      continue;
    }
    const createdAt = parseTimestamp(get('created_at'));
    if (!createdAt) {
      reject(`created_at invalido: "${get('created_at')}"`);
      continue;
    }
    const updatedAt = parseTimestamp(get('updated_at'));
    if (!updatedAt) {
      reject(`updated_at invalido: "${get('updated_at')}"`);
      continue;
    }

    rows.push({
      source,
      line: record.line,
      id: rawId.toLowerCase(),
      attendantName,
      soldOn,
      code,
      cents,
      exams: get('exames').trim() || null,
      kind,
      createdBy: rawCreatedBy ? rawCreatedBy.toLowerCase() : null,
      createdAt,
      updatedAt,
    });
  }

  return { source, read: records.length, rows, rejected };
}

// ---------------------------------------------------------------------------
// 2. Uniao por id (D-179)
// ---------------------------------------------------------------------------

function differingFields(a: SourceSale, b: SourceSale): string[] {
  const fields: string[] = [];
  if (foldAttendantName(a.attendantName) !== foldAttendantName(b.attendantName)) {
    fields.push('atendente');
  }
  if (a.soldOn !== b.soldOn) fields.push('data_venda');
  if (a.code !== b.code) fields.push('codigo');
  if (a.cents !== b.cents) fields.push('valor');
  if (a.exams !== b.exams) fields.push('exames');
  if (a.kind !== b.kind) fields.push('tipo');
  if (a.createdBy !== b.createdBy) fields.push('created_by');
  if (a.createdAt !== b.createdAt) fields.push('created_at');
  return fields;
}

/** Vence o `updated_at` mais recente; empate -> FluxoLab (D-179 item 2). */
function pickWinner(a: SourceSale, b: SourceSale): [SourceSale, SourceSale] {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? [a, b] : [b, a];
  if (a.source !== b.source) return a.source === 'fluxolab' ? [a, b] : [b, a];
  return [a, b]; // mesmo arquivo, mesmo updated_at: fica a primeira ocorrencia
}

export function mergeSources(fluxolab: SourceSale[], lovable: SourceSale[]): MergeResult {
  const byId = new Map<string, SourceSale>();
  const seenIn = new Map<string, Set<SourceName>>();
  const conflicts = new Map<string, Conflict>();

  for (const row of [...fluxolab, ...lovable]) {
    const sources = seenIn.get(row.id) ?? new Set<SourceName>();
    sources.add(row.source);
    seenIn.set(row.id, sources);

    const current = byId.get(row.id);
    if (!current) {
      byId.set(row.id, row);
      continue;
    }
    const [winner, loser] = pickWinner(current, row);
    byId.set(row.id, winner);
    const fields = differingFields(winner, loser);
    if (fields.length > 0) {
      conflicts.set(row.id, {
        id: row.id,
        winner: winner.source,
        winnerUpdatedAt: winner.updatedAt,
        loser: loser.source,
        loserUpdatedAt: loser.updatedAt,
        fields,
      });
    }
  }

  let inBoth = 0;
  let onlyFluxolab = 0;
  let onlyLovable = 0;
  for (const sources of seenIn.values()) {
    if (sources.size === 2) inBoth += 1;
    else if (sources.has('fluxolab')) onlyFluxolab += 1;
    else onlyLovable += 1;
  }

  const rows = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    rows,
    inBoth,
    onlyFluxolab,
    onlyLovable,
    conflicts: [...conflicts.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

// ---------------------------------------------------------------------------
// 3. Gravacao + paridade
// ---------------------------------------------------------------------------

export interface Totals {
  count: number;
  cents: number;
}

export interface ParityWindow {
  label: 'mes_anterior' | 'mes_corrente' | 'tudo';
  start: string | null;
  end: string | null;
  source: Totals;
  stored: Totals;
  matches: boolean;
}

export interface AttendantParity {
  attendant: string;
  source: Totals;
  stored: Totals;
  matches: boolean;
}

export interface SalesImportReport {
  tenantId: string;
  dryRun: boolean;
  read: Record<SourceName, number>;
  valid: Record<SourceName, number>;
  inBoth: number;
  onlyFluxolab: number;
  onlyLovable: number;
  conflicts: Conflict[];
  attendantsCreated: string[];
  inserted: number;
  updated: number;
  unchanged: number;
  rejected: RejectedRow[];
  parity: ParityWindow[];
  byAttendant: AttendantParity[];
}

export interface ImportSalesOptions {
  tenantId: string;
  fluxolab: ParsedSource;
  lovable: ParsedSource;
  dryRun: boolean;
  /** Data de referencia das janelas de paridade (`YYYY-MM-DD`). */
  today: string;
}

export class TenantNotFoundError extends Error {
  constructor(ref: string) {
    super(`Tenant "${ref}" nao existe — nada foi gravado.`);
    this.name = 'TenantNotFoundError';
  }
}

/** Sinaliza o ROLLBACK proposital do `--dry-run` carregando o relatorio. */
class DryRunRollback extends Error {
  constructor(readonly report: SalesImportReport) {
    super('dry-run');
  }
}

/** `--tenant` aceita UUID ou slug; devolve o id ou lanca `TenantNotFoundError`. */
export async function resolveTenant(db: DbClient, ref: string): Promise<string> {
  const trimmed = ref.trim();
  const id = UUID_RE.test(trimmed)
    ? trimmed.toLowerCase()
    : await repo.findTenantIdBySlug(db, trimmed);
  if (!id) throw new TenantNotFoundError(ref);
  const exists = await db.withTenant(id, (tx) => repo.tenantExists(tx, id));
  if (!exists) throw new TenantNotFoundError(ref);
  return id;
}

/** Janelas mes anterior / mes corrente / tudo relativas a `today`. */
export function parityWindows(
  today: string,
): Array<{ label: ParityWindow['label']; start: string | null; end: string | null }> {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const lastDay = (yy: number, mm: number): number => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return [
    {
      label: 'mes_anterior',
      start: `${py}-${pad(pm)}-01`,
      end: `${py}-${pad(pm)}-${pad(lastDay(py, pm))}`,
    },
    {
      label: 'mes_corrente',
      start: `${y}-${pad(m)}-01`,
      end: `${y}-${pad(m)}-${pad(lastDay(y, m))}`,
    },
    { label: 'tudo', start: null, end: null },
  ];
}

function sumTotals(rows: SourceSale[]): Totals {
  return rows.reduce((acc, r) => ({ count: acc.count + 1, cents: acc.cents + r.cents }), {
    count: 0,
    cents: 0,
  });
}

function storedTotals(row: repo.TotalsRow): Totals {
  const cents = toCents(row.total);
  if (cents === null) throw new Error(`Soma inesperada do banco: ${row.total}`);
  return { count: row.count, cents };
}

const sameTotals = (a: Totals, b: Totals): boolean => a.count === b.count && a.cents === b.cents;

async function runImport(
  tx: DbTx,
  options: ImportSalesOptions,
  merged: MergeResult,
): Promise<SalesImportReport> {
  const { tenantId } = options;

  // Atendentes: casar por nome dobrado sem acento; criar o que faltar (D-180 item 2).
  const attendantByFold = new Map<string, string>();
  const attendantNameById = new Map<string, string>();
  for (const a of await repo.listAttendants(tx, tenantId)) {
    attendantNameById.set(a.id, a.name);
    const key = foldAttendantName(a.name);
    if (!attendantByFold.has(key)) attendantByFold.set(key, a.id);
  }
  const attendantsCreated: string[] = [];
  const attendantIdOf = new Map<string, string>(); // SourceSale.id -> attendant_id
  for (const row of merged.rows) {
    const key = foldAttendantName(row.attendantName);
    let id = attendantByFold.get(key);
    if (!id) {
      id = await repo.insertAttendant(tx, tenantId, row.attendantName);
      attendantByFold.set(key, id);
      attendantNameById.set(id, row.attendantName);
      attendantsCreated.push(row.attendantName);
    }
    attendantIdOf.set(row.id, id);
  }

  const userIds = await repo.listUserIds(tx, tenantId);
  const stamps = await repo.listSaleStamps(tx, tenantId);

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  const rejected: RejectedRow[] = [];
  const accepted: SourceSale[] = [];

  for (const row of merged.rows) {
    const sale: repo.SaleInsert = {
      id: row.id,
      tenantId,
      attendantId: attendantIdOf.get(row.id) as string,
      soldOn: row.soldOn,
      code: row.code,
      value: centsToDecimal(row.cents),
      exams: row.exams,
      kind: row.kind,
      createdBy: row.createdBy && userIds.has(row.createdBy) ? row.createdBy : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    const storedAt = stamps.get(row.id);
    if (storedAt === undefined) {
      if (await repo.insertSale(tx, sale)) {
        inserted += 1;
        accepted.push(row);
      } else {
        rejected.push({
          source: row.source,
          line: row.line,
          id: row.id,
          reason: 'id ja usado por outro tenant — venda nao gravada',
        });
      }
    } else if (row.updatedAt > storedAt) {
      // DELETE + INSERT preserva os timestamps da origem (D-180 item 1).
      await repo.deleteSale(tx, tenantId, row.id);
      await repo.insertSale(tx, sale);
      updated += 1;
      accepted.push(row);
    } else {
      unchanged += 1;
      accepted.push(row);
    }
  }

  // Paridade: uniao das origens (aceitas) x gravado no tenant (D-180 item 6).
  const parity: ParityWindow[] = [];
  for (const w of parityWindows(options.today)) {
    const inWindow =
      w.start && w.end
        ? accepted.filter((r) => r.soldOn >= w.start! && r.soldOn <= w.end!)
        : accepted;
    const source = sumTotals(inWindow);
    const stored = storedTotals(
      await repo.saleTotals(
        tx,
        tenantId,
        w.start && w.end ? { start: w.start, end: w.end } : undefined,
      ),
    );
    parity.push({ ...w, source, stored, matches: sameTotals(source, stored) });
  }

  const byAttendantMap = new Map<string, AttendantParity>();
  const entry = (attendantId: string, name: string): AttendantParity => {
    let item = byAttendantMap.get(attendantId);
    if (!item) {
      item = {
        attendant: name,
        source: { count: 0, cents: 0 },
        stored: { count: 0, cents: 0 },
        matches: false,
      };
      byAttendantMap.set(attendantId, item);
    }
    return item;
  };
  for (const row of accepted) {
    const id = attendantIdOf.get(row.id) as string;
    const item = entry(id, attendantNameById.get(id) ?? row.attendantName);
    item.source.count += 1;
    item.source.cents += row.cents;
  }
  for (const row of await repo.saleTotalsByAttendant(tx, tenantId)) {
    entry(row.attendantId, row.name).stored = storedTotals(row);
  }
  const byAttendant = [...byAttendantMap.values()]
    .map((item) => ({ ...item, matches: sameTotals(item.source, item.stored) }))
    .sort((a, b) => a.attendant.localeCompare(b.attendant, 'pt-BR'));

  return {
    tenantId,
    dryRun: options.dryRun,
    read: { fluxolab: options.fluxolab.read, lovable: options.lovable.read },
    valid: { fluxolab: options.fluxolab.rows.length, lovable: options.lovable.rows.length },
    inBoth: merged.inBoth,
    onlyFluxolab: merged.onlyFluxolab,
    onlyLovable: merged.onlyLovable,
    conflicts: merged.conflicts,
    attendantsCreated,
    inserted,
    updated,
    unchanged,
    rejected: [...options.fluxolab.rejected, ...options.lovable.rejected, ...rejected],
    parity,
    byAttendant,
  };
}

/**
 * Executa a carga num unico `withTenant`. Em `dryRun` a transacao inteira e
 * desfeita no fim (D-180 item 5) — o relatorio e o mesmo da gravacao real.
 */
export async function importSales(
  db: DbClient,
  options: ImportSalesOptions,
): Promise<SalesImportReport> {
  const merged = mergeSources(options.fluxolab.rows, options.lovable.rows);
  try {
    return await db.withTenant(options.tenantId, async (tx) => {
      if (!(await repo.tenantExists(tx, options.tenantId))) {
        throw new TenantNotFoundError(options.tenantId);
      }
      const report = await runImport(tx, options, merged);
      if (options.dryRun) throw new DryRunRollback(report);
      return report;
    });
  } catch (err) {
    if (err instanceof DryRunRollback) return err.report;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Relatorio de terminal
// ---------------------------------------------------------------------------

const WINDOW_LABEL: Record<ParityWindow['label'], string> = {
  mes_anterior: 'Mes anterior',
  mes_corrente: 'Mes corrente',
  tudo: 'Tudo',
};

export function formatSalesImportReport(report: SalesImportReport): string {
  const out: string[] = [];
  const line = (s = ''): void => {
    out.push(s);
  };
  const totals = (t: Totals): string => `${t.count} vendas / ${formatBrl(t.cents)}`;

  line(
    report.dryRun
      ? '=== ENSAIO (--dry-run): nada foi gravado ==='
      : '=== Carga de vendas dos Supabases concluida ===',
  );
  line(`Tenant: ${report.tenantId}`);
  line();
  line(`Lidas FluxoLab: ${report.read.fluxolab} (validas ${report.valid.fluxolab})`);
  line(`Lidas Lovable:  ${report.read.lovable} (validas ${report.valid.lovable})`);
  line(
    `Em comum: ${report.inBoth} | so FluxoLab: ${report.onlyFluxolab} | so Lovable: ${report.onlyLovable}`,
  );
  line();
  line(`Conflitos (mesmo id, conteudo diferente): ${report.conflicts.length}`);
  for (const c of report.conflicts) {
    line(
      `  ${c.id}: venceu ${c.winner} (${c.winnerUpdatedAt}) sobre ${c.loser} (${c.loserUpdatedAt}) — ${c.fields.join(', ')}`,
    );
  }
  line(`Atendentes criados: ${report.attendantsCreated.length}`);
  for (const name of report.attendantsCreated) line(`  + ${name}`);
  line();
  line(`Inseridas: ${report.inserted}`);
  line(`Atualizadas: ${report.updated}`);
  line(`Inalteradas: ${report.unchanged}`);
  line(`Rejeitadas: ${report.rejected.length}`);
  for (const r of report.rejected) {
    const where = r.line === null ? r.source : `${r.source}:${r.line}`;
    line(`  - [${where}] ${r.id ?? '(sem id)'}: ${r.reason}`);
  }
  line();
  line('Paridade (origem = uniao das linhas aceitas; gravado = vendas do tenant):');
  for (const w of report.parity) {
    const range = w.start ? ` ${w.start} a ${w.end}` : '';
    line(
      `  ${w.matches ? 'OK ' : 'DIF'} ${WINDOW_LABEL[w.label]}${range}: origem ${totals(w.source)} | gravado ${totals(w.stored)}`,
    );
  }
  line('Por atendente:');
  for (const a of report.byAttendant) {
    line(
      `  ${a.matches ? 'OK ' : 'DIF'} ${a.attendant}: origem ${totals(a.source)} | gravado ${totals(a.stored)}`,
    );
  }
  return `${out.join('\n')}\n`;
}

/** Forma serializavel do relatorio para `--report` (valores em decimal texto + centavos). */
export function reportToJson(report: SalesImportReport): string {
  const money = (t: Totals): { count: number; cents: number; value: string } => ({
    ...t,
    value: centsToDecimal(t.cents),
  });
  return `${JSON.stringify(
    {
      ...report,
      parity: report.parity.map((w) => ({
        ...w,
        source: money(w.source),
        stored: money(w.stored),
      })),
      byAttendant: report.byAttendant.map((a) => ({
        ...a,
        source: money(a.source),
        stored: money(a.stored),
      })),
    },
    null,
    2,
  )}\n`;
}
