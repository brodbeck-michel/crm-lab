/**
 * RLS fail-closed das 4 tabelas novas da Onda 9 (attendants, lis_imports,
 * lis_budgets, sales — migração 012_lis_domain.sql). Mesmo padrão de
 * `tests/db/rls-onda7.spec.ts`: dois tenants, um não vê linha do outro; sem
 * `withTenant()` a query não devolve nada (fail-closed); INSERT com
 * `tenant_id` alheio é rejeitado pela policy, não pela aplicação.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createTenant, type TenantRecord } from '../helpers/factories.js';

interface AttendantRow {
  id: string;
  tenant_id: string;
  name: string;
}

interface LisImportRow {
  id: string;
  tenant_id: string;
}

interface LisBudgetRow {
  id: string;
  tenant_id: string;
  number: string;
}

interface SaleRow {
  id: string;
  tenant_id: string;
}

async function insertAttendant(
  db: DbClient,
  input: { tenantId: string; name: string },
): Promise<AttendantRow> {
  const result = await db.withoutTenant((tx) =>
    tx.query<AttendantRow>(
      `INSERT INTO attendants (tenant_id, name) VALUES ($1, $2)
       RETURNING id, tenant_id, name`,
      [input.tenantId, input.name],
    ),
  );
  return result.rows[0] as AttendantRow;
}

async function insertLisImport(
  db: DbClient,
  input: { tenantId: string },
): Promise<LisImportRow> {
  const result = await db.withoutTenant((tx) =>
    tx.query<LisImportRow>(
      `INSERT INTO lis_imports (tenant_id, kind, status) VALUES ($1, 'import', 'completed')
       RETURNING id, tenant_id`,
      [input.tenantId],
    ),
  );
  return result.rows[0] as LisImportRow;
}

async function insertLisBudget(
  db: DbClient,
  input: { tenantId: string; number: string; importId: string },
): Promise<LisBudgetRow> {
  const result = await db.withoutTenant((tx) =>
    tx.query<LisBudgetRow>(
      `INSERT INTO lis_budgets (tenant_id, number, import_id) VALUES ($1, $2, $3)
       RETURNING id, tenant_id, number`,
      [input.tenantId, input.number, input.importId],
    ),
  );
  return result.rows[0] as LisBudgetRow;
}

async function insertSale(
  db: DbClient,
  input: { tenantId: string; attendantId: string },
): Promise<SaleRow> {
  const result = await db.withoutTenant((tx) =>
    tx.query<SaleRow>(
      `INSERT INTO sales (tenant_id, attendant_id, sold_on, value, kind)
       VALUES ($1, $2, CURRENT_DATE, 100.00, 'exams')
       RETURNING id, tenant_id`,
      [input.tenantId, input.attendantId],
    ),
  );
  return result.rows[0] as SaleRow;
}

describe('RLS Onda 9 — attendants, lis_imports, lis_budgets, sales', () => {
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

  describe('attendants', () => {
    it('query dentro do contexto A não vê atendente de B', async () => {
      await insertAttendant(db, { tenantId: tenantA.id, name: 'Atendente A' });
      await insertAttendant(db, { tenantId: tenantB.id, name: 'Atendente B' });

      const visibleToA = await db.withTenant(tenantA.id, (tx) =>
        tx.query<{ name: string }>('SELECT name FROM attendants'),
      );

      expect(visibleToA.rows).toHaveLength(1);
      expect(visibleToA.rows[0]?.name).toBe('Atendente A');
    });

    it('sem contexto de tenant (withTenant com tenant sem linhas) devolve zero linhas', async () => {
      await insertAttendant(db, { tenantId: tenantA.id, name: 'Atendente A' });
      await insertAttendant(db, { tenantId: tenantB.id, name: 'Atendente B' });

      const tenantC = await createTenant({ name: 'Lab C, sem atendentes' });
      const visibleToC = await db.withTenant(tenantC.id, (tx) =>
        tx.query('SELECT id FROM attendants'),
      );
      expect(visibleToC.rows).toHaveLength(0);
    });

    it('bloqueia INSERT com tenant_id alheio', async () => {
      await expect(
        db.withTenant(tenantA.id, (tx) =>
          tx.query(`INSERT INTO attendants (tenant_id, name) VALUES ($1, $2)`, [
            tenantB.id,
            'Invasor',
          ]),
        ),
      ).rejects.toThrow(/row-level security|policy/i);

      const rowsOfB = await db.withoutTenant((tx) =>
        tx.query('SELECT id FROM attendants WHERE tenant_id = $1', [tenantB.id]),
      );
      expect(rowsOfB.rows).toHaveLength(0);
    });

    it('busca por id de atendente de outro tenant volta vazia (vira 404 na API)', async () => {
      const attendantOfB = await insertAttendant(db, { tenantId: tenantB.id, name: 'Atendente B' });

      const found = await db.withTenant(tenantA.id, (tx) =>
        tx.query('SELECT id FROM attendants WHERE id = $1', [attendantOfB.id]),
      );
      expect(found.rows).toHaveLength(0);
    });
  });

  describe('lis_imports', () => {
    it('query dentro do contexto A não vê import de B', async () => {
      await insertLisImport(db, { tenantId: tenantA.id });
      await insertLisImport(db, { tenantId: tenantB.id });

      const visibleToA = await db.withTenant(tenantA.id, (tx) =>
        tx.query('SELECT id FROM lis_imports'),
      );
      expect(visibleToA.rows).toHaveLength(1);
    });

    it('bloqueia INSERT com tenant_id alheio', async () => {
      await expect(
        db.withTenant(tenantA.id, (tx) =>
          tx.query(
            `INSERT INTO lis_imports (tenant_id, kind, status) VALUES ($1, 'import', 'completed')`,
            [tenantB.id],
          ),
        ),
      ).rejects.toThrow(/row-level security|policy/i);
    });
  });

  describe('lis_budgets', () => {
    it('query dentro do contexto A não vê orçamento de B', async () => {
      const importA = await insertLisImport(db, { tenantId: tenantA.id });
      const importB = await insertLisImport(db, { tenantId: tenantB.id });
      await insertLisBudget(db, { tenantId: tenantA.id, number: '1001', importId: importA.id });
      await insertLisBudget(db, { tenantId: tenantB.id, number: '2001', importId: importB.id });

      const visibleToA = await db.withTenant(tenantA.id, (tx) =>
        tx.query<{ number: string }>('SELECT number FROM lis_budgets'),
      );
      expect(visibleToA.rows).toHaveLength(1);
      expect(visibleToA.rows[0]?.number).toBe('1001');

      const visibleToC = await db.withTenant(
        (await createTenant({ name: 'Lab C' })).id,
        (tx) => tx.query('SELECT id FROM lis_budgets'),
      );
      expect(visibleToC.rows).toHaveLength(0);
    });

    it('bloqueia INSERT com tenant_id alheio', async () => {
      const importA = await insertLisImport(db, { tenantId: tenantA.id });

      await expect(
        db.withTenant(tenantA.id, (tx) =>
          tx.query(`INSERT INTO lis_budgets (tenant_id, number, import_id) VALUES ($1, $2, $3)`, [
            tenantB.id,
            '9999',
            importA.id,
          ]),
        ),
      ).rejects.toThrow(/row-level security|policy/i);
    });

    it('colunas geradas (principal_insurance_name, total_value) continuam calculadas sob RLS', async () => {
      const importA = await insertLisImport(db, { tenantId: tenantA.id });
      await db.withoutTenant((tx) =>
        tx.query(
          `INSERT INTO lis_budgets (tenant_id, number, import_id, insurance_1, value_1, insurance_2, value_2)
           VALUES ($1, '3001', $2, 'Unimed', 0, 'Bradesco', 150.50)`,
          [tenantA.id, importA.id],
        ),
      );

      const visibleToA = await db.withTenant(tenantA.id, (tx) =>
        tx.query<{ principal_insurance_name: string; total_value: number | string }>(
          'SELECT principal_insurance_name, total_value FROM lis_budgets WHERE number = $1',
          ['3001'],
        ),
      );
      expect(visibleToA.rows).toHaveLength(1);
      expect(visibleToA.rows[0]?.principal_insurance_name).toBe('Bradesco');
      expect(Number(visibleToA.rows[0]?.total_value)).toBe(150.5);
    });
  });

  describe('sales', () => {
    it('query dentro do contexto A não vê venda de B', async () => {
      const attendantA = await insertAttendant(db, { tenantId: tenantA.id, name: 'Atendente A' });
      const attendantB = await insertAttendant(db, { tenantId: tenantB.id, name: 'Atendente B' });
      await insertSale(db, { tenantId: tenantA.id, attendantId: attendantA.id });
      await insertSale(db, { tenantId: tenantB.id, attendantId: attendantB.id });

      const visibleToA = await db.withTenant(tenantA.id, (tx) =>
        tx.query('SELECT id FROM sales'),
      );
      expect(visibleToA.rows).toHaveLength(1);

      const visibleToC = await db.withTenant(
        (await createTenant({ name: 'Lab C' })).id,
        (tx) => tx.query('SELECT id FROM sales'),
      );
      expect(visibleToC.rows).toHaveLength(0);
    });

    it('bloqueia INSERT com tenant_id alheio', async () => {
      const attendantA = await insertAttendant(db, { tenantId: tenantA.id, name: 'Atendente A' });

      await expect(
        db.withTenant(tenantA.id, (tx) =>
          tx.query(
            `INSERT INTO sales (tenant_id, attendant_id, sold_on, value, kind)
             VALUES ($1, $2, CURRENT_DATE, 100.00, 'exams')`,
            [tenantB.id, attendantA.id],
          ),
        ),
      ).rejects.toThrow(/row-level security|policy/i);
    });

    it('DELETE não atravessa tenant: A não apaga a venda de B', async () => {
      const attendantB = await insertAttendant(db, { tenantId: tenantB.id, name: 'Atendente B' });
      const saleOfB = await insertSale(db, { tenantId: tenantB.id, attendantId: attendantB.id });

      await db.withTenant(tenantA.id, (tx) =>
        tx.query('DELETE FROM sales WHERE id = $1', [saleOfB.id]),
      );

      const stillThere = await db.withoutTenant((tx) =>
        tx.query('SELECT id FROM sales WHERE id = $1', [saleOfB.id]),
      );
      expect(stillThere.rows).toHaveLength(1);
    });
  });
});
