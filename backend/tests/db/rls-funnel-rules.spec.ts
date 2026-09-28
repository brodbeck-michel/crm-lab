/**
 * RLS fail-closed de `funnel_rules` (migracao 027 — CRMLAB-56, D-190).
 * Mesmo padrao de `rls-lis-sync.spec.ts`: sem a policy, o GRANT de `ALTER
 * DEFAULT PRIVILEGES` da 002 faria as regras de um laboratorio VAZAREM.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, type TenantRecord } from '../helpers/factories.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

describe('RLS CRMLAB-56 — funnel_rules', () => {
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

  async function seed(tenantId: string, marker: string): Promise<void> {
    await db.withoutTenant((tx) =>
      tx.query('INSERT INTO funnel_rules (tenant_id, rules) VALUES ($1, $2::jsonb)', [
        tenantId,
        JSON.stringify({ marker }),
      ]),
    );
  }

  it('contexto de A so ve a propria linha', async () => {
    await seed(tenantA.id, 'a');
    await seed(tenantB.id, 'b');
    const visible = await db.withTenant(tenantA.id, (tx) =>
      tx.query<{ tenant_id: string }>('SELECT tenant_id FROM funnel_rules'),
    );
    expect(visible.rows.map((r) => r.tenant_id)).toEqual([tenantA.id]);
  });

  it('INSERT com tenant_id alheio e rejeitado pela policy', async () => {
    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query("INSERT INTO funnel_rules (tenant_id, rules) VALUES ($1, '{}'::jsonb)", [tenantB.id]),
      ),
    ).rejects.toThrow();
  });

  it('UPDATE nao atravessa tenant', async () => {
    await seed(tenantB.id, 'b');
    await db.withTenant(tenantA.id, (tx) =>
      tx.query(`UPDATE funnel_rules SET rules = '{"marker":"hackeado"}'::jsonb`),
    );
    const b = await db.withoutTenant((tx) =>
      tx.query<{ rules: { marker: string } }>('SELECT rules FROM funnel_rules WHERE tenant_id = $1', [
        tenantB.id,
      ]),
    );
    expect(b.rows[0]?.rules.marker).toBe('b');
  });
});
