/**
 * Migração 057 — `lis_budgets.net_value` (CRMLAB-114, D-278).
 *
 * O líquido segue EXATAMENTE a seleção de convênio principal de `total_value`
 * (014, D-124): o `VL_APAGAR` do convênio escolhido, e o bruto dele quando o
 * `VL_APAGAR` não veio. Aqui a coluna gerada é comparada com o espelho em TS
 * (`netValue`/`totalValue` de `lib/lis-spreadsheet.ts`) caso a caso, para as
 * duas regras nunca divergirem.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { netValue, totalValue, type LisSpreadsheetRow } from '../../src/lib/lis-spreadsheet.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createTenant, type TenantRecord } from '../helpers/factories.js';

type Fields = Pick<
  LisSpreadsheetRow,
  | 'insurance1'
  | 'value1'
  | 'payableValue1'
  | 'insurance2'
  | 'value2'
  | 'payableValue2'
  | 'insurance3'
  | 'value3'
  | 'payableValue3'
>;

const EMPTY: Fields = {
  insurance1: null,
  value1: null,
  payableValue1: null,
  insurance2: null,
  value2: null,
  payableValue2: null,
  insurance3: null,
  value3: null,
  payableValue3: null,
};

let db: DbClient;
let tenant: TenantRecord;
let importId: string;
let seq = 0;

async function insertBudget(fields: Partial<Fields>): Promise<{ total: number; net: number }> {
  const f = { ...EMPTY, ...fields };
  seq += 1;
  const result = await db.withTenant(tenant.id, (tx) =>
    tx.query<{ total_value: string; net_value: string }>(
      `INSERT INTO lis_budgets (
         tenant_id, number, import_id,
         insurance_1, value_1, payable_value_1,
         insurance_2, value_2, payable_value_2,
         insurance_3, value_3, payable_value_3
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING total_value, net_value`,
      [
        tenant.id,
        `N${seq}`,
        importId,
        f.insurance1,
        f.value1,
        f.payableValue1,
        f.insurance2,
        f.value2,
        f.payableValue2,
        f.insurance3,
        f.value3,
        f.payableValue3,
      ],
    ),
  );
  const row = result.rows[0];
  if (!row) throw new Error('INSERT em lis_budgets nao retornou linha');
  return { total: Number(row.total_value), net: Number(row.net_value) };
}

/** Coluna gerada == espelho em TS, para bruto e líquido. */
async function expectSameAsTs(fields: Partial<Fields>, expected: { total: number; net: number }) {
  const saved = await insertBudget(fields);
  const row = { number: 'x', ...EMPTY, ...fields } as unknown as LisSpreadsheetRow;
  expect(saved).toEqual(expected);
  expect(totalValue(row)).toBe(expected.total);
  expect(netValue(row)).toBe(expected.net);
}

describe('migração 057 — net_value é o VL_APAGAR do convênio principal (D-278)', () => {
  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    tenant = await createTenant({ name: 'Lab Teste', slug: 'lab-teste', db });
    const created = await db.withoutTenant((tx) =>
      tx.query<{ id: string }>(
        `INSERT INTO lis_imports (tenant_id, kind, status) VALUES ($1, 'import', 'completed')
         RETURNING id`,
        [tenant.id],
      ),
    );
    importId = created.rows[0]!.id;
  });

  it('convênio 1 com VL_APAGAR: líquido é o dele; o dos convênios 2/3 é ignorado', async () => {
    await expectSameAsTs(
      {
        insurance1: 'Unimed',
        value1: 200,
        payableValue1: 185,
        insurance2: 'Bradesco',
        value2: 150,
        payableValue2: 140,
      },
      { total: 200, net: 185 },
    );
  });

  it('sem VL_APAGAR (planilha, API antiga): líquido = bruto', async () => {
    await expectSameAsTs({ insurance1: 'Unimed', value1: 200 }, { total: 200, net: 200 });
  });

  it('convênio principal é o 2º: líquido é o VL_APAGAR do 2º', async () => {
    await expectSameAsTs(
      {
        insurance1: 'Unimed',
        value1: 0,
        payableValue1: 0,
        insurance2: 'Bradesco',
        value2: 150.5,
        payableValue2: 120.25,
      },
      { total: 150.5, net: 120.25 },
    );
  });

  it('a escolha é pelo bruto: VL_APAGAR > 0 num convênio de bruto 0 não o torna principal', async () => {
    await expectSameAsTs(
      { insurance1: 'Unimed', value1: 0, payableValue1: 50, insurance2: 'Bradesco', value2: 100 },
      { total: 100, net: 100 },
    );
  });

  it('nenhum nome, mas há valor: usa o primeiro valor > 0, com o VL_APAGAR dele', async () => {
    await expectSameAsTs({ value2: 75, payableValue2: 70 }, { total: 75, net: 70 });
  });

  it('só nome, sem valor nem VL_APAGAR: 0, não NULL', async () => {
    await expectSameAsTs({ insurance1: 'Unimed' }, { total: 0, net: 0 });
  });

  it('nada preenchido: 0', async () => {
    await expectSameAsTs({}, { total: 0, net: 0 });
  });
});
