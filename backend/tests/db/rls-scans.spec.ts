/**
 * RLS fail-closed de `capture_devices` e `scans` (migracao 069 — CRMLAB-184,
 * D-327). Mesmo padrao de `rls-proposal-reminders.spec.ts`.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, type TenantRecord } from '../helpers/factories.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

describe('RLS CRMLAB-184 — capture_devices e scans', () => {
  let db: DbClient;
  let tenantA: TenantRecord;
  let tenantB: TenantRecord;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    tenantA = await createTenant({ name: 'Lab A' });
    tenantB = await createTenant({ name: 'Lab B' });
  });

  async function seed(tenantId: string): Promise<{ deviceId: string; scanId: string }> {
    return db.withoutTenant(async (tx) => {
      const device = await tx.query<{ id: string }>(
        `INSERT INTO capture_devices (tenant_id, name) VALUES ($1, 'Celular') RETURNING id`,
        [tenantId],
      );
      const deviceId = device.rows[0]?.id as string;
      const scan = await tx.query<{ id: string }>(
        `INSERT INTO scans (tenant_id, device_id, mime_type, byte_size, expires_at)
         VALUES ($1, $2, 'image/jpeg', 10, now() + interval '2 days') RETURNING id`,
        [tenantId, deviceId],
      );
      return { deviceId, scanId: scan.rows[0]?.id as string };
    });
  }

  it('contexto de A so ve as proprias linhas nas duas tabelas', async () => {
    await seed(tenantA.id);
    await seed(tenantB.id);
    const visible = await db.withTenant(tenantA.id, async (tx) => ({
      devices: (await tx.query<{ tenant_id: string }>('SELECT tenant_id FROM capture_devices')).rows,
      scans: (await tx.query<{ tenant_id: string }>('SELECT tenant_id FROM scans')).rows,
    }));
    expect(visible.devices.map((r) => r.tenant_id)).toEqual([tenantA.id]);
    expect(visible.scans.map((r) => r.tenant_id)).toEqual([tenantA.id]);
  });

  it('sem contexto de tenant nada e visivel (fail-closed)', async () => {
    await seed(tenantA.id);
    const rows = await db.withTenant(tenantA.id, async (tx) => {
      await tx.query(`SELECT set_config('app.tenant_id', '', true)`);
      return (await tx.query('SELECT id FROM scans')).rows.length +
        (await tx.query('SELECT id FROM capture_devices')).rows.length;
    });
    expect(rows).toBe(0);
  });

  it('INSERT com tenant_id alheio e rejeitado pela policy', async () => {
    const b = await seed(tenantB.id);
    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query(`INSERT INTO capture_devices (tenant_id, name) VALUES ($1, 'Intruso')`, [tenantB.id]),
      ),
    ).rejects.toThrow();
    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query(
          `INSERT INTO scans (tenant_id, device_id, mime_type, byte_size, expires_at)
           VALUES ($1, $2, 'image/jpeg', 10, now())`,
          [tenantB.id, b.deviceId],
        ),
      ),
    ).rejects.toThrow();
  });

  it('UPDATE/DELETE nao atravessam tenant', async () => {
    await seed(tenantB.id);
    await db.withTenant(tenantA.id, async (tx) => {
      await tx.query(`UPDATE capture_devices SET name = 'x'`);
      await tx.query('DELETE FROM scans');
      await tx.query('DELETE FROM capture_devices');
    });
    const left = await db.withoutTenant(async (tx) => ({
      devices: (await tx.query<{ name: string }>('SELECT name FROM capture_devices')).rows,
      scans: (await tx.query('SELECT id FROM scans')).rows.length,
    }));
    expect(left).toEqual({ devices: [{ name: 'Celular' }], scans: 1 });
  });

  it('hash de credencial e de codigo sao unicos', async () => {
    const hash = 'a'.repeat(64);
    await db.withoutTenant((tx) =>
      tx.query(`INSERT INTO capture_devices (tenant_id, name, token_hash) VALUES ($1, 'A', $2)`, [
        tenantA.id,
        hash,
      ]),
    );
    await expect(
      db.withoutTenant((tx) =>
        tx.query(`INSERT INTO capture_devices (tenant_id, name, token_hash) VALUES ($1, 'B', $2)`, [
          tenantB.id,
          hash,
        ]),
      ),
    ).rejects.toThrow();
  });
});
