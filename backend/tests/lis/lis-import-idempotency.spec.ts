/**
 * `POST /lis-imports` — idempotencia e dedupe (BUSINESS_RULES.md §11.1),
 * seguido de leitura via `/lis-budgets` (SERVICES.md §19/§20).
 *
 * Reimportar a MESMA planilha nao duplica `lis_budgets` (chave
 * `(tenant_id, number)`), e um total MENOR na reimportacao nao regride o
 * valor ja gravado.
 */
import ExcelJS from 'exceljs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LisImport, ListLisBudgetsResponse } from '@crm-lab/shared';
import { lisAnalyticsModule } from '../../src/controllers/lis-analytics.routes.js';
import { lisImportModule } from '../../src/controllers/lis-import.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const IMPORTS_BASE = '/api/v1/lis-imports';
const BUDGETS_BASE = '/api/v1/lis-budgets';

async function buildWorkbook(
  headers: string[],
  rows: Array<Array<string | number | null>>,
): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('orcamentos');
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer).toString('base64');
}

const HEADERS = ['ORCAMENTO', 'DATA_ORÇAMENTO', 'NM_PACIENTE', 'CONVENIO1', 'VL_TOTAL1'];

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let adminA: UserRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [lisImportModule, lisAnalyticsModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  adminA = await createUser({ tenantId: tenantA.id, role: 'admin', db });
  await enableSpreadsheet(tenantA.id);
});

/** A planilha e plano B e nasce desligada nas Regras (CRMLAB-53, D-189). */
async function enableSpreadsheet(tenantId: string, enabled = true): Promise<void> {
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO funnel_rules (tenant_id, rules) VALUES ($1, $2::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE SET rules = EXCLUDED.rules`,
      [tenantId, JSON.stringify({ lisSource: { spreadsheetImport: { enabled } } })],
    ),
  );
}

describe('POST /lis-imports — idempotencia (D-109/D-111)', () => {
  it('reimportar a mesma planilha nao duplica lis_budgets', async () => {
    const contentBase64 = await buildWorkbook(HEADERS, [
      ['1001', 44797, 'Joao', 'Unimed', 452.3],
    ]);

    const first = await app.agent
      .post(IMPORTS_BASE)
      .set(app.auth(adminA))
      .send({ fileName: 'planilha.xlsx', contentBase64 });
    expect(first.status).toBe(201);
    expect((first.body as LisImport).rowsAccepted).toBe(1);

    const second = await app.agent
      .post(IMPORTS_BASE)
      .set(app.auth(adminA))
      .send({ fileName: 'planilha.xlsx', contentBase64 });
    expect(second.status).toBe(201);
    expect((second.body as LisImport).rowsAccepted).toBe(1);

    const list = await app.agent
      .get(`${BUDGETS_BASE}?startDate=2022-01-01&endDate=2030-01-01`)
      .set(app.auth(adminA));
    const body = list.body as ListLisBudgetsResponse;
    expect(body.budgets).toHaveLength(1);
    expect(body.budgets[0]?.number).toBe('1001');
    expect(body.budgets[0]?.totalValue).toBe(452.3);
  });

  it('total MENOR na reimportacao nao regride o valor ja gravado (§11.1)', async () => {
    const bigger = await buildWorkbook(HEADERS, [['2002', 44797, 'Ana', 'Unimed', 900]]);
    await app.agent
      .post(IMPORTS_BASE)
      .set(app.auth(adminA))
      .send({ fileName: 'a.xlsx', contentBase64: bigger })
      .expect(201);

    const smaller = await buildWorkbook(HEADERS, [['2002', 44797, 'Ana', 'Unimed', 100]]);
    await app.agent
      .post(IMPORTS_BASE)
      .set(app.auth(adminA))
      .send({ fileName: 'b.xlsx', contentBase64: smaller })
      .expect(201);

    const list = await app.agent
      .get(`${BUDGETS_BASE}?startDate=2022-01-01&endDate=2030-01-01`)
      .set(app.auth(adminA));
    const body = list.body as ListLisBudgetsResponse;
    expect(body.budgets).toHaveLength(1);
    expect(body.budgets[0]?.totalValue).toBe(900);
  });

  it('duas linhas com o mesmo ORCAMENTO na MESMA planilha: a de maior total_value vence', async () => {
    const contentBase64 = await buildWorkbook(HEADERS, [
      ['3003', 44797, 'Carlos', 'Unimed', 100],
      ['3003', 44797, 'Carlos', 'Unimed', 500],
    ]);
    const res = await app.agent
      .post(IMPORTS_BASE)
      .set(app.auth(adminA))
      .send({ fileName: 'dup.xlsx', contentBase64 });
    expect((res.body as LisImport).rowsAccepted).toBe(1);

    const list = await app.agent
      .get(`${BUDGETS_BASE}?startDate=2022-01-01&endDate=2030-01-01`)
      .set(app.auth(adminA));
    const body = list.body as ListLisBudgetsResponse;
    expect(body.budgets).toHaveLength(1);
    expect(body.budgets[0]?.totalValue).toBe(500);
  });
});

const PAY_HEADERS = [...HEADERS, 'REQUISICAO', 'VALOR_REQUISICAO', 'VALOR_PAGO', 'DATA_PAGAMENTO'];

async function budget(number: string) {
  const list = await app.agent
    .get(`${BUDGETS_BASE}?startDate=2022-01-01&endDate=2030-01-01`)
    .set(app.auth(adminA));
  return (list.body as ListLisBudgetsResponse).budgets.find((b) => b.number === number);
}

describe('POST /lis-imports — planilha como plano B (CRMLAB-53, D-188/D-189)', () => {
  it('regra desligada: SPREADSHEET_IMPORT_DISABLED e nada e gravado', async () => {
    await enableSpreadsheet(tenantA.id, false);
    const contentBase64 = await buildWorkbook(HEADERS, [['4004', 44797, 'Joao', 'Unimed', 10]]);
    const res = await app.agent
      .post(IMPORTS_BASE)
      .set(app.auth(adminA))
      .send({ fileName: 'x.xlsx', contentBase64 });
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('SPREADSHEET_IMPORT_DISABLED');
    expect(await budget('4004')).toBeUndefined();
  });

  it('parcelas somam; valor repetido para no teto da requisicao; reimportar nao soma de novo', async () => {
    // 44797 = 24/08/2022, 44800 = 27/08/2022; a fracao e a hora (0,5 = 12:00:00).
    const rows: Array<Array<string | number | null>> = [
      ['5005', 44797, 'Ana', 'Unimed', 700, '01-1', 600, 400, 44797.5],
      ['5005', 44797, 'Ana', 'Unimed', 700, '01-1', 600, 150, 44800.25],
      ['6006', 44797, 'Bia', 'Unimed', 300, '01-2', 293.96, 293.96, 44797.3],
      ['6006', 44797, 'Bia', 'Unimed', 300, '01-2', 293.96, 293.96, 44797.31],
    ];
    const contentBase64 = await buildWorkbook(PAY_HEADERS, rows);
    for (const fileName of ['a.xlsx', 'b.xlsx']) {
      await app.agent.post(IMPORTS_BASE).set(app.auth(adminA)).send({ fileName, contentBase64 }).expect(201);
    }

    expect(await budget('5005')).toMatchObject({ paidValue: 550, paidOn: '2022-08-27' });
    expect(await budget('6006')).toMatchObject({ paidValue: 293.96 });
    const payments = await db.withoutTenant((tx) =>
      tx.query<{ total: number }>('SELECT COUNT(*)::int AS total FROM lis_budget_payments WHERE tenant_id = $1', [
        tenantA.id,
      ]),
    );
    expect(payments.rows[0]?.total).toBe(4);
  });
});
