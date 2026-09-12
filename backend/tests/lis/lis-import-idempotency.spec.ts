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
});

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
