/**
 * Acesso a dados de `insurances` (SCHEMA.md §18). SEM regra de negocio
 * (CONVENTIONS.md "Backend"): quem decide papel e conflito e o
 * `InsuranceService`.
 *
 * Todo metodo abre `db.withTenant(tenantId, ...)` — camada 3 do isolamento
 * (SECURITY.md). Nenhum caminho aqui usa `withoutTenant()`: convenio e dado de
 * laboratorio e o RLS falha fechado sem contexto de tenant.
 */
import type { Insurance, InsuranceType } from '@crm-lab/shared';
import type { DbClient, DbTx } from '../db/types.js';

/** Colunas ordenaveis expostas na query string -> coluna real (whitelist). */
const SORTABLE_COLUMNS = {
  name: 'name',
  type: 'type',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
} as const;

export type InsuranceSortBy = keyof typeof SORTABLE_COLUMNS;
export type SortOrder = 'asc' | 'desc';

export function isInsuranceSortBy(value: string): value is InsuranceSortBy {
  return Object.prototype.hasOwnProperty.call(SORTABLE_COLUMNS, value);
}

/**
 * Dobra de acentos em SQL. `unaccent` e uma extensao que nem sempre esta
 * instalada (e nao esta no PGlite dos testes), entao a dobra usa `translate`,
 * que e core. Mesma tecnica de `exam.repository.ts`.
 */
const ACCENTED = 'áàâãäéèêëíìîïóòôõöúùûüçñ';
const PLAIN = 'aaaaaeeeeiiiiooooouuuucn';

function folded(expression: string): string {
  return `translate(lower(${expression}), '${ACCENTED}', '${PLAIN}')`;
}

/** Mesma dobra do SQL, aplicada ao termo de busca antes de virar parametro. */
export function foldSearchTerm(term: string): string {
  let out = '';
  for (const char of term.toLowerCase()) {
    const index = ACCENTED.indexOf(char);
    out += index >= 0 ? PLAIN[index] : char;
  }
  return out;
}

/** `%` e `_` sao curingas de LIKE: o usuario digitou texto, nao um padrao. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

const COLUMNS = `id, name, official_name, ans_code, type, is_active, created_at, updated_at`;

interface InsuranceRow {
  id: string;
  name: string;
  official_name: string | null;
  ans_code: string | null;
  type: InsuranceType;
  is_active: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

/** ISO 8601 UTC no fio (CLAUDE.md regra 9). */
function isoDateTime(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toInsurance(row: InsuranceRow): Insurance {
  return {
    id: row.id,
    name: row.name,
    officialName: row.official_name,
    ansCode: row.ans_code,
    type: row.type,
    isActive: row.is_active,
    createdAt: isoDateTime(row.created_at),
    updatedAt: isoDateTime(row.updated_at),
  };
}

export interface InsuranceListCriteria {
  active?: boolean;
  search?: string;
  page: number;
  limit: number;
  sortBy: InsuranceSortBy;
  order: SortOrder;
}

export interface InsurancePage {
  rows: Insurance[];
  total: number;
}

export interface InsuranceInsert {
  name: string;
  officialName: string | null;
  ansCode: string | null;
  type: InsuranceType;
}

export interface InsurancePatch {
  name?: string;
  officialName?: string | null;
  ansCode?: string | null;
  type?: InsuranceType;
  isActive?: boolean;
}

/** Colunas de `InsurancePatch` -> coluna fisica. Whitelist: nada dinamico no SQL. */
const PATCH_COLUMNS: Record<keyof InsurancePatch, string> = {
  name: 'name',
  officialName: 'official_name',
  ansCode: 'ans_code',
  type: 'type',
  isActive: 'is_active',
};

/** SQLSTATE de violacao de unicidade — o service converte para CONFLICT. */
export const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { code?: unknown; cause?: unknown };
  if (candidate.code === UNIQUE_VIOLATION) return true;
  // PGlite embrulha o erro do servidor em `cause` em alguns caminhos.
  return isUniqueViolation(candidate.cause);
}

export class InsuranceRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Uma pagina de convenios + o total que casa com os MESMOS filtros. O
   * `WHERE` e montado uma vez e reaproveitado pelo COUNT.
   */
  async list(tenantId: string, criteria: InsuranceListCriteria): Promise<InsurancePage> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (criteria.active !== undefined) {
      params.push(criteria.active);
      where.push(`is_active = $${params.length}`);
    }
    if (criteria.search !== undefined && criteria.search.length > 0) {
      params.push(`%${escapeLike(foldSearchTerm(criteria.search))}%`);
      const pattern = `$${params.length}::text`;
      // Busca por nome E por razao social, sem caixa e sem acento (API_CONTRACTS.md §8).
      where.push(
        `(${folded('name')} LIKE ${pattern} ESCAPE '\\' OR ` +
          `${folded("COALESCE(official_name, '')")} LIKE ${pattern} ESCAPE '\\')`,
      );
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const direction = criteria.order === 'desc' ? 'DESC' : 'ASC';
    // `id` como desempate: sem ele a paginacao pode repetir/pular linhas.
    const orderSql = `ORDER BY ${SORTABLE_COLUMNS[criteria.sortBy]} ${direction}, id ASC`;

    return this.db.withTenant(tenantId, async (tx) => {
      const counted = await tx.query<{ total: number | string }>(
        `SELECT COUNT(*)::int AS total FROM insurances ${whereSql}`,
        params,
      );
      const total = Number(counted.rows[0]?.total ?? 0);

      const offset = (criteria.page - 1) * criteria.limit;
      const paged = await tx.query<InsuranceRow>(
        `SELECT ${COLUMNS} FROM insurances ${whereSql} ${orderSql}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, criteria.limit, offset],
      );

      return { rows: paged.rows.map(toInsurance), total };
    });
  }

  async findById(tenantId: string, id: string): Promise<Insurance | null> {
    return this.db.withTenant(tenantId, (tx) => selectOne(tx, id));
  }

  /** `true` quando o tenant ja tem um convenio com este nome. */
  async nameExists(tenantId: string, name: string): Promise<boolean> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        'SELECT id FROM insurances WHERE name = $1 LIMIT 1',
        [name],
      );
      return result.rows.length > 0;
    });
  }

  async insert(tenantId: string, data: InsuranceInsert): Promise<Insurance> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<InsuranceRow>(
        `INSERT INTO insurances (tenant_id, name, official_name, ans_code, type, is_active)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         RETURNING ${COLUMNS}`,
        [tenantId, data.name, data.officialName, data.ansCode, data.type],
      );
      const row = result.rows[0];
      if (!row) throw new Error('INSERT em insurances nao retornou linha');
      return toInsurance(row);
    });
  }

  /**
   * Aplica o patch. Devolve `null` quando o id nao existe NESTE tenant — o RLS
   * ja torna a linha de outro tenant invisivel, e o service converte isso em
   * `NOT_FOUND` (nunca `FORBIDDEN`; CLAUDE.md regra 8).
   */
  async update(tenantId: string, id: string, patch: InsurancePatch): Promise<Insurance | null> {
    const assignments: string[] = [];
    const params: unknown[] = [];

    for (const key of Object.keys(PATCH_COLUMNS) as Array<keyof InsurancePatch>) {
      const value = patch[key];
      if (value === undefined) continue;
      params.push(value);
      assignments.push(`${PATCH_COLUMNS[key]} = $${params.length}`);
    }

    return this.db.withTenant(tenantId, async (tx) => {
      if (assignments.length === 0) return selectOne(tx, id);
      params.push(id);
      const result = await tx.query<InsuranceRow>(
        `UPDATE insurances SET ${assignments.join(', ')}, updated_at = NOW()
         WHERE id = $${params.length}
         RETURNING ${COLUMNS}`,
        params,
      );
      const row = result.rows[0];
      return row ? toInsurance(row) : null;
    });
  }
}

async function selectOne(tx: DbTx, id: string): Promise<Insurance | null> {
  const result = await tx.query<InsuranceRow>(`SELECT ${COLUMNS} FROM insurances WHERE id = $1`, [
    id,
  ]);
  const row = result.rows[0];
  return row ? toInsurance(row) : null;
}
