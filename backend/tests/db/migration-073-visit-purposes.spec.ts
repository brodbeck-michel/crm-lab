/**
 * Migração 073 — finalidade da visita (CRMLAB-190, D-330). Num banco isolado,
 * volta o schema para antes da 073 (sem `visit_purposes`, sem
 * `doctor_visits.purpose_id`, sem o trigger em `tenants`), cria laboratórios e
 * visitas, roda o próprio arquivo e confere:
 *  - todo tenant existente ganha as 5 finalidades padrão, na ordem;
 *  - toda visita existente fica com a "Visita" do PRÓPRIO tenant e a coluna
 *    vira NOT NULL;
 *  - tenant criado depois recebe a semente pelo trigger;
 *  - a segunda execução não duplica nada;
 *  - RLS: um tenant não enxerga as finalidades do outro.
 */
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_VISIT_PURPOSES } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, type TenantRecord } from '../helpers/factories.js';
import { createIsolatedTestDb } from '../helpers/test-db.js';

const SQL_URL = new URL('../../migrations/073_visit_purposes.sql', import.meta.url);

let db: DbClient;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let visitA: string;
let visitB: string;

async function runMigration(): Promise<void> {
  const sql = await readFile(SQL_URL, 'utf8');
  await db.withoutTenant((tx) => tx.exec(sql));
}

/** Schema como era antes da 073. */
async function rollbackTo072(): Promise<void> {
  await db.withoutTenant((tx) =>
    tx.exec(`
      DROP TRIGGER IF EXISTS trg_tenants_seed_visit_purposes ON tenants;
      DROP FUNCTION IF EXISTS trg_seed_visit_purposes();
      DROP FUNCTION IF EXISTS seed_visit_purposes(UUID);
      ALTER TABLE doctor_visits DROP COLUMN IF EXISTS purpose_id;
      DROP TABLE IF EXISTS visit_purposes;
    `),
  );
}

async function insertVisit(tenantId: string, userId: string): Promise<string> {
  const result = await db.withoutTenant(async (tx) => {
    const doctor = await tx.query<{ id: string }>(
      `INSERT INTO doctors (tenant_id, name) VALUES ($1, 'Dra. Antiga') RETURNING id`,
      [tenantId],
    );
    return tx.query<{ id: string }>(
      `INSERT INTO doctor_visits (tenant_id, doctor_id, responsible_user_id, scheduled_at, type)
       VALUES ($1, $2, $3, '2026-10-06T13:00:00Z', 'presencial') RETURNING id`,
      [tenantId, doctor.rows[0]?.id, userId],
    );
  });
  return result.rows[0]?.id as string;
}

async function purposesOf(tenantId: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string; name: string; color: string; sort_order: number; is_active: boolean }>(
      `SELECT id, name, color, sort_order, is_active FROM visit_purposes
        WHERE tenant_id = $1 ORDER BY sort_order, name`,
      [tenantId],
    ),
  );
  return result.rows;
}

async function purposeOfVisit(visitId: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ tenant_id: string; name: string; purpose_tenant: string }>(
      `SELECT v.tenant_id, p.name, p.tenant_id AS purpose_tenant
         FROM doctor_visits v JOIN visit_purposes p ON p.id = v.purpose_id
        WHERE v.id = $1`,
      [visitId],
    ),
  );
  return result.rows[0];
}

beforeAll(async () => {
  db = await createIsolatedTestDb();
  await rollbackTo072();
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  const userA = await createUser({ tenantId: tenantA.id, db });
  const userB = await createUser({ tenantId: tenantB.id, db });
  visitA = await insertVisit(tenantA.id, userA.id);
  visitB = await insertVisit(tenantB.id, userB.id);
  await runMigration();
}, 60_000);

describe('migração 073', () => {
  it('semeia as 5 finalidades padrão em cada tenant existente, na ordem', async () => {
    for (const tenant of [tenantA, tenantB]) {
      const rows = await purposesOf(tenant.id);
      expect(rows.map((r) => ({ name: r.name, color: r.color }))).toEqual(
        DEFAULT_VISIT_PURPOSES.map((p) => ({ name: p.name, color: p.color })),
      );
      expect(rows.every((r) => r.is_active)).toBe(true);
    }
  });

  it('a visita existente recebe a "Visita" do próprio tenant e a coluna vira NOT NULL', async () => {
    for (const visitId of [visitA, visitB]) {
      const row = await purposeOfVisit(visitId);
      expect(row?.name).toBe('Visita');
      expect(row?.purpose_tenant).toBe(row?.tenant_id);
    }
    const column = await db.withoutTenant((tx) =>
      tx.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'doctor_visits' AND column_name = 'purpose_id'`,
      ),
    );
    expect(column.rows[0]?.is_nullable).toBe('NO');
  });

  it('tenant novo recebe a semente pelo trigger', async () => {
    const novo = await createTenant({ name: 'Lab Novo', slug: 'lab-novo', db });
    expect((await purposesOf(novo.id)).map((r) => r.name)).toEqual(
      DEFAULT_VISIT_PURPOSES.map((p) => p.name),
    );
  });

  it('rodar de novo não duplica a semente nem mexe nas visitas', async () => {
    const before = await purposesOf(tenantA.id);
    await runMigration();
    expect(await purposesOf(tenantA.id)).toEqual(before);
    expect((await purposeOfVisit(visitA))?.name).toBe('Visita');
  });

  it('RLS: um tenant não enxerga as finalidades do outro', async () => {
    const rows = await db.withTenant(tenantA.id, (tx) =>
      tx.query<{ tenant_id: string }>('SELECT tenant_id FROM visit_purposes'),
    );
    expect(rows.rows.length).toBe(DEFAULT_VISIT_PURPOSES.length);
    expect(rows.rows.every((r) => r.tenant_id === tenantA.id)).toBe(true);
  });

  it('o banco recusa cor fora da paleta e nome repetido (sem diferenciar maiúscula)', async () => {
    await expect(
      db.withoutTenant((tx) =>
        tx.query(`INSERT INTO visit_purposes (tenant_id, name, color) VALUES ($1, 'Outra', '#ff0000')`, [
          tenantA.id,
        ]),
      ),
    ).rejects.toThrow();
    await expect(
      db.withoutTenant((tx) =>
        tx.query(`INSERT INTO visit_purposes (tenant_id, name, color) VALUES ($1, 'VISITA', 'azul')`, [
          tenantA.id,
        ]),
      ),
    ).rejects.toThrow();
  });
});
