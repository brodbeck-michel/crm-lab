/**
 * Acesso a tabela `audit_logs`.
 *
 * APPEND-ONLY (SECURITY.md "Auditoria"): este arquivo expoe INSERT e SELECT e
 * mais nada. Nao existe — e nao pode passar a existir — caminho de UPDATE ou
 * DELETE em `audit_logs` a partir da API.
 */
import type { AuditEntry } from '@crm-lab/shared';
import type { DbTx } from '../db/types.js';
import { toIso, toJsonObject, toNumber } from './row-mappers.js';

export interface InsertAuditInput {
  tenantId: string;
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function insert(tx: DbTx, input: InsertAuditInput): Promise<void> {
  await tx.query(
    `INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id,
                             old_values, new_values, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.tenantId,
      input.userId,
      input.action,
      input.entityType,
      input.entityId,
      input.oldValues ? JSON.stringify(input.oldValues) : null,
      input.newValues ? JSON.stringify(input.newValues) : null,
      input.ipAddress ?? null,
      // A coluna e VARCHAR(500): corta antes de o banco recusar.
      input.userAgent ? input.userAgent.slice(0, 500) : null,
    ],
  );
}

interface AuditRow {
  id: string;
  user_id: string | null;
  user_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  old_values: unknown;
  new_values: unknown;
  ip_address: string | null;
  timestamp: unknown;
}

function map(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    oldValues: toJsonObject(row.old_values),
    newValues: toJsonObject(row.new_values),
    ipAddress: row.ip_address,
    timestamp: toIso(row.timestamp),
  };
}

export interface AuditQueryFilters {
  page: number;
  limit: number;
  action?: string;
  entityType?: string;
  entityId?: string;
  userId?: string;
  order?: 'asc' | 'desc';
}

export async function query(
  tx: DbTx,
  filters: AuditQueryFilters,
): Promise<{ entries: AuditEntry[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  const eq = (column: string, value: string | undefined): void => {
    if (value === undefined || value === '') return;
    params.push(value);
    conditions.push(`a.${column} = $${params.length}`);
  };
  eq('action', filters.action);
  eq('entity_type', filters.entityType);
  eq('entity_id', filters.entityId);
  eq('user_id', filters.userId);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const totalResult = await tx.query<{ count: unknown }>(
    `SELECT COUNT(*)::int AS count FROM audit_logs a ${where}`,
    params,
  );
  const total = toNumber(totalResult.rows[0]?.count);

  const direction = filters.order === 'asc' ? 'ASC' : 'DESC';
  const offset = (filters.page - 1) * filters.limit;
  const pageParams = [...params, filters.limit, offset];

  const result = await tx.query<AuditRow>(
    `SELECT a.id, a.user_id, u.name AS user_name, a.action, a.entity_type, a.entity_id,
            a.old_values, a.new_values, a.ip_address, a.timestamp
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       ${where}
      ORDER BY a.timestamp ${direction}, a.id ${direction}
      LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams,
  );

  return { entries: result.rows.map(map), total };
}
