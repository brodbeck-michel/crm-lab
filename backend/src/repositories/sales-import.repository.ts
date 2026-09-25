/**
 * SQL da carga pontual de vendas dos Supabases (CRMLAB-45, D-179/D-180).
 * SEM regra de negocio: quem decide dedupe, vencedor e rejeicao e o
 * `sales-supabase-import.service`.
 *
 * Tudo roda no `tx` de um `db.withTenant(tenantId)` — o RLS limita cada
 * consulta ao tenant. O `tenant_id = $1` explicito e so defesa em profundidade.
 * A unica excecao e `findTenantIdBySlug` (D-180 item 4).
 */
import type { DbClient, DbTx } from '../db/types.js';

/** Formato textual fixo dos timestamps — comparavel como string (D-180). */
export const TIMESTAMP_TEXT = 'YYYY-MM-DD HH24:MI:SS.US';

/**
 * Resolve `slug -> id` SEM contexto de tenant: e o quarto caso auditado de
 * `withoutTenant` (D-180) — so leitura, so a coluna `id`, CLI de operador.
 */
export async function findTenantIdBySlug(db: DbClient, slug: string): Promise<string | null> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1 AND deleted_at IS NULL', [
      slug,
    ]),
  );
  return result.rows[0]?.id ?? null;
}

/** Dentro de `withTenant(id)`: `true` se o proprio tenant existe (RLS por `id`). */
export async function tenantExists(tx: DbTx, tenantId: string): Promise<boolean> {
  const result = await tx.query<{ id: string }>(
    'SELECT id FROM tenants WHERE id = $1 AND deleted_at IS NULL',
    [tenantId],
  );
  return result.rows.length > 0;
}

export interface AttendantRef {
  id: string;
  name: string;
}

export async function listAttendants(tx: DbTx, tenantId: string): Promise<AttendantRef[]> {
  const result = await tx.query<AttendantRef>(
    'SELECT id, name FROM attendants WHERE tenant_id = $1 ORDER BY created_at, id',
    [tenantId],
  );
  return result.rows;
}

/**
 * Cria o atendente. `ON CONFLICT (tenant_id, folded_name)` cobre a corrida com
 * um cadastro feito pela tela no meio da carga: devolve o id que ja existe.
 */
export async function insertAttendant(tx: DbTx, tenantId: string, name: string): Promise<string> {
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO attendants (tenant_id, name) VALUES ($1, $2)
     ON CONFLICT (tenant_id, folded_name) DO NOTHING
     RETURNING id`,
    [tenantId, name],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM attendants
      WHERE tenant_id = $1 AND folded_name = lower(regexp_replace(trim($2::text), '\\s+', ' ', 'g'))`,
    [tenantId, name],
  );
  const id = existing.rows[0]?.id;
  if (!id) throw new Error(`Nao foi possivel criar nem achar o atendente "${name}"`);
  return id;
}

export async function listUserIds(tx: DbTx, tenantId: string): Promise<Set<string>> {
  const result = await tx.query<{ id: string }>('SELECT id FROM users WHERE tenant_id = $1', [
    tenantId,
  ]);
  return new Set(result.rows.map((r) => r.id));
}

/** `id -> updated_at` (texto em `TIMESTAMP_TEXT`) das vendas do tenant. */
export async function listSaleStamps(tx: DbTx, tenantId: string): Promise<Map<string, string>> {
  const result = await tx.query<{ id: string; updated_at: string }>(
    `SELECT id, to_char(updated_at, '${TIMESTAMP_TEXT}') AS updated_at
       FROM sales WHERE tenant_id = $1`,
    [tenantId],
  );
  return new Map(result.rows.map((r) => [r.id, r.updated_at]));
}

export interface SaleInsert {
  id: string;
  tenantId: string;
  attendantId: string;
  soldOn: string;
  code: string | null;
  /** Decimal em texto (`"123.45"`) — nunca float. */
  value: string;
  exams: string | null;
  kind: 'exams' | 'checkup';
  createdBy: string | null;
  /** UTC em `TIMESTAMP_TEXT`. */
  createdAt: string;
  updatedAt: string;
}

/**
 * `ON CONFLICT (id) DO NOTHING`: se o `id` ja existir em OUTRO tenant (linha
 * invisivel pelo RLS), nada e tocado e a funcao devolve `false` (D-180 item 4).
 */
export async function insertSale(tx: DbTx, sale: SaleInsert): Promise<boolean> {
  const result = await tx.query<{ id: string }>(
    `INSERT INTO sales (id, tenant_id, attendant_id, sold_on, code, value, exams, kind,
                        created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4::date, $5, $6::numeric, $7, $8, $9, $10::timestamp, $11::timestamp)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      sale.id,
      sale.tenantId,
      sale.attendantId,
      sale.soldOn,
      sale.code,
      sale.value,
      sale.exams,
      sale.kind,
      sale.createdBy,
      sale.createdAt,
      sale.updatedAt,
    ],
  );
  return result.rows.length > 0;
}

export async function deleteSale(tx: DbTx, tenantId: string, id: string): Promise<void> {
  await tx.query('DELETE FROM sales WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
}

export interface TotalsRow {
  count: number;
  /** Soma em texto decimal (`numeric`), convertida para centavos pelo service. */
  total: string;
}

/** Contagem e soma das vendas do tenant, opcionalmente num intervalo de `sold_on`. */
export async function saleTotals(
  tx: DbTx,
  tenantId: string,
  range?: { start: string; end: string },
): Promise<TotalsRow> {
  const params: unknown[] = [tenantId];
  let where = 'tenant_id = $1';
  if (range) {
    params.push(range.start, range.end);
    where += ' AND sold_on BETWEEN $2::date AND $3::date';
  }
  const result = await tx.query<{ count: number | string; total: string }>(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(value), 0)::text AS total
       FROM sales WHERE ${where}`,
    params,
  );
  const row = result.rows[0];
  return { count: Number(row?.count ?? 0), total: row?.total ?? '0' };
}

export interface AttendantTotalsRow extends TotalsRow {
  attendantId: string;
  name: string;
}

export async function saleTotalsByAttendant(
  tx: DbTx,
  tenantId: string,
): Promise<AttendantTotalsRow[]> {
  const result = await tx.query<{
    attendant_id: string;
    name: string;
    count: number | string;
    total: string;
  }>(
    `SELECT s.attendant_id, a.name, COUNT(*)::int AS count, SUM(s.value)::text AS total
       FROM sales s JOIN attendants a ON a.id = s.attendant_id
      WHERE s.tenant_id = $1
      GROUP BY s.attendant_id, a.name`,
    [tenantId],
  );
  return result.rows.map((r) => ({
    attendantId: r.attendant_id,
    name: r.name,
    count: Number(r.count),
    total: r.total,
  }));
}
