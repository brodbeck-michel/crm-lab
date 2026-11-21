/**
 * Apoio dos testes do Digitalizar pelo celular (CRMLAB-184, D-327).
 */
import sharp from 'sharp';
import { env } from '../../src/config/env.js';
import type { DbClient } from '../../src/db/types.js';
import { CAPTURE_COOKIE_NAME } from '../../src/lib/cookies.js';
import { writeScanFile } from '../../src/lib/media-storage.js';
import { generateDeviceToken, sha256Hex } from '../../src/services/capture-device.service.js';
import type { TestApp } from '../helpers/test-app.js';

/** Um Origin aceito (primeiro de `CORS_ORIGIN`). */
export const ALLOWED_ORIGIN = env.corsOrigins[0] ?? 'http://localhost:5173';

export async function jpegBuffer(): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 200, g: 50, b: 50 } } })
    .jpeg()
    .toBuffer();
}

export async function pngBuffer(): Promise<Buffer> {
  return sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 0.5 } } })
    .png()
    .toBuffer();
}

export async function jpegBase64(): Promise<string> {
  return (await jpegBuffer()).toString('base64');
}

/** Admin cadastra um dispositivo pela API e devolve id + codigo. */
export async function createDeviceViaApi(
  app: TestApp,
  admin: Parameters<TestApp['auth']>[0],
  name = 'Celular recepcao',
): Promise<{ id: string; code: string }> {
  const res = await app.agent
    .post('/api/v1/settings/capture-devices')
    .set(app.auth(admin))
    .send({ name })
    .expect(201);
  return { id: res.body.device.id as string, code: res.body.pairing.code as string };
}

/** O celular pareia e devolve o header `Cookie` pronto. */
export async function pairViaApi(app: TestApp, code: string): Promise<string> {
  const res = await app.agent
    .post('/api/v1/capture/pair')
    .set('Origin', ALLOWED_ORIGIN)
    .send({ code })
    .expect(200);
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = (raw ?? []).find((c) => c.startsWith(`${CAPTURE_COOKIE_NAME}=`));
  if (!cookie) throw new Error('pareamento nao gravou o cookie crm_capture');
  return cookie.split(';')[0] as string;
}

/** Dispositivo ja pareado direto no banco, com credencial conhecida. */
export async function seedPairedDevice(
  db: DbClient,
  tenantId: string,
  name = 'Celular seed',
): Promise<{ id: string; cookie: string }> {
  const token = generateDeviceToken();
  const rows = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO capture_devices (tenant_id, name, token_hash, paired_at)
       VALUES ($1, $2, $3, now()) RETURNING id`,
      [tenantId, name, sha256Hex(token)],
    ),
  );
  return { id: rows.rows[0]?.id as string, cookie: `${CAPTURE_COOKIE_NAME}=${token}` };
}

/** Foto ja na fila (linha + arquivo). `expiresIn` negativo = vencida. */
export async function seedScan(
  db: DbClient,
  tenantId: string,
  deviceId: string,
  options: { expiresInHours?: number; buffer?: Buffer } = {},
): Promise<string> {
  const buffer = options.buffer ?? (await jpegBuffer());
  const rows = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO scans (tenant_id, device_id, mime_type, byte_size, expires_at)
       VALUES ($1, $2, 'image/jpeg', $3, now() + make_interval(hours => $4::int)) RETURNING id`,
      [tenantId, deviceId, buffer.byteLength, options.expiresInHours ?? 48],
    ),
  );
  const id = rows.rows[0]?.id as string;
  await writeScanFile(id, buffer);
  return id;
}

export async function scanCount(db: DbClient): Promise<number> {
  const rows = await db.withoutTenant((tx) =>
    tx.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM scans'),
  );
  return Number(rows.rows[0]?.n ?? 0);
}

export async function auditActions(db: DbClient, action: string): Promise<Array<{ user_id: string | null; entity_id: string }>> {
  const rows = await db.withoutTenant((tx) =>
    tx.query<{ user_id: string | null; entity_id: string }>(
      'SELECT user_id, entity_id FROM audit_logs WHERE action = $1',
      [action],
    ),
  );
  return rows.rows;
}
