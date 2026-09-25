/**
 * RLS fail-closed de `lis_sync_settings` (migracao 026 — CRMLAB-52, D-185).
 *
 * Mesmo padrao de `rls-onda8-quick-replies.spec.ts`. A tabela guarda a chave do
 * Bitlab de cada laboratorio: sem a policy, o GRANT de `ALTER DEFAULT
 * PRIVILEGES` da 002 faria ela VAZAR, nao travar.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { LisSyncSettingsRepository } from '../../src/repositories/lis-sync-settings.repository.js';
import { createTenant, type TenantRecord } from '../helpers/factories.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

describe('RLS CRMLAB-52 — lis_sync_settings', () => {
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

  async function seed(tenantId: string, apiKey: string, enabled = true): Promise<void> {
    await db.withoutTenant((tx) =>
      tx.query('INSERT INTO lis_sync_settings (tenant_id, enabled, api_key) VALUES ($1, $2, $3)', [
        tenantId,
        enabled,
        apiKey,
      ]),
    );
  }

  it('contexto de A nao ve a chave de B', async () => {
    await seed(tenantA.id, 'chave-a');
    await seed(tenantB.id, 'chave-b');

    const visibleToA = await db.withTenant(tenantA.id, (tx) =>
      tx.query<{ api_key: string }>('SELECT api_key FROM lis_sync_settings'),
    );

    expect(visibleToA.rows.map((r) => r.api_key)).toEqual(['chave-a']);
  });

  it('sem contexto de tenant a policy nao devolve nada (fail-closed)', async () => {
    await seed(tenantA.id, 'chave-a');

    const semContexto = await db
      .withTenant('', (tx) => tx.query<{ total: number }>('SELECT COUNT(*)::int AS total FROM lis_sync_settings'))
      .catch(() => null);

    expect(semContexto === null || semContexto.rows[0]?.total === 0).toBe(true);
  });

  it('INSERT com tenant_id alheio e rejeitado pela policy', async () => {
    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query("INSERT INTO lis_sync_settings (tenant_id, enabled, api_key) VALUES ($1, true, 'x')", [
          tenantB.id,
        ]),
      ),
    ).rejects.toThrow();
  });

  it('UPDATE nao atravessa tenant: A nao desliga a sincronizacao de B', async () => {
    await seed(tenantB.id, 'chave-b');

    await db.withTenant(tenantA.id, (tx) => tx.query('UPDATE lis_sync_settings SET enabled = false'));

    const b = await db.withTenant(tenantB.id, (tx) =>
      tx.query<{ enabled: boolean }>('SELECT enabled FROM lis_sync_settings'),
    );
    expect(b.rows[0]?.enabled).toBe(true);
  });

  it('ligado sem chave e recusado pelo CHECK', async () => {
    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query('INSERT INTO lis_sync_settings (tenant_id, enabled, api_key) VALUES ($1, true, NULL)', [
          tenantA.id,
        ]),
      ),
    ).rejects.toThrow();
  });

  it('listEnabledTenantIds (D-186) devolve so tenant_id, so dos ligados e com chave', async () => {
    await seed(tenantA.id, 'chave-a');
    await seed(tenantB.id, 'chave-b', false);

    const ids = await new LisSyncSettingsRepository(db).listEnabledTenantIds();

    expect(ids).toEqual([tenantA.id]);
  });

  it('lis_imports aceita kind sync', async () => {
    await db.withTenant(tenantA.id, (tx) =>
      tx.query("INSERT INTO lis_imports (tenant_id, kind, status) VALUES ($1, 'sync', 'completed')", [tenantA.id]),
    );
    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query("INSERT INTO lis_imports (tenant_id, kind, status) VALUES ($1, 'outro', 'completed')", [
          tenantA.id,
        ]),
      ),
    ).rejects.toThrow();
  });
});
