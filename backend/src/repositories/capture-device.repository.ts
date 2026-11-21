/**
 * Acesso a dados de `capture_devices` (SCHEMA.md §50 — CRMLAB-184, D-327).
 * SEM regra de negocio: quem decide codigo, TTL e auditoria e o
 * `CaptureDeviceService`.
 *
 * Toda funcao recebe a transacao (`DbTx`) de quem chama. As que rodam com
 * `withTenant()` contam com o RLS; as duas `find*ByHash` sao as unicas
 * chamadas de dentro de `withoutTenant()` (SCHEMA.md "As excecoes que rodam
 * fora do contexto de tenant") e devolvem UMA linha, achada pelo hash.
 */
import type { CaptureDevice, CaptureDeviceStatus } from '@crm-lab/shared';
import type { DbTx } from '../db/types.js';

interface DeviceRow {
  id: string;
  name: string;
  token_hash: string | null;
  pairing_code_hash: string | null;
  pairing_code_expires_at: Date | string | null;
  paired_at: Date | string | null;
  last_used_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
  pending_scans: number | string;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function statusOf(row: DeviceRow): CaptureDeviceStatus {
  if (row.revoked_at !== null) return 'revoked';
  return row.token_hash !== null ? 'active' : 'pending';
}

function toDevice(row: DeviceRow, now: Date): CaptureDevice {
  const codeExpiresAt = iso(row.pairing_code_expires_at);
  const codeValid =
    row.pairing_code_hash !== null && codeExpiresAt !== null && new Date(codeExpiresAt) > now;
  return {
    id: row.id,
    name: row.name,
    status: statusOf(row),
    pairingCodeExpiresAt: codeValid ? codeExpiresAt : null,
    pairedAt: iso(row.paired_at),
    lastUsedAt: iso(row.last_used_at),
    pendingScans: Number(row.pending_scans),
    createdAt: iso(row.created_at) as string,
  };
}

const DEVICE_COLUMNS = `
  d.id, d.name, d.token_hash, d.pairing_code_hash, d.pairing_code_expires_at,
  d.paired_at, d.last_used_at, d.revoked_at, d.created_at,
  (SELECT COUNT(*) FROM scans s WHERE s.device_id = d.id AND s.expires_at > now()) AS pending_scans`;

/** Lista (revogados por ultimo, mais novo primeiro). */
export async function listDevices(
  tx: DbTx,
  page: { limit: number; offset: number },
): Promise<{ devices: CaptureDevice[]; total: number }> {
  const now = new Date();
  const rows = await tx.query<DeviceRow>(
    `SELECT ${DEVICE_COLUMNS}
       FROM capture_devices d
      ORDER BY (d.revoked_at IS NOT NULL), d.created_at DESC, d.id
      LIMIT $1 OFFSET $2`,
    [page.limit, page.offset],
  );
  const total = await tx.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM capture_devices');
  return { devices: rows.rows.map((r) => toDevice(r, now)), total: Number(total.rows[0]?.n ?? 0) };
}

export async function findDevice(tx: DbTx, id: string): Promise<CaptureDevice | null> {
  const rows = await tx.query<DeviceRow>(
    `SELECT ${DEVICE_COLUMNS} FROM capture_devices d WHERE d.id = $1`,
    [id],
  );
  const row = rows.rows[0];
  return row ? toDevice(row, new Date()) : null;
}

/** Trava a linha (renovar codigo / revogar / receber foto concorrentes). */
export async function lockDevice(
  tx: DbTx,
  id: string,
): Promise<{ id: string; name: string; revoked: boolean; paired: boolean } | null> {
  const rows = await tx.query<{ id: string; name: string; revoked_at: unknown; token_hash: string | null }>(
    'SELECT id, name, revoked_at, token_hash FROM capture_devices WHERE id = $1 FOR UPDATE',
    [id],
  );
  const row = rows.rows[0];
  if (!row) return null;
  return { id: row.id, name: row.name, revoked: row.revoked_at !== null, paired: row.token_hash !== null };
}

export async function insertDevice(
  tx: DbTx,
  data: {
    tenantId: string;
    name: string;
    pairingCodeHash: string;
    pairingCodeExpiresAt: Date;
    createdBy: string;
  },
): Promise<string> {
  const rows = await tx.query<{ id: string }>(
    `INSERT INTO capture_devices (tenant_id, name, pairing_code_hash, pairing_code_expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [data.tenantId, data.name, data.pairingCodeHash, data.pairingCodeExpiresAt, data.createdBy],
  );
  const id = rows.rows[0]?.id;
  if (!id) throw new Error('INSERT em capture_devices nao retornou linha');
  return id;
}

export async function setPairingCode(
  tx: DbTx,
  id: string,
  codeHash: string,
  expiresAt: Date,
): Promise<void> {
  await tx.query(
    `UPDATE capture_devices SET pairing_code_hash = $2, pairing_code_expires_at = $3 WHERE id = $1`,
    [id, codeHash, expiresAt],
  );
}

/** Revogar nao apaga a linha (SCHEMA §50): zera os dois hashes e grava `revoked_at`. */
export async function revokeDevice(tx: DbTx, id: string): Promise<void> {
  await tx.query(
    `UPDATE capture_devices
        SET token_hash = NULL, pairing_code_hash = NULL, pairing_code_expires_at = NULL,
            revoked_at = now()
      WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  );
}

/**
 * `withoutTenant()` — pareamento (D-327): acha o dispositivo pelo hash de um
 * codigo ainda valido, de dispositivo nao revogado e de laboratorio ativo.
 */
export async function findByPairingCodeHash(
  tx: DbTx,
  codeHash: string,
): Promise<{ id: string; tenantId: string } | null> {
  const rows = await tx.query<{ id: string; tenant_id: string }>(
    `SELECT d.id, d.tenant_id
       FROM capture_devices d
       JOIN tenants t ON t.id = d.tenant_id AND t.is_active = TRUE
      WHERE d.pairing_code_hash = $1
        AND d.pairing_code_expires_at > now()
        AND d.revoked_at IS NULL`,
    [codeHash],
  );
  const row = rows.rows[0];
  return row ? { id: row.id, tenantId: row.tenant_id } : null;
}

/**
 * Consome o codigo e grava a credencial nova (a antiga, se houver, cai). As
 * condicoes se repetem no UPDATE: dois celulares com o MESMO codigo ao mesmo
 * tempo — so um pareia.
 */
export async function completePairing(
  tx: DbTx,
  id: string,
  codeHash: string,
  tokenHash: string,
): Promise<{ name: string } | null> {
  const rows = await tx.query<{ name: string }>(
    `UPDATE capture_devices
        SET token_hash = $3, pairing_code_hash = NULL, pairing_code_expires_at = NULL,
            paired_at = now()
      WHERE id = $1 AND pairing_code_hash = $2 AND pairing_code_expires_at > now()
        AND revoked_at IS NULL
      RETURNING name`,
    [id, codeHash, tokenHash],
  );
  return rows.rows[0] ?? null;
}

/**
 * `withoutTenant()` — autenticacao do dispositivo (D-327): o equivalente ao
 * login, para o celular. Revogado nao tem `token_hash`, entao nao casa.
 */
export async function findByTokenHash(
  tx: DbTx,
  tokenHash: string,
): Promise<{
  deviceId: string;
  deviceName: string;
  tenantId: string;
  tenantName: string;
  tenantActive: boolean;
} | null> {
  const rows = await tx.query<{
    id: string;
    name: string;
    tenant_id: string;
    tenant_name: string;
    is_active: boolean | null;
  }>(
    `SELECT d.id, d.name, d.tenant_id, t.name AS tenant_name, t.is_active
       FROM capture_devices d
       JOIN tenants t ON t.id = d.tenant_id
      WHERE d.token_hash = $1 AND d.revoked_at IS NULL`,
    [tokenHash],
  );
  const row = rows.rows[0];
  if (!row) return null;
  return {
    deviceId: row.id,
    deviceName: row.name,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    tenantActive: row.is_active === true,
  };
}

export async function touchLastUsed(tx: DbTx, id: string): Promise<void> {
  await tx.query('UPDATE capture_devices SET last_used_at = now() WHERE id = $1', [id]);
}

export async function tenantName(tx: DbTx, tenantId: string): Promise<string> {
  const rows = await tx.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [tenantId]);
  return rows.rows[0]?.name ?? '';
}
