/**
 * Acesso a dados de `exam_packages`/`exam_package_items`/`exam_package_prices`
 * (CRMLAB-10). SEM regra de negocio (CONVENTIONS.md "Backend"): quem decide
 * cache, conflito e permissao e o `ExamPackageService`.
 *
 * Mesmo padrao de `exam.repository.ts`: todo metodo abre
 * `db.withTenant(tenantId, ...)` — camada 3 do isolamento (SECURITY.md).
 * Nenhum caminho aqui usa `withoutTenant()`.
 */
import type { DbClient, DbTx } from '../db/types.js';
import type { ExamPackage, ExamPackageItem, ExamPackagePrice } from '@crm-lab/shared';
import { calculatePackagePrivatePrice } from '@crm-lab/shared';

/** Colunas ordenaveis expostas na query string -> coluna real (whitelist). */
const SORTABLE_COLUMNS = {
  name: 'p.name',
  discountPercent: 'p.discount_percent',
  createdAt: 'p.created_at',
  updatedAt: 'p.updated_at',
} as const;

export type ExamPackageSortBy = keyof typeof SORTABLE_COLUMNS;
export type SortOrder = 'asc' | 'desc';

export function isExamPackageSortBy(value: string): value is ExamPackageSortBy {
  return Object.prototype.hasOwnProperty.call(SORTABLE_COLUMNS, value);
}

/** Mesma dobra de acento/caixa de `exam.repository.ts` — catalogo em portugues. */
const ACCENTED = 'áàâãäéèêëíìîïóòôõöúùûüçñ';
const PLAIN = 'aaaaaeeeeiiiiooooouuuucn';

function folded(expression: string): string {
  return `translate(lower(${expression}), '${ACCENTED}', '${PLAIN}')`;
}

export function foldSearchTerm(term: string): string {
  let out = '';
  for (const char of term.toLowerCase()) {
    const index = ACCENTED.indexOf(char);
    out += index >= 0 ? PLAIN[index] : char;
  }
  return out;
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

const BASE_COLUMNS = `p.id, p.name, p.discount_percent, p.is_active, p.created_at, p.updated_at`;

/**
 * `LEFT JOIN LATERAL` que agrega os itens (exames incluidos) numa unica
 * coluna JSON — mesmo espirito do `SYNONYMS_JOIN` de `exam.repository.ts`.
 * O JOIN com `exam_catalog` traz nome/codigo/preco CORRENTES do exame: o
 * pacote nunca guarda snapshot, so referencias (D-004 do pacote e "nao
 * deletar o cadastro", nao "congelar preco" — quem congela preco e a
 * proposta).
 */
const ITEMS_JOIN = `LEFT JOIN LATERAL (
  SELECT json_agg(
    json_build_object(
      'examId', e.id, 'examName', e.name, 'examCode', e.code, 'pricePrivate', e.price_private
    ) ORDER BY e.name
  ) AS data
  FROM exam_package_items epi
  JOIN exam_catalog e ON e.id = epi.exam_id AND e.tenant_id = epi.tenant_id
  WHERE epi.tenant_id = p.tenant_id AND epi.package_id = p.id
) items ON true`;

const ITEMS_COLUMN = `COALESCE(items.data, '[]') AS items_json`;

interface ExamPackageRow {
  id: string;
  name: string;
  discount_percent: number | string;
  is_active: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  items_json: ExamPackageItem[] | string;
  /** Presentes SO quando a query juntou `exam_package_prices` (`?insuranceId=`). */
  effective_price?: number | string | null;
  price_source?: 'insurance' | 'private' | null;
}

function isoDateTime(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function money(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

function parseItems(raw: ExamPackageItem[] | string): ExamPackageItem[] {
  const parsed = typeof raw === 'string' ? (JSON.parse(raw) as ExamPackageItem[]) : raw;
  return parsed.map((item) => ({
    examId: item.examId,
    examName: item.examName,
    examCode: item.examCode,
    pricePrivate: money(item.pricePrivate as unknown as number),
  }));
}

export function toExamPackage(row: ExamPackageRow): ExamPackage {
  const items = parseItems(row.items_json);
  const discountPercent = money(row.discount_percent);
  const pkg: ExamPackage = {
    id: row.id,
    name: row.name,
    discountPercent,
    items,
    pricePrivate: calculatePackagePrivatePrice(items, discountPercent),
    isActive: row.is_active,
    createdAt: isoDateTime(row.created_at),
    updatedAt: isoDateTime(row.updated_at),
  };
  // Aditivo: so aparece quando a query juntou `exam_package_prices` (`?insuranceId=`).
  if (row.effective_price !== undefined && row.effective_price !== null) {
    pkg.effectivePrice = money(row.effective_price);
    pkg.priceSource = row.price_source === 'insurance' ? 'insurance' : 'private';
  }
  return pkg;
}

export interface ExamPackageListCriteria {
  active?: boolean;
  search?: string;
  /** Acrescenta effectivePrice/priceSource a cada item do resultado. */
  insuranceId?: string;
  page: number;
  limit: number;
  sortBy: ExamPackageSortBy;
  order: SortOrder;
}

export interface ExamPackagePage {
  rows: ExamPackage[];
  total: number;
}

export interface ExamPackageInsert {
  name: string;
  discountPercent: number;
  examIds: string[];
}

export interface ExamPackagePatch {
  name?: string;
  discountPercent?: number;
  isActive?: boolean;
  /** Presente => substitui o conjunto inteiro de exames incluidos (semantica de PUT). */
  examIds?: string[];
}

const PATCH_COLUMNS: Record<Exclude<keyof ExamPackagePatch, 'examIds'>, string> = {
  name: 'name',
  discountPercent: 'discount_percent',
  isActive: 'is_active',
};

/** SQLSTATE de violacao de unicidade — o service converte para CONFLICT. */
export const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { code?: unknown; cause?: unknown };
  if (candidate.code === UNIQUE_VIOLATION) return true;
  return isUniqueViolation(candidate.cause);
}

interface ExamPackagePriceRow {
  insurance_id: string;
  price: number | string;
}

function toExamPackagePrice(row: ExamPackagePriceRow): ExamPackagePrice {
  return { insuranceId: row.insurance_id, price: money(row.price) };
}

export class ExamPackageRepository {
  constructor(private readonly db: DbClient) {}

  async list(tenantId: string, criteria: ExamPackageListCriteria): Promise<ExamPackagePage> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (criteria.active !== undefined) {
      params.push(criteria.active);
      where.push(`p.is_active = $${params.length}`);
    }
    if (criteria.search !== undefined && criteria.search.length > 0) {
      params.push(`%${escapeLike(foldSearchTerm(criteria.search))}%`);
      where.push(`${folded('p.name')} LIKE $${params.length}::text ESCAPE '\\'`);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const direction = criteria.order === 'desc' ? 'DESC' : 'ASC';
    const orderSql = `ORDER BY ${SORTABLE_COLUMNS[criteria.sortBy]} ${direction}, p.id ASC`;

    return this.db.withTenant(tenantId, async (tx) => {
      const counted = await tx.query<{ total: number | string }>(
        `SELECT COUNT(*)::int AS total FROM exam_packages p ${whereSql}`,
        params,
      );
      const total = Number(counted.rows[0]?.total ?? 0);

      const pageParams = [...params];
      let priceJoin = '';
      let priceColumns = '';
      if (criteria.insuranceId !== undefined) {
        pageParams.push(criteria.insuranceId);
        priceJoin = `LEFT JOIN exam_package_prices epp ON epp.tenant_id = p.tenant_id AND epp.package_id = p.id AND epp.insurance_id = $${pageParams.length}`;
        priceColumns = `, epp.price AS raw_price`;
      }

      const offset = (criteria.page - 1) * criteria.limit;
      pageParams.push(criteria.limit, offset);
      const paged = await tx.query<ExamPackageRow & { raw_price?: number | string | null }>(
        `SELECT ${BASE_COLUMNS}, ${ITEMS_COLUMN}${priceColumns}
         FROM exam_packages p
         ${ITEMS_JOIN}
         ${priceJoin}
         ${whereSql} ${orderSql}
         LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
        pageParams,
      );

      const rows = paged.rows.map((row) => {
        const pkg = toExamPackage(row);
        if (criteria.insuranceId !== undefined) {
          const rawPrice = row.raw_price;
          const fallback = pkg.pricePrivate;
          pkg.effectivePrice = rawPrice !== undefined && rawPrice !== null ? money(rawPrice) : fallback;
          pkg.priceSource = rawPrice !== undefined && rawPrice !== null ? 'insurance' : 'private';
        }
        return pkg;
      });

      return { rows, total };
    });
  }

  /** Busca por ids — ATIVOS E INATIVOS (mesmo motivo de `ExamRepository.findByIds`). */
  async findByIds(tenantId: string, ids: string[], insuranceId?: string): Promise<ExamPackage[]> {
    if (ids.length === 0) return [];
    return this.db.withTenant(tenantId, async (tx) => {
      const params: unknown[] = [ids];
      let priceJoin = '';
      let priceColumns = '';
      if (insuranceId !== undefined) {
        params.push(insuranceId);
        priceJoin = `LEFT JOIN exam_package_prices epp ON epp.tenant_id = p.tenant_id AND epp.package_id = p.id AND epp.insurance_id = $${params.length}`;
        priceColumns = `, epp.price AS raw_price`;
      }

      const result = await tx.query<ExamPackageRow & { raw_price?: number | string | null }>(
        `SELECT ${BASE_COLUMNS}, ${ITEMS_COLUMN}${priceColumns}
         FROM exam_packages p
         ${ITEMS_JOIN}
         ${priceJoin}
         WHERE p.id = ANY($1::uuid[])`,
        params,
      );
      return result.rows.map((row) => {
        const pkg = toExamPackage(row);
        if (insuranceId !== undefined) {
          const rawPrice = row.raw_price;
          const fallback = pkg.pricePrivate;
          pkg.effectivePrice = rawPrice !== undefined && rawPrice !== null ? money(rawPrice) : fallback;
          pkg.priceSource = rawPrice !== undefined && rawPrice !== null ? 'insurance' : 'private';
        }
        return pkg;
      });
    });
  }

  async findById(tenantId: string, id: string): Promise<ExamPackage | null> {
    const found = await this.findByIds(tenantId, [id]);
    return found[0] ?? null;
  }

  async nameExists(tenantId: string, name: string): Promise<boolean> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        'SELECT id FROM exam_packages WHERE name = $1 LIMIT 1',
        [name],
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

  /** Ids de `examIds` que existem NESTE tenant e estao ATIVOS — o resto e invalido. */
  async activeExamIds(tenantId: string, examIds: string[]): Promise<Set<string>> {
    if (examIds.length === 0) return new Set();
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        'SELECT id FROM exam_catalog WHERE id = ANY($1::uuid[]) AND is_active = TRUE',
        [examIds],
      );
      return new Set(result.rows.map((row) => row.id));
    });
  }

  async insert(tenantId: string, data: ExamPackageInsert): Promise<ExamPackage> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        `INSERT INTO exam_packages (tenant_id, name, discount_percent, is_active)
         VALUES ($1, $2, $3, TRUE)
         RETURNING id`,
        [tenantId, data.name, data.discountPercent],
      );
      const row = result.rows[0];
      if (!row) throw new Error('INSERT em exam_packages nao retornou linha');

      await replaceItems(tx, tenantId, row.id, data.examIds);

      const pkg = await selectOne(tx, row.id);
      if (!pkg) throw new Error('Pacote recem-criado nao encontrado apos INSERT');
      return pkg;
    });
  }

  /**
   * Aplica o patch. Devolve `null` quando o id nao existe NESTE tenant — o RLS
   * ja torna a linha de outro tenant invisivel, e o service converte isso em
   * `NOT_FOUND` (nunca `FORBIDDEN`; CLAUDE.md regra 8).
   */
  async update(tenantId: string, id: string, patch: ExamPackagePatch): Promise<ExamPackage | null> {
    const assignments: string[] = [];
    const params: unknown[] = [];

    for (const key of Object.keys(PATCH_COLUMNS) as Array<Exclude<keyof ExamPackagePatch, 'examIds'>>) {
      const value = patch[key];
      if (value === undefined) continue;
      params.push(value);
      assignments.push(`${PATCH_COLUMNS[key]} = $${params.length}`);
    }

    return this.db.withTenant(tenantId, async (tx) => {
      if (assignments.length > 0) {
        params.push(id);
        const result = await tx.query<{ id: string }>(
          `UPDATE exam_packages SET ${assignments.join(', ')}, updated_at = NOW()
           WHERE id = $${params.length}
           RETURNING id`,
          params,
        );
        if (!result.rows[0]) return null;
      } else {
        const exists = await tx.query<{ id: string }>('SELECT id FROM exam_packages WHERE id = $1', [
          id,
        ]);
        if (!exists.rows[0]) return null;
      }

      if (patch.examIds !== undefined) {
        await replaceItems(tx, tenantId, id, patch.examIds);
      }

      return selectOne(tx, id);
    });
  }

  async findPrices(tenantId: string, packageId: string): Promise<ExamPackagePrice[]> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<ExamPackagePriceRow>(
        'SELECT insurance_id, price FROM exam_package_prices WHERE package_id = $1 ORDER BY insurance_id',
        [packageId],
      );
      return result.rows.map(toExamPackagePrice);
    });
  }

  async upsertPrices(
    tenantId: string,
    packageId: string,
    prices: Array<{ insuranceId: string; price: number }>,
  ): Promise<ExamPackagePrice[]> {
    return this.db.withTenant(tenantId, async (tx) => {
      await tx.query('DELETE FROM exam_package_prices WHERE tenant_id = $1 AND package_id = $2', [
        tenantId,
        packageId,
      ]);
      for (const item of prices) {
        await tx.query(
          `INSERT INTO exam_package_prices (tenant_id, package_id, insurance_id, price)
           VALUES ($1, $2, $3, $4)`,
          [tenantId, packageId, item.insuranceId, item.price],
        );
      }
      const result = await tx.query<ExamPackagePriceRow>(
        'SELECT insurance_id, price FROM exam_package_prices WHERE package_id = $1 ORDER BY insurance_id',
        [packageId],
      );
      return result.rows.map(toExamPackagePrice);
    });
  }
}

/**
 * Regrava o conjunto de exames incluidos (delete-then-insert). Sempre chamada
 * DENTRO da transacao do INSERT/UPDATE do pacote — nunca abre a sua propria.
 */
async function replaceItems(
  tx: DbTx,
  tenantId: string,
  packageId: string,
  examIds: string[],
): Promise<void> {
  await tx.query('DELETE FROM exam_package_items WHERE tenant_id = $1 AND package_id = $2', [
    tenantId,
    packageId,
  ]);
  const unique = [...new Set(examIds)];
  for (const examId of unique) {
    await tx.query(
      'INSERT INTO exam_package_items (tenant_id, package_id, exam_id) VALUES ($1, $2, $3)',
      [tenantId, packageId, examId],
    );
  }
}

async function selectOne(tx: DbTx, id: string): Promise<ExamPackage | null> {
  const result = await tx.query<ExamPackageRow>(
    `SELECT ${BASE_COLUMNS}, ${ITEMS_COLUMN}
     FROM exam_packages p
     ${ITEMS_JOIN}
     WHERE p.id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? toExamPackage(row) : null;
}
