/**
 * Migração 076 — requisições do Bitlab (CRMLAB-200, D-338). Num banco isolado, volta o schema para
 * antes da 076, roda o próprio arquivo duas vezes (é idempotente) e confere:
 *  - `total_value` gerado = paciente + convênio;
 *  - `UNIQUE (tenant_id, number)`;
 *  - apagar a requisição leva os pagamentos (cascata);
 *  - RLS: um tenant não enxerga nem grava requisição/pagamento do outro.
 */
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, type TenantRecord } from '../helpers/factories.js';
import { createIsolatedTestDb } from '../helpers/test-db.js';

const SQL_URL = new URL('../../migrations/076_lis_requisitions.sql', import.meta.url);

let db: DbClient;
let tenantA: TenantRecord;
let tenantB: TenantRecord;

beforeAll(async () => {
  db = await createIsolatedTestDb();
  await db.withoutTenant((tx) =>
    tx.exec(`DROP TABLE IF EXISTS lis_requisition_payments; DROP TABLE IF EXISTS lis_requisitions;
             ALTER TABLE lis_sync_settings DROP COLUMN IF EXISTS requisitions_watermark`),
  );
  const sql = await readFile(SQL_URL, 'utf8');
  await db.withoutTenant((tx) => tx.exec(sql));
  await db.withoutTenant((tx) => tx.exec(sql));
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
});

describe('076_lis_requisitions', () => {
  it('total gerado, número único e cascata dos pagamentos', async () => {
    const id = await db.withTenant(tenantA.id, async (tx) => {
      const r = await tx.query<{ id: string; total: string }>(
        `INSERT INTO lis_requisitions (tenant_id, number, patient_value, insurance_value)
         VALUES ($1, '01-1', 50, 30.5) RETURNING id, total_value::text AS total`,
        [tenantA.id],
      );
      expect(r.rows[0]?.total).toBe('80.50');
      await tx.query(
        `INSERT INTO lis_requisition_payments (tenant_id, requisition_id, payment_key, paid_value, status)
         VALUES ($1, $2, '1', 50, 'ativo')`,
        [tenantA.id, r.rows[0]?.id],
      );
      return r.rows[0]?.id as string;
    });

    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query(`INSERT INTO lis_requisitions (tenant_id, number) VALUES ($1, '01-1')`, [tenantA.id]),
      ),
    ).rejects.toThrow();

    await db.withTenant(tenantA.id, (tx) => tx.query('DELETE FROM lis_requisitions WHERE id = $1', [id]));
    const left = await db.withoutTenant((tx) =>
      tx.query('SELECT 1 FROM lis_requisition_payments WHERE requisition_id = $1', [id]),
    );
    expect(left.rows).toHaveLength(0);
  });

  it('RLS: B não vê nem grava em A', async () => {
    await db.withTenant(tenantA.id, (tx) =>
      tx.query(`INSERT INTO lis_requisitions (tenant_id, number) VALUES ($1, '01-2')`, [tenantA.id]),
    );
    const seen = await db.withTenant(tenantB.id, (tx) => tx.query('SELECT 1 FROM lis_requisitions'));
    expect(seen.rows).toHaveLength(0);
    await expect(
      db.withTenant(tenantB.id, (tx) =>
        tx.query(`INSERT INTO lis_requisitions (tenant_id, number) VALUES ($1, '01-3')`, [tenantA.id]),
      ),
    ).rejects.toThrow();
  });
});
