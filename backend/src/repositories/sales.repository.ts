/**
 * Acesso a dados de `sales` (SCHEMA.md §27, Onda 9). SEM regra de negocio de
 * alcada/escopo — isso vive no `SalesService`; aqui so SQL.
 */
import type { Sale, SaleKind } from '@crm-lab/shared';
import type { DbTx } from '../db/types.js';
import { toIso, toNumber } from './row-mappers.js';

const COLUMNS = `s.id, s.attendant_id, a.name AS attendant_name,
  to_char(s.sold_on, 'YYYY-MM-DD') AS sold_on, s.code, s.value, s.exams, s.kind,
  s.created_by, s.created_at`;

interface SaleRow {
  id: string;
  attendant_id: string;
  attendant_name: string;
  sold_on: string;
  code: string | null;
  value: string | number;
  exams: string | null;
  kind: string;
  created_by: string | null;
  created_at: Date | string;
}

function toSale(row: SaleRow): Sale {
  return {
    id: row.id,
    attendantId: row.attendant_id,
    attendantName: row.attendant_name,
    soldOn: row.sold_on,
    code: row.code,
    value: toNumber(row.value),
    exams: row.exams,
    kind: row.kind as SaleKind,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
  };
}

export interface SalesListCriteria {
  startDate?: string;
  endDate?: string;
  attendantId?: string;
  kind?: SaleKind;
  page: number;
  limit: number;
}

export async function list(
  tx: DbTx,
  tenantId: string,
  criteria: SalesListCriteria,
): Promise<{ rows: Sale[]; total: number }> {
  const where: string[] = ['s.tenant_id = $1'];
  const params: unknown[] = [tenantId];

  if (criteria.startDate !== undefined && criteria.endDate !== undefined) {
    params.push(criteria.startDate, criteria.endDate);
    where.push(`s.sold_on BETWEEN $${params.length - 1} AND $${params.length}`);
  }
  if (criteria.attendantId !== undefined) {
    params.push(criteria.attendantId);
    where.push(`s.attendant_id = $${params.length}`);
  }
  if (criteria.kind !== undefined) {
    params.push(criteria.kind);
    where.push(`s.kind = $${params.length}`);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const counted = await tx.query<{ total: number | string }>(
    `SELECT COUNT(*)::int AS total FROM sales s ${whereSql}`,
    params,
  );
  const total = Number(counted.rows[0]?.total ?? 0);

  const offset = (criteria.page - 1) * criteria.limit;
  const paged = await tx.query<SaleRow>(
    `SELECT ${COLUMNS}
       FROM sales s
       JOIN attendants a ON a.id = s.attendant_id
       ${whereSql}
      ORDER BY s.sold_on DESC, s.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, criteria.limit, offset],
  );

  return { rows: paged.rows.map(toSale), total };
}

export interface SaleInsert {
  attendantId: string;
  soldOn: string;
  code: string | null;
  value: number;
  exams: string | null;
  kind: SaleKind;
  createdBy: string | null;
}

export async function insert(tx: DbTx, tenantId: string, data: SaleInsert): Promise<Sale> {
  const result = await tx.query<{ id: string }>(
    `INSERT INTO sales (tenant_id, attendant_id, sold_on, code, value, exams, kind, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      tenantId,
      data.attendantId,
      data.soldOn,
      data.code,
      data.value,
      data.exams,
      data.kind,
      data.createdBy,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('INSERT em sales nao retornou linha');
  const created = await findById(tx, row.id);
  if (!created) throw new Error('Venda recem-criada nao encontrada apos INSERT');
  return created;
}

export async function findById(tx: DbTx, id: string): Promise<Sale | null> {
  const result = await tx.query<SaleRow>(
    `SELECT ${COLUMNS} FROM sales s JOIN attendants a ON a.id = s.attendant_id WHERE s.id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? toSale(row) : null;
}

/** `true` quando a venda existe, é do tenant e (se informado) pertence ao atendente. */
export async function existsForScope(
  tx: DbTx,
  tenantId: string,
  id: string,
  attendantId?: string,
): Promise<boolean> {
  const params: unknown[] = [tenantId, id];
  let sql = 'SELECT id FROM sales WHERE tenant_id = $1 AND id = $2';
  if (attendantId !== undefined) {
    params.push(attendantId);
    sql += ` AND attendant_id = $${params.length}`;
  }
  const result = await tx.query<{ id: string }>(`${sql} LIMIT 1`, params);
  return result.rows.length > 0;
}

export async function remove(tx: DbTx, tenantId: string, id: string): Promise<void> {
  await tx.query('DELETE FROM sales WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
}

export interface SalesSummaryRow {
  kind: string;
  count: number;
  value: number;
}

/** Agregado por `kind` — a base de `SalesService.getSummary` (BUSINESS_RULES §11). */
export async function summarizeByKind(
  tx: DbTx,
  tenantId: string,
  startDate: string,
  endDate: string,
  attendantId?: string,
): Promise<SalesSummaryRow[]> {
  const params: unknown[] = [tenantId, startDate, endDate];
  let sql = `SELECT kind, COUNT(*)::int AS count, COALESCE(SUM(value), 0) AS value
               FROM sales
              WHERE tenant_id = $1 AND sold_on BETWEEN $2 AND $3`;
  if (attendantId !== undefined) {
    params.push(attendantId);
    sql += ` AND attendant_id = $${params.length}`;
  }
  sql += ' GROUP BY kind';
  const result = await tx.query<{ kind: string; count: number | string; value: string | number }>(
    sql,
    params,
  );
  return result.rows.map((row) => ({
    kind: row.kind,
    count: Number(row.count),
    value: toNumber(row.value),
  }));
}
