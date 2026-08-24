/**
 * Acesso a dados de `exam_catalog`. SEM regra de negocio (CONVENTIONS.md
 * "Backend"): quem decide cache, conflito e permissao e o `ExamCatalogService`.
 *
 * Todo metodo abre `db.withTenant(tenantId, ...)` — camada 3 do isolamento
 * (SECURITY.md). Nenhum caminho aqui usa `withoutTenant()`: o catalogo e dado
 * de laboratorio e o RLS falha fechado sem contexto de tenant.
 */
import type { Exam } from '@crm-lab/shared';
import type { DbClient, DbTx } from '../db/types.js';

/** Colunas ordenaveis expostas na query string -> coluna real (whitelist). */
const SORTABLE_COLUMNS = {
  name: 'name',
  code: 'code',
  category: 'category',
  pricePrivate: 'price_private',
  priceInsurance: 'price_insurance',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
} as const;

export type ExamSortBy = keyof typeof SORTABLE_COLUMNS;
export type SortOrder = 'asc' | 'desc';

export function isExamSortBy(value: string): value is ExamSortBy {
  return Object.prototype.hasOwnProperty.call(SORTABLE_COLUMNS, value);
}

/**
 * Dobra de acentos em SQL. O catalogo e em portugues: "glicose" precisa achar
 * "Glicóse". `unaccent` e uma extensao que nem sempre esta instalada (e nao
 * esta no PGlite dos testes), entao a dobra usa `translate`, que e core.
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

const COLUMNS = `id, name, code, description, preparation, turnaround_hours,
                 price_private, price_insurance, category, is_active,
                 created_at, updated_at`;

interface ExamRow {
  id: string;
  name: string;
  code: string;
  description: string | null;
  preparation: string | null;
  turnaround_hours: number | null;
  price_private: number | string;
  price_insurance: number | string;
  category: string | null;
  is_active: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

/** ISO 8601 UTC no fio (CLAUDE.md regra 9). */
function isoDateTime(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Dinheiro no fio e numero decimal, nunca string (CLAUDE.md regra 9). */
function money(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

export function toExam(row: ExamRow): Exam {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    preparation: row.preparation,
    turnaroundHours: row.turnaround_hours === null ? null : Number(row.turnaround_hours),
    pricePrivate: money(row.price_private),
    priceInsurance: money(row.price_insurance),
    category: row.category,
    isActive: row.is_active,
    createdAt: isoDateTime(row.created_at),
    updatedAt: isoDateTime(row.updated_at),
  };
}

export interface ExamListCriteria {
  active?: boolean;
  category?: string;
  search?: string;
  page: number;
  limit: number;
  sortBy: ExamSortBy;
  order: SortOrder;
}

export interface ExamPage {
  rows: Exam[];
  total: number;
}

export interface ExamInsert {
  name: string;
  code: string;
  description: string | null;
  preparation: string | null;
  turnaroundHours: number | null;
  pricePrivate: number;
  priceInsurance: number;
  category: string | null;
}

export interface ExamPatch {
  name?: string;
  description?: string | null;
  preparation?: string | null;
  turnaroundHours?: number | null;
  pricePrivate?: number;
  priceInsurance?: number;
  category?: string | null;
  isActive?: boolean;
}

/** Colunas de `ExamPatch` -> coluna fisica. Whitelist: nada dinamico no SQL. */
const PATCH_COLUMNS: Record<keyof ExamPatch, string> = {
  name: 'name',
  description: 'description',
  preparation: 'preparation',
  turnaroundHours: 'turnaround_hours',
  pricePrivate: 'price_private',
  priceInsurance: 'price_insurance',
  category: 'category',
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

export class ExamRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Uma pagina do catalogo + o total que casa com os MESMOS filtros.
   * O `WHERE` e montado uma vez e reaproveitado pelo COUNT.
   */
  async list(tenantId: string, criteria: ExamListCriteria): Promise<ExamPage> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (criteria.active !== undefined) {
      params.push(criteria.active);
      where.push(`is_active = $${params.length}`);
    }
    if (criteria.category !== undefined && criteria.category.length > 0) {
      params.push(foldSearchTerm(criteria.category));
      where.push(`${folded('category')} = $${params.length}::text`);
    }
    if (criteria.search !== undefined && criteria.search.length > 0) {
      params.push(`%${escapeLike(foldSearchTerm(criteria.search))}%`);
      const pattern = `$${params.length}::text`;
      // Busca por nome E por codigo, sem caixa e sem acento.
      where.push(
        `(${folded('name')} LIKE ${pattern} ESCAPE '\\' OR ` +
          `${folded('code')} LIKE ${pattern} ESCAPE '\\')`,
      );
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const direction = criteria.order === 'desc' ? 'DESC' : 'ASC';
    // `id` como desempate: sem ele a paginacao pode repetir/pular linhas.
    const orderSql = `ORDER BY ${SORTABLE_COLUMNS[criteria.sortBy]} ${direction}, id ASC`;

    return this.db.withTenant(tenantId, async (tx) => {
      const counted = await tx.query<{ total: number | string }>(
        `SELECT COUNT(*)::int AS total FROM exam_catalog ${whereSql}`,
        params,
      );
      const total = Number(counted.rows[0]?.total ?? 0);

      const offset = (criteria.page - 1) * criteria.limit;
      const paged = await tx.query<ExamRow>(
        `SELECT ${COLUMNS} FROM exam_catalog ${whereSql} ${orderSql}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, criteria.limit, offset],
      );

      return { rows: paged.rows.map(toExam), total };
    });
  }

  /**
   * Busca por ids — ATIVOS E INATIVOS. Quem precisa so dos ativos filtra
   * depois: propostas historicas referenciam exames desativados (D-004) e
   * precisam continuar conseguindo le-los.
   */
  async findByIds(tenantId: string, ids: string[]): Promise<Exam[]> {
    if (ids.length === 0) return [];
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<ExamRow>(
        `SELECT ${COLUMNS} FROM exam_catalog WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      return result.rows.map(toExam);
    });
  }

  async findById(tenantId: string, id: string): Promise<Exam | null> {
    const found = await this.findByIds(tenantId, [id]);
    return found[0] ?? null;
  }

  /** `true` quando o tenant ja tem um exame com este codigo. */
  async codeExists(tenantId: string, code: string): Promise<boolean> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        'SELECT id FROM exam_catalog WHERE code = $1 LIMIT 1',
        [code],
      );
      return result.rows.length > 0;
    });
  }

  async insert(tenantId: string, data: ExamInsert): Promise<Exam> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<ExamRow>(
        `INSERT INTO exam_catalog
           (tenant_id, name, code, description, preparation, turnaround_hours,
            price_private, price_insurance, category, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)
         RETURNING ${COLUMNS}`,
        [
          tenantId,
          data.name,
          data.code,
          data.description,
          data.preparation,
          data.turnaroundHours,
          data.pricePrivate,
          data.priceInsurance,
          data.category,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('INSERT em exam_catalog nao retornou linha');
      return toExam(row);
    });
  }

  /**
   * Aplica o patch. Devolve `null` quando o id nao existe NESTE tenant — o RLS
   * ja torna a linha de outro tenant invisivel, e o service converte isso em
   * `NOT_FOUND` (nunca `FORBIDDEN`; CLAUDE.md regra 8).
   */
  async update(tenantId: string, id: string, patch: ExamPatch): Promise<Exam | null> {
    const assignments: string[] = [];
    const params: unknown[] = [];

    for (const key of Object.keys(PATCH_COLUMNS) as Array<keyof ExamPatch>) {
      const value = patch[key];
      if (value === undefined) continue;
      params.push(value);
      assignments.push(`${PATCH_COLUMNS[key]} = $${params.length}`);
    }

    return this.db.withTenant(tenantId, async (tx) => {
      if (assignments.length === 0) return selectOne(tx, id);
      params.push(id);
      const result = await tx.query<ExamRow>(
        `UPDATE exam_catalog SET ${assignments.join(', ')}, updated_at = NOW()
         WHERE id = $${params.length}
         RETURNING ${COLUMNS}`,
        params,
      );
      const row = result.rows[0];
      return row ? toExam(row) : null;
    });
  }
}

async function selectOne(tx: DbTx, id: string): Promise<Exam | null> {
  const result = await tx.query<ExamRow>(
    `SELECT ${COLUMNS} FROM exam_catalog WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? toExam(row) : null;
}
