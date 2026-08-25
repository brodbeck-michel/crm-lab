/**
 * Acesso a tabela `audit_logs`.
 *
 * APPEND-ONLY (SECURITY.md "Auditoria"), com UMA excecao: o apagamento LGPD.
 * Este arquivo expoe INSERT, SELECT e `eraseEntityValues` — e mais nada. Nao
 * existe DELETE, nao existe UPDATE de `action`/`entity`/`user`/`timestamp`, e
 * nenhum controller alcanca a excecao: ela e chamada so de dentro da transacao
 * de `PatientRepository.anonymize` (D-075).
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

/** Marcador que substitui o VALOR de um campo apagado a pedido do titular. */
export const ERASED = '[ERASED]';

/**
 * Apagamento LGPD dentro do audit log (D-075) — a UNICA escrita nao-append
 * deste arquivo.
 *
 * O problema que resolve: `PATCH /patients/:id` grava `oldValues`/`newValues`
 * com nome, e-mail, nascimento, CPF e a anotacao interna. A anonimizacao
 * (D-063) zerava a ficha e nao tocava aqui, entao
 * `GET /audit?entityType=patient&entityId=<id>` devolvia tudo isso em claro
 * depois do apagamento: o direito ao esquecimento era reversivel por uma rota
 * suportada.
 *
 * O que sobrevive: a linha, `action`, `user_id`, `timestamp`, `ip_address` e as
 * CHAVES dos objetos. O log continua provando QUE a edicao aconteceu e QUAL
 * campo mudou — perde so o VALOR, que e o dado pessoal. Provar a edicao e
 * obrigacao de auditoria; guardar o CPF depois do apagamento nao e.
 *
 * `jsonb_object_agg` sobre objeto vazio devolve NULL, dai o `COALESCE`.
 * Idempotente: rodar de novo troca `"[ERASED]"` por `"[ERASED]"`.
 */
export async function eraseEntityValues(
  tx: DbTx,
  entityType: string,
  entityId: string,
): Promise<number> {
  const erase = (column: string): string =>
    `CASE WHEN ${column} IS NULL THEN NULL ELSE COALESCE(
       (SELECT jsonb_object_agg(kv.key, to_jsonb($3::text)) FROM jsonb_each(${column}) AS kv),
       '{}'::jsonb) END`;

  const result = await tx.query<{ id: string }>(
    `UPDATE audit_logs
        SET old_values = ${erase('old_values')},
            new_values = ${erase('new_values')}
      WHERE entity_type = $1
        AND entity_id = $2
        AND (old_values IS NOT NULL OR new_values IS NOT NULL)
      RETURNING id`,
    [entityType, entityId, ERASED],
  );
  return result.rows.length;
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
