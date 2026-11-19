/**
 * Acesso a dados de `scans` — a fila "Digitalizacoes" (SCHEMA.md §49 —
 * CRMLAB-184, D-326). SEM regra de negocio (CONVENTIONS.md).
 *
 * Toda funcao recebe a transacao de quem chama, aberta com `withTenant()` —
 * exceto `listTenantsWithExpired`, a unica chamada de dentro de
 * `withoutTenant()` (agendador de expiracao: le SO `tenant_id`).
 *
 * "Vencida" e `expires_at <= now()`: toda leitura de quem atende esconde a
 * vencida mesmo antes de o agendador passar.
 */
import type { DbTx } from '../db/types.js';

export interface ScanRow {
  id: string;
  deviceId: string;
  deviceName: string;
  mimeType: string;
  byteSize: number;
  createdAt: Date;
  expiresAt: Date;
}

interface RawScanRow {
  id: string;
  device_id: string;
  device_name: string;
  mime_type: string;
  byte_size: number | string;
  created_at: Date | string;
  expires_at: Date | string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toRow(row: RawScanRow): ScanRow {
  return {
    id: row.id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    createdAt: toDate(row.created_at),
    expiresAt: toDate(row.expires_at),
  };
}

export async function countPendingByDevice(tx: DbTx, deviceId: string): Promise<number> {
  const rows = await tx.query<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM scans WHERE device_id = $1 AND expires_at > now()',
    [deviceId],
  );
  return Number(rows.rows[0]?.n ?? 0);
}

export async function insertScan(
  tx: DbTx,
  data: { tenantId: string; deviceId: string; mimeType: string; byteSize: number; ttlHours: number },
): Promise<{ id: string; createdAt: Date; expiresAt: Date }> {
  const rows = await tx.query<{ id: string; created_at: Date | string; expires_at: Date | string }>(
    `INSERT INTO scans (tenant_id, device_id, mime_type, byte_size, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5::int))
     RETURNING id, created_at, expires_at`,
    [data.tenantId, data.deviceId, data.mimeType, data.byteSize, data.ttlHours],
  );
  const row = rows.rows[0];
  if (!row) throw new Error('INSERT em scans nao retornou linha');
  return { id: row.id, createdAt: toDate(row.created_at), expiresAt: toDate(row.expires_at) };
}

const SELECT_SCAN = `
  SELECT s.id, s.device_id, d.name AS device_name, s.mime_type, s.byte_size, s.created_at, s.expires_at
    FROM scans s
    JOIN capture_devices d ON d.id = s.device_id`;

export async function listPending(
  tx: DbTx,
  page: { limit: number; offset: number },
): Promise<{ scans: ScanRow[]; total: number }> {
  const rows = await tx.query<RawScanRow>(
    `${SELECT_SCAN}
      WHERE s.expires_at > now()
      ORDER BY s.created_at DESC, s.id
      LIMIT $1 OFFSET $2`,
    [page.limit, page.offset],
  );
  const total = await tx.query<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM scans WHERE expires_at > now()',
  );
  return { scans: rows.rows.map(toRow), total: Number(total.rows[0]?.n ?? 0) };
}

export async function findPending(tx: DbTx, id: string): Promise<ScanRow | null> {
  const rows = await tx.query<RawScanRow>(`${SELECT_SCAN} WHERE s.id = $1 AND s.expires_at > now()`, [
    id,
  ]);
  const row = rows.rows[0];
  return row ? toRow(row) : null;
}

/**
 * Tira a foto da fila (usar ou descartar): `DELETE ... RETURNING`. Duas
 * pessoas ao mesmo tempo — so uma recebe a linha; a outra, `null`.
 */
export async function deletePending(tx: DbTx, id: string): Promise<ScanRow | null> {
  const rows = await tx.query<RawScanRow>(
    `DELETE FROM scans s
      USING capture_devices d
      WHERE s.id = $1 AND d.id = s.device_id AND s.expires_at > now()
      RETURNING s.id, s.device_id, d.name AS device_name, s.mime_type, s.byte_size,
                s.created_at, s.expires_at`,
    [id],
  );
  const row = rows.rows[0];
  return row ? toRow(row) : null;
}

/** `withoutTenant()` — agendador de expiracao: SO os `tenant_id` com vencidas. */
export async function listTenantsWithExpired(tx: DbTx): Promise<string[]> {
  const rows = await tx.query<{ tenant_id: string }>(
    'SELECT DISTINCT tenant_id FROM scans WHERE expires_at <= now() ORDER BY tenant_id',
  );
  return rows.rows.map((r) => r.tenant_id);
}

/** Dentro de `withTenant()`: apaga as vencidas do laboratorio e devolve os ids (arquivos). */
export async function deleteExpired(tx: DbTx): Promise<string[]> {
  const rows = await tx.query<{ id: string }>(
    'DELETE FROM scans WHERE expires_at <= now() RETURNING id',
  );
  return rows.rows.map((r) => r.id);
}
