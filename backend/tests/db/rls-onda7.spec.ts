/**
 * RLS fail-closed das 3 tabelas novas da Onda 7 (insurances, exam_prices,
 * exam_synonyms). Mesmo padrão de `tests/kernel/tenant-isolation.spec.ts`:
 * dois tenants, um não vê linha do outro; sem `withTenant()` a query não
 * devolve nada (fail-closed); INSERT com `tenant_id` alheio é rejeitado pela
 * policy, não pela aplicação.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createExam, createTenant, type TenantRecord } from '../helpers/factories.js';

interface InsuranceRow {
  id: string;
  tenant_id: string;
  name: string;
}

async function insertInsurance(
  db: DbClient,
  input: { id?: string; tenantId: string; name: string },
): Promise<InsuranceRow> {
  const result = await db.withoutTenant((tx) =>
    tx.query<InsuranceRow>(
      `INSERT INTO insurances (tenant_id, name, type)
       VALUES ($1, $2, 'cooperativa')
       RETURNING id, tenant_id, name`,
      [input.tenantId, input.name],
    ),
  );
  return result.rows[0] as InsuranceRow;
}

describe('RLS Onda 7 — insurances, exam_prices, exam_synonyms', () => {
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

  describe('insurances', () => {
    it('query dentro do contexto A não vê convênio de B', async () => {
      await insertInsurance(db, { tenantId: tenantA.id, name: 'Convênio A' });
      await insertInsurance(db, { tenantId: tenantB.id, name: 'Convênio B' });

      const visibleToA = await db.withTenant(tenantA.id, (tx) =>
        tx.query<{ name: string }>('SELECT name FROM insurances'),
      );

      expect(visibleToA.rows).toHaveLength(1);
      expect(visibleToA.rows[0]?.name).toBe('Convênio A');
    });

    it('sem contexto de tenant (withoutTenant) o RLS não filtra — é a exceção auditada', async () => {
      await insertInsurance(db, { tenantId: tenantA.id, name: 'Convênio A' });
      await insertInsurance(db, { tenantId: tenantB.id, name: 'Convênio B' });

      const all = await db.withoutTenant((tx) => tx.query('SELECT id FROM insurances'));
      expect(all.rows).toHaveLength(2);
    });

    it('fail-closed: query direta sem SET LOCAL ROLE (role dona, sem RLS) não é o caminho normal', async () => {
      await insertInsurance(db, { tenantId: tenantA.id, name: 'Convênio A' });

      // `db.query` fora de withTenant/withoutTenant roda como dono das tabelas
      // (fora do RLS) — por isso o teste de fail-closed de verdade é feito via
      // withTenant com um tenant SEM linha nenhuma: zero contexto == zero linhas.
      const tenantC = await createTenant({ name: 'Lab C, sem convênios' });
      const visibleToC = await db.withTenant(tenantC.id, (tx) =>
        tx.query('SELECT id FROM insurances'),
      );
      expect(visibleToC.rows).toHaveLength(0);
    });

    it('bloqueia INSERT com tenant_id alheio', async () => {
      await expect(
        db.withTenant(tenantA.id, (tx) =>
          tx.query(`INSERT INTO insurances (tenant_id, name, type) VALUES ($1, $2, 'cooperativa')`, [
            tenantB.id,
            'Invasor',
          ]),
        ),
      ).rejects.toThrow(/row-level security|policy/i);

      const rowsOfB = await db.withoutTenant((tx) =>
        tx.query('SELECT id FROM insurances WHERE tenant_id = $1', [tenantB.id]),
      );
      expect(rowsOfB.rows).toHaveLength(0);
    });

    it('busca por id de convênio de outro tenant volta vazia (vira 404 na API)', async () => {
      const insuranceOfB = await insertInsurance(db, { tenantId: tenantB.id, name: 'Convênio B' });

      const found = await db.withTenant(tenantA.id, (tx) =>
        tx.query('SELECT id FROM insurances WHERE id = $1', [insuranceOfB.id]),
      );
      expect(found.rows).toHaveLength(0);
    });
  });

  describe('exam_prices', () => {
    it('query dentro do contexto A não vê preço de B', async () => {
      const examA = await createExam({ tenantId: tenantA.id });
      const examB = await createExam({ tenantId: tenantB.id });
      const insuranceA = await insertInsurance(db, { tenantId: tenantA.id, name: 'Convênio A' });
      const insuranceB = await insertInsurance(db, { tenantId: tenantB.id, name: 'Convênio B' });

      await db.withoutTenant((tx) =>
        tx.query(
          `INSERT INTO exam_prices (tenant_id, exam_id, insurance_id, price) VALUES ($1, $2, $3, $4)`,
          [tenantA.id, examA.id, insuranceA.id, 40.0],
        ),
      );
      await db.withoutTenant((tx) =>
        tx.query(
          `INSERT INTO exam_prices (tenant_id, exam_id, insurance_id, price) VALUES ($1, $2, $3, $4)`,
          [tenantB.id, examB.id, insuranceB.id, 45.0],
        ),
      );

      const visibleToA = await db.withTenant(tenantA.id, (tx) =>
        tx.query<{ price: string }>('SELECT price FROM exam_prices'),
      );
      expect(visibleToA.rows).toHaveLength(1);

      const visibleToC = await db.withTenant(
        (await createTenant({ name: 'Lab C' })).id,
        (tx) => tx.query('SELECT id FROM exam_prices'),
      );
      expect(visibleToC.rows).toHaveLength(0);
    });

    it('bloqueia INSERT com tenant_id alheio', async () => {
      const examA = await createExam({ tenantId: tenantA.id });
      const insuranceA = await insertInsurance(db, { tenantId: tenantA.id, name: 'Convênio A' });

      await expect(
        db.withTenant(tenantA.id, (tx) =>
          tx.query(
            `INSERT INTO exam_prices (tenant_id, exam_id, insurance_id, price) VALUES ($1, $2, $3, $4)`,
            [tenantB.id, examA.id, insuranceA.id, 40.0],
          ),
        ),
      ).rejects.toThrow(/row-level security|policy/i);
    });
  });

  describe('exam_synonyms', () => {
    it('query dentro do contexto A não vê sinônimo de B', async () => {
      const examA = await createExam({ tenantId: tenantA.id });
      const examB = await createExam({ tenantId: tenantB.id });

      await db.withoutTenant((tx) =>
        tx.query(`INSERT INTO exam_synonyms (tenant_id, exam_id, synonym) VALUES ($1, $2, $3)`, [
          tenantA.id,
          examA.id,
          'sinônimo A',
        ]),
      );
      await db.withoutTenant((tx) =>
        tx.query(`INSERT INTO exam_synonyms (tenant_id, exam_id, synonym) VALUES ($1, $2, $3)`, [
          tenantB.id,
          examB.id,
          'sinônimo B',
        ]),
      );

      const visibleToA = await db.withTenant(tenantA.id, (tx) =>
        tx.query<{ synonym: string }>('SELECT synonym FROM exam_synonyms'),
      );
      expect(visibleToA.rows).toHaveLength(1);
      expect(visibleToA.rows[0]?.synonym).toBe('sinônimo A');

      const visibleToC = await db.withTenant(
        (await createTenant({ name: 'Lab C' })).id,
        (tx) => tx.query('SELECT id FROM exam_synonyms'),
      );
      expect(visibleToC.rows).toHaveLength(0);
    });

    it('bloqueia INSERT com tenant_id alheio', async () => {
      const examA = await createExam({ tenantId: tenantA.id });

      await expect(
        db.withTenant(tenantA.id, (tx) =>
          tx.query(`INSERT INTO exam_synonyms (tenant_id, exam_id, synonym) VALUES ($1, $2, $3)`, [
            tenantB.id,
            examA.id,
            'sinônimo invasor',
          ]),
        ),
      ).rejects.toThrow(/row-level security|policy/i);
    });
  });
});
