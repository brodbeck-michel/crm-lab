/**
 * Acesso a dados de `exam_catalog`. SEM regra de negocio (CONVENTIONS.md
 * "Backend"): quem decide cache, conflito e permissao e o `ExamCatalogService`.
 *
 * Todo metodo abre `db.withTenant(tenantId, ...)` — camada 3 do isolamento
 * (SECURITY.md). Nenhum caminho aqui usa `withoutTenant()`: o catalogo e dado
 * de laboratorio e o RLS falha fechado sem contexto de tenant.
 *
 * Onda 7 (D-081/D-082/D-083): TUSS/AMB/material/source (colunas simples de
 * `exam_catalog`), sinonimos (`exam_synonyms`, SCHEMA.md §20) e preco por
 * convenio (`exam_prices`, SCHEMA.md §19). Todo SELECT usa o alias `e` para
 * `exam_catalog` porque o LEFT JOIN com `exam_prices` introduz uma segunda
 * coluna `id` — sem alias o Postgres recusa a query como ambigua.
 */
import type { Exam, ExamPrice, ExamSource } from '@crm-lab/shared';
import type { DbClient, DbTx } from '../db/types.js';

/** Colunas ordenaveis expostas na query string -> coluna real (whitelist). */
const SORTABLE_COLUMNS = {
  name: 'e.name',
  code: 'e.code',
  category: 'e.category',
  pricePrivate: 'e.price_private',
  priceInsurance: 'e.price_insurance',
  createdAt: 'e.created_at',
  updatedAt: 'e.updated_at',
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

/** Colunas simples de `exam_catalog`, sempre com o alias `e`. */
const BASE_COLUMNS = `e.id, e.name, e.code, e.description, e.preparation, e.turnaround_hours,
                       e.price_private, e.price_insurance, e.category, e.is_active,
                       e.tuss_code, e.amb_code, e.material, e.source,
                       e.created_at, e.updated_at`;

/**
 * `LEFT JOIN LATERAL` que agrega os sinonimos do exame numa unica coluna
 * array. `LATERAL` porque a subquery referencia `e.id`/`e.tenant_id` da linha
 * corrente — um JOIN comum nao permitiria isso sem duplicar linhas de `e`.
 */
const SYNONYMS_JOIN = `LEFT JOIN LATERAL (
  SELECT array_agg(s.synonym ORDER BY s.synonym) AS synonyms
  FROM exam_synonyms s
  WHERE s.tenant_id = e.tenant_id AND s.exam_id = e.id
) syn ON true`;

const SYNONYMS_COLUMN = `COALESCE(syn.synonyms, '{}') AS synonyms`;

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
  tuss_code: string | null;
  amb_code: string | null;
  material: string | null;
  source: string;
  synonyms: string[] | null;
  created_at: Date | string;
  updated_at: Date | string;
  /** Presentes SO quando a query juntou `exam_prices` (`?insuranceId=`). */
  effective_price?: number | string | null;
  price_source?: 'insurance' | 'private' | null;
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
  const exam: Exam = {
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
    tussCode: row.tuss_code,
    ambCode: row.amb_code,
    material: row.material,
    source: row.source as ExamSource,
    synonyms: row.synonyms ?? [],
    createdAt: isoDateTime(row.created_at),
    updatedAt: isoDateTime(row.updated_at),
  };
  // Aditivo: so aparece quando a query juntou `exam_prices` (`?insuranceId=`).
  if (row.effective_price !== undefined && row.effective_price !== null) {
    exam.effectivePrice = money(row.effective_price);
    exam.priceSource = row.price_source === 'insurance' ? 'insurance' : 'private';
  }
  return exam;
}

export interface ExamListCriteria {
  active?: boolean;
  category?: string;
  search?: string;
  /** Onda 7: acrescenta effectivePrice/priceSource a cada item do resultado. */
  insuranceId?: string;
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
  tussCode: string | null;
  ambCode: string | null;
  material: string | null;
  /** Gravado em `exam_synonyms` na MESMA transacao do INSERT. */
  synonyms: string[];
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
  tussCode?: string | null;
  ambCode?: string | null;
  material?: string | null;
  /**
   * Presente => substitui o conjunto inteiro (semantica de PUT sobre a
   * colecao filha). Ausente => sinonimos atuais preservados.
   */
  synonyms?: string[];
}

/** Colunas simples de `ExamPatch` -> coluna fisica. `synonyms` fica de fora: nao e coluna, e tabela filha. */
const PATCH_COLUMNS: Record<Exclude<keyof ExamPatch, 'synonyms'>, string> = {
  name: 'name',
  description: 'description',
  preparation: 'preparation',
  turnaroundHours: 'turnaround_hours',
  pricePrivate: 'price_private',
  priceInsurance: 'price_insurance',
  category: 'category',
  isActive: 'is_active',
  tussCode: 'tuss_code',
  ambCode: 'amb_code',
  material: 'material',
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

interface ExamPriceRow {
  insurance_id: string;
  price: number | string;
}

function toExamPrice(row: ExamPriceRow): ExamPrice {
  return { insuranceId: row.insurance_id, price: money(row.price) };
}

export class ExamRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Uma pagina do catalogo + o total que casa com os MESMOS filtros.
   * O `WHERE` e montado uma vez e reaproveitado pelo COUNT (que NAO precisa
   * dos joins de sinonimo/preco: eles so afetam colunas de saida, nunca o
   * conjunto de linhas).
   */
  async list(tenantId: string, criteria: ExamListCriteria): Promise<ExamPage> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (criteria.active !== undefined) {
      params.push(criteria.active);
      where.push(`e.is_active = $${params.length}`);
    }
    if (criteria.category !== undefined && criteria.category.length > 0) {
      params.push(foldSearchTerm(criteria.category));
      where.push(`${folded('e.category')} = $${params.length}::text`);
    }
    if (criteria.search !== undefined && criteria.search.length > 0) {
      params.push(`%${escapeLike(foldSearchTerm(criteria.search))}%`);
      const pattern = `$${params.length}::text`;
      // Busca por nome, codigo E sinonimo (Onda 7), sem caixa e sem acento.
      where.push(
        `(${folded('e.name')} LIKE ${pattern} ESCAPE '\\' OR ` +
          `${folded('e.code')} LIKE ${pattern} ESCAPE '\\' OR ` +
          `EXISTS (SELECT 1 FROM exam_synonyms es WHERE es.tenant_id = e.tenant_id ` +
          `AND es.exam_id = e.id AND ${folded('es.synonym')} LIKE ${pattern} ESCAPE '\\'))`,
      );
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const direction = criteria.order === 'desc' ? 'DESC' : 'ASC';
    // `e.id` como desempate: sem ele a paginacao pode repetir/pular linhas.
    const orderSql = `ORDER BY ${SORTABLE_COLUMNS[criteria.sortBy]} ${direction}, e.id ASC`;

    return this.db.withTenant(tenantId, async (tx) => {
      const counted = await tx.query<{ total: number | string }>(
        `SELECT COUNT(*)::int AS total FROM exam_catalog e ${whereSql}`,
        params,
      );
      const total = Number(counted.rows[0]?.total ?? 0);

      const pageParams = [...params];
      let priceJoin = '';
      let priceColumns = '';
      if (criteria.insuranceId !== undefined) {
        pageParams.push(criteria.insuranceId);
        priceJoin = `LEFT JOIN exam_prices ep ON ep.tenant_id = e.tenant_id AND ep.exam_id = e.id AND ep.insurance_id = $${pageParams.length}`;
        priceColumns = `, COALESCE(ep.price, e.price_private) AS effective_price,
          CASE WHEN ep.price IS NOT NULL THEN 'insurance' ELSE 'private' END AS price_source`;
      }

      const offset = (criteria.page - 1) * criteria.limit;
      pageParams.push(criteria.limit, offset);
      const paged = await tx.query<ExamRow>(
        `SELECT ${BASE_COLUMNS}, ${SYNONYMS_COLUMN}${priceColumns}
         FROM exam_catalog e
         ${SYNONYMS_JOIN}
         ${priceJoin}
         ${whereSql} ${orderSql}
         LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
        pageParams,
      );

      return { rows: paged.rows.map(toExam), total };
    });
  }

  /**
   * Busca por ids — ATIVOS E INATIVOS. Quem precisa so dos ativos filtra
   * depois: propostas historicas referenciam exames desativados (D-004) e
   * precisam continuar conseguindo le-los.
   *
   * Onda 7: `insuranceId` opcional acrescenta `effectivePrice`/`priceSource`
   * a cada exame, com o mesmo fallback de `list`. E o caminho que
   * `resolveActiveByIds` usa para precificar por convenio.
   */
  async findByIds(tenantId: string, ids: string[], insuranceId?: string): Promise<Exam[]> {
    if (ids.length === 0) return [];
    return this.db.withTenant(tenantId, async (tx) => {
      const params: unknown[] = [ids];
      let priceJoin = '';
      let priceColumns = '';
      if (insuranceId !== undefined) {
        params.push(insuranceId);
        priceJoin = `LEFT JOIN exam_prices ep ON ep.tenant_id = e.tenant_id AND ep.exam_id = e.id AND ep.insurance_id = $${params.length}`;
        priceColumns = `, COALESCE(ep.price, e.price_private) AS effective_price,
          CASE WHEN ep.price IS NOT NULL THEN 'insurance' ELSE 'private' END AS price_source`;
      }

      const result = await tx.query<ExamRow>(
        `SELECT ${BASE_COLUMNS}, ${SYNONYMS_COLUMN}${priceColumns}
         FROM exam_catalog e
         ${SYNONYMS_JOIN}
         ${priceJoin}
         WHERE e.id = ANY($1::uuid[])`,
        params,
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

  /** `true` quando existe convenio ATIVO com este id no tenant — checagem do upsert de preco. */
  async activeInsuranceExists(tenantId: string, insuranceId: string): Promise<boolean> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        'SELECT id FROM insurances WHERE id = $1 AND is_active = TRUE LIMIT 1',
        [insuranceId],
      );
      return result.rows.length > 0;
    });
  }

  async insert(tenantId: string, data: ExamInsert): Promise<Exam> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        `INSERT INTO exam_catalog
           (tenant_id, name, code, description, preparation, turnaround_hours,
            price_private, price_insurance, category, tuss_code, amb_code, material, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, TRUE)
         RETURNING id`,
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
          data.tussCode,
          data.ambCode,
          data.material,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('INSERT em exam_catalog nao retornou linha');

      await replaceSynonyms(tx, tenantId, row.id, data.synonyms);

      const exam = await selectOne(tx, row.id);
      if (!exam) throw new Error('Exame recem-criado nao encontrado apos INSERT');
      return exam;
    });
  }

  /**
   * Aplica o patch. Devolve `null` quando o id nao existe NESTE tenant — o RLS
   * ja torna a linha de outro tenant invisivel, e o service converte isso em
   * `NOT_FOUND` (nunca `FORBIDDEN`; CLAUDE.md regra 8).
   *
   * `patch.synonyms`, quando presente, substitui o conjunto na MESMA
   * transacao (semantica de PUT sobre a colecao filha).
   */
  async update(tenantId: string, id: string, patch: ExamPatch): Promise<Exam | null> {
    const assignments: string[] = [];
    const params: unknown[] = [];

    for (const key of Object.keys(PATCH_COLUMNS) as Array<Exclude<keyof ExamPatch, 'synonyms'>>) {
      const value = patch[key];
      if (value === undefined) continue;
      params.push(value);
      assignments.push(`${PATCH_COLUMNS[key]} = $${params.length}`);
    }

    return this.db.withTenant(tenantId, async (tx) => {
      if (assignments.length > 0) {
        params.push(id);
        const result = await tx.query<{ id: string }>(
          `UPDATE exam_catalog SET ${assignments.join(', ')}, updated_at = NOW()
           WHERE id = $${params.length}
           RETURNING id`,
          params,
        );
        if (!result.rows[0]) return null;
      } else {
        // Nenhuma coluna simples mudou (ex.: PATCH so com `synonyms`) — o
        // exame ainda precisa existir NESTE tenant para a escrita prosseguir.
        const exists = await tx.query<{ id: string }>(
          'SELECT id FROM exam_catalog WHERE id = $1',
          [id],
        );
        if (!exists.rows[0]) return null;
      }

      if (patch.synonyms !== undefined) {
        await replaceSynonyms(tx, tenantId, id, patch.synonyms);
      }

      return selectOne(tx, id);
    });
  }

  /** Onda 7. Uma linha por convenio COM preco cadastrado para este exame. */
  async findPrices(tenantId: string, examId: string): Promise<ExamPrice[]> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<ExamPriceRow>(
        'SELECT insurance_id, price FROM exam_prices WHERE exam_id = $1 ORDER BY insurance_id',
        [examId],
      );
      return result.rows.map(toExamPrice);
    });
  }

  /**
   * Upsert em lote — semantica de PUT (estado completo): linha ausente do
   * corpo e removida. Mesmo padrao transacional de `replaceSynonyms`
   * (delete-then-insert, dentro de UMA transacao).
   */
  async upsertPrices(
    tenantId: string,
    examId: string,
    prices: Array<{ insuranceId: string; price: number }>,
  ): Promise<ExamPrice[]> {
    return this.db.withTenant(tenantId, async (tx) => {
      await tx.query('DELETE FROM exam_prices WHERE tenant_id = $1 AND exam_id = $2', [
        tenantId,
        examId,
      ]);
      for (const item of prices) {
        await tx.query(
          `INSERT INTO exam_prices (tenant_id, exam_id, insurance_id, price)
           VALUES ($1, $2, $3, $4)`,
          [tenantId, examId, item.insuranceId, item.price],
        );
      }
      const result = await tx.query<ExamPriceRow>(
        'SELECT insurance_id, price FROM exam_prices WHERE exam_id = $1 ORDER BY insurance_id',
        [examId],
      );
      return result.rows.map(toExamPrice);
    });
  }
}

/**
 * Regrava o conjunto de sinonimos do exame (delete-then-insert). Sempre
 * chamada DENTRO da transacao do INSERT/UPDATE do exame — nunca abre a sua
 * propria. Vazio/duplicado/em branco e normalizado antes de gravar.
 */
async function replaceSynonyms(
  tx: DbTx,
  tenantId: string,
  examId: string,
  synonyms: string[],
): Promise<void> {
  await tx.query('DELETE FROM exam_synonyms WHERE tenant_id = $1 AND exam_id = $2', [
    tenantId,
    examId,
  ]);
  const unique = [...new Set(synonyms.map((s) => s.trim()).filter((s) => s.length > 0))];
  for (const synonym of unique) {
    await tx.query('INSERT INTO exam_synonyms (tenant_id, exam_id, synonym) VALUES ($1, $2, $3)', [
      tenantId,
      examId,
      synonym,
    ]);
  }
}

async function selectOne(tx: DbTx, id: string): Promise<Exam | null> {
  const result = await tx.query<ExamRow>(
    `SELECT ${BASE_COLUMNS}, ${SYNONYMS_COLUMN}
     FROM exam_catalog e
     ${SYNONYMS_JOIN}
     WHERE e.id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? toExam(row) : null;
}
