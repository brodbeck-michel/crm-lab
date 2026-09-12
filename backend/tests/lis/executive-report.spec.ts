/**
 * `GET /reports/executive` — API_CONTRACTS.md §5c (Onda 9, D-116).
 *
 * Foco: `monthlySeries` sempre com 12 pontos (mes sem movimento em 0) e
 * `brandName`/`logoUrl` caindo no tema/nome do PROPRIO tenant, nunca fixo.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, ExecutiveReport } from '@crm-lab/shared';
import { executiveReportModule } from '../../src/controllers/executive-report.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const BASE = '/api/v1/reports/executive';

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let managerA: UserRecord;
let attendantA: UserRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [executiveReportModule] });
  tenantA = await createTenant({ name: 'Laboratorio Vida', slug: 'lab-vida', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', db });
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
});

describe('GET /reports/executive', () => {
  it('atendente recebe FORBIDDEN', async () => {
    const res = await app.agent.get(BASE).set(app.auth(attendantA));
    expect(res.status).toBe(403);
    expect((res.body as ApiErrorBody).error.details).toMatchObject({
      requiredRoles: ['manager', 'admin'],
    });
  });

  it('monthlySeries sempre tem 12 pontos, mes sem movimento em 0', async () => {
    const res = await app.agent
      .get(`${BASE}?startDate=2026-08-01&endDate=2026-08-31`)
      .set(app.auth(managerA));
    expect(res.status).toBe(200);
    const body = res.body as ExecutiveReport;
    // D-125: "Em Requisição" sem dado no tenant é {0,0}, nunca ausente.
    expect(body.requisition).toEqual({ count: 0, totalValue: 0 });
    expect(body.monthlySeries).toHaveLength(12);
    expect(body.monthlySeries[body.monthlySeries.length - 1]?.month).toBe('2026-08');
    for (const point of body.monthlySeries) {
      expect(point.issuedValue).toBe(0);
      expect(point.paidValue).toBe(0);
    }
  });

  it('brandName cai no nome do proprio tenant quando o tema nao foi personalizado (D-116)', async () => {
    const res = await app.agent
      .get(`${BASE}?startDate=2026-08-01&endDate=2026-08-31`)
      .set(app.auth(managerA));
    const body = res.body as ExecutiveReport;
    expect(body.brandName).toBe('Laboratorio Vida');
    expect(body.logoUrl).toBeNull();
  });
});
