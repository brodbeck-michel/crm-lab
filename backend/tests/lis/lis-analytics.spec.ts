/**
 * `/api/v1/lis-budgets/*` — API_CONTRACTS.md §10.2 (Onda 9). Foco nas regras
 * mais arriscadas de BUSINESS_RULES.md §11: `MIN_ORC_RANKING` (rankings so com
 * amostra >= 20), conversao capada em 100% e dedupe por requisicao (maior
 * `paid_value` vence).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  LisBudgetsSummary,
  ListPendingLisBudgetsResponse,
  PendingLisBudgetsSummary,
  LisBudgetsFilters,
} from '@crm-lab/shared';
import { lisAnalyticsModule } from '../../src/controllers/lis-analytics.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const BASE = '/api/v1/lis-budgets';

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let managerA: UserRecord;
let importId: string;

async function insertImport(tenantId: string): Promise<string> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO lis_imports (tenant_id, kind, file_name, status)
       VALUES ($1, 'import', 'seed.xlsx', 'completed') RETURNING id`,
      [tenantId],
    ),
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('falha ao inserir lis_imports de teste');
  return id;
}

async function insertAttendant(tenantId: string, name: string): Promise<string> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO attendants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [tenantId, name],
    ),
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('falha ao inserir attendants de teste');
  return id;
}

interface BudgetSeed {
  number: string;
  issuedOn: string;
  insurance1?: string;
  value1?: number;
  attendantId?: string | null;
  attendantName?: string | null;
  requisitionNumber?: string | null;
  paidValue?: number | null;
  paidOn?: string | null;
}

async function insertBudget(tenantId: string, seed: BudgetSeed): Promise<void> {
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO lis_budgets (
         tenant_id, number, issued_on, patient_name, insurance_1, value_1,
         attendant_id, attendant_name, requisition_number, paid_value, paid_on, import_id
       ) VALUES ($1, $2, $3, 'Paciente Teste', $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        tenantId,
        seed.number,
        seed.issuedOn,
        seed.insurance1 ?? 'Unimed',
        seed.value1 ?? 100,
        seed.attendantId ?? null,
        seed.attendantName ?? null,
        seed.requisitionNumber ?? null,
        seed.paidValue ?? null,
        seed.paidOn ?? null,
        importId,
      ],
    ),
  );
}

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [lisAnalyticsModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', db });
  importId = await insertImport(tenantA.id);
});

describe('GET /lis-budgets/summary — MIN_ORC_RANKING (§11.5)', () => {
  it('com menos de 20 orcamentos emitidos, byAttendant/byInsurance vem vazios', async () => {
    const attendantId = await insertAttendant(tenantA.id, 'Maria');
    for (let i = 0; i < 5; i += 1) {
      await insertBudget(tenantA.id, {
        number: `A${i}`,
        issuedOn: '2026-08-10',
        attendantId,
        attendantName: 'Maria',
      });
    }

    const res = await app.agent
      .get(`${BASE}/summary?startDate=2026-08-01&endDate=2026-08-31`)
      .set(app.auth(managerA));
    const body = res.body as LisBudgetsSummary;
    expect(body.issued.count).toBe(5);
    expect(body.byAttendant).toEqual([]);
    expect(body.byInsurance).toEqual([]);
  });

  it('com 20+ orcamentos emitidos, rankings aparecem', async () => {
    const attendantId = await insertAttendant(tenantA.id, 'Maria');
    for (let i = 0; i < 20; i += 1) {
      await insertBudget(tenantA.id, {
        number: `B${i}`,
        issuedOn: '2026-08-10',
        attendantId,
        attendantName: 'Maria',
      });
    }

    const res = await app.agent
      .get(`${BASE}/summary?startDate=2026-08-01&endDate=2026-08-31`)
      .set(app.auth(managerA));
    const body = res.body as LisBudgetsSummary;
    expect(body.issued.count).toBe(20);
    expect(body.byAttendant).toEqual([
      { attendantId, attendantName: 'Maria', issuedCount: 20, paidValue: 0 },
    ]);
    expect(body.byInsurance).toEqual([{ insuranceName: 'Unimed', count: 20, totalValue: 2000 }]);
  });
});

describe('GET /lis-budgets/summary — conversao capada em 100% (§11.5)', () => {
  it('mais pagamentos deduplicados do que emissoes no periodo: conversionQty = 100, nunca > 100', async () => {
    // 1 orcamento emitido no periodo, mas 2 requisicoes distintas pagas no
    // mesmo periodo (pagamento de orcamentos de janelas diferentes).
    await insertBudget(tenantA.id, {
      number: 'C1',
      issuedOn: '2026-08-10',
      requisitionNumber: 'REQ-1',
      paidValue: 100,
      paidOn: '2026-08-15',
    });
    await insertBudget(tenantA.id, {
      number: 'C2',
      issuedOn: '2026-01-01', // fora do periodo de emissao
      requisitionNumber: 'REQ-2',
      paidValue: 100,
      paidOn: '2026-08-16',
    });

    const res = await app.agent
      .get(`${BASE}/summary?startDate=2026-08-01&endDate=2026-08-31`)
      .set(app.auth(managerA));
    const body = res.body as LisBudgetsSummary;
    expect(body.issued.count).toBe(1);
    expect(body.paid.count).toBe(2);
    expect(body.paid.conversionQty).toBe(100);
  });
});

describe('GET /lis-budgets/summary — dedupe por requisicao (§11.2)', () => {
  it('duas linhas com a mesma requisicao: so a de maior paid_value conta', async () => {
    await insertBudget(tenantA.id, {
      number: 'D1',
      issuedOn: '2026-08-10',
      requisitionNumber: 'REQ-D',
      paidValue: 100,
      paidOn: '2026-08-12',
    });
    await insertBudget(tenantA.id, {
      number: 'D2',
      issuedOn: '2026-08-10',
      requisitionNumber: 'REQ-D',
      paidValue: 400,
      paidOn: '2026-08-12',
    });

    const res = await app.agent
      .get(`${BASE}/summary?startDate=2026-08-01&endDate=2026-08-31`)
      .set(app.auth(managerA));
    const body = res.body as LisBudgetsSummary;
    expect(body.paid.count).toBe(1);
    expect(body.paid.totalValue).toBe(400);
  });
});

describe('GET /lis-budgets/pending — Busca Ativa', () => {
  it('so requisicoes SEM pagamento aparecem, com ageBand pela idade em dias', async () => {
    await insertBudget(tenantA.id, {
      number: 'P1',
      issuedOn: '2026-08-01',
      requisitionNumber: 'REQ-P1',
      paidValue: 0,
    });
    await insertBudget(tenantA.id, {
      number: 'P2',
      issuedOn: '2026-08-10',
      requisitionNumber: 'REQ-P2',
      paidValue: 500, // ja paga: nao entra na Busca Ativa
      paidOn: '2026-08-11',
    });

    const list = await app.agent.get(`${BASE}/pending`).set(app.auth(managerA));
    const listBody = list.body as ListPendingLisBudgetsResponse;
    expect(listBody.budgets).toHaveLength(1);
    expect(listBody.budgets[0]?.number).toBe('P1');

    const summary = await app.agent.get(`${BASE}/pending/summary`).set(app.auth(managerA));
    const summaryBody = summary.body as PendingLisBudgetsSummary;
    expect(summaryBody.total.count).toBe(1);
    // as 4 chaves sempre presentes, mesmo as zeradas (mesmo principio de lossReasons).
    expect(Object.keys(summaryBody.byAgeBand).sort()).toEqual(['0-7', '16-30', '30+', '8-15'].sort());
  });
});

describe('GET /lis-budgets/filters', () => {
  it('so lista atendentes/convenios que aparecem em algum lis_budgets do tenant', async () => {
    const attendantId = await insertAttendant(tenantA.id, 'Maria');
    await insertAttendant(tenantA.id, 'Nunca usada'); // nao referenciada em lis_budgets
    await insertBudget(tenantA.id, {
      number: 'F1',
      issuedOn: '2026-08-01',
      attendantId,
      attendantName: 'Maria',
    });

    const res = await app.agent.get(`${BASE}/filters`).set(app.auth(managerA));
    const body = res.body as LisBudgetsFilters;
    expect(body.attendants).toEqual([{ id: attendantId, name: 'Maria' }]);
    expect(body.issuedOnRange).toEqual({ min: '2026-08-01', max: '2026-08-01' });
  });
});
