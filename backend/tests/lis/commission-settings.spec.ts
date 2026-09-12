/**
 * `/api/v1/settings/commissions` — API_CONTRACTS.md §6b (Onda 9, D-113).
 *
 * Foco: defaults sem linha em `tenant_settings` (D-065), PATCH parcial,
 * alcada (GET manager/admin, PATCH admin) e schema `strict`.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, CommissionSettings } from '@crm-lab/shared';
import { commissionSettingsModule } from '../../src/controllers/commission-settings.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const BASE = '/api/v1/settings/commissions';

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let adminA: UserRecord;
let managerA: UserRecord;
let attendantA: UserRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [commissionSettingsModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  adminA = await createUser({ tenantId: tenantA.id, role: 'admin', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', db });
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
});

describe('GET /settings/commissions', () => {
  it('sem linha em tenant_settings devolve os defaults (2,00 / 1,50 / 1,50)', async () => {
    const res = await app.agent.get(BASE).set(app.auth(managerA));
    expect(res.status).toBe(200);
    expect(res.body as CommissionSettings).toEqual({
      commissionBudgetPct: 2.0,
      commissionExamsPct: 1.5,
      commissionCheckupPct: 1.5,
    });
  });

  it('atendente recebe FORBIDDEN', async () => {
    const res = await app.agent.get(BASE).set(app.auth(attendantA));
    expect(res.status).toBe(403);
    expect((res.body as ApiErrorBody).error.details).toMatchObject({
      requiredRoles: ['manager', 'admin'],
    });
  });
});

describe('PATCH /settings/commissions', () => {
  it('admin: patch parcial preserva os demais campos', async () => {
    const first = await app.agent
      .patch(BASE)
      .set(app.auth(adminA))
      .send({ commissionExamsPct: 1.75 });
    expect(first.status).toBe(200);
    expect(first.body as CommissionSettings).toEqual({
      commissionBudgetPct: 2.0,
      commissionExamsPct: 1.75,
      commissionCheckupPct: 1.5,
    });

    const second = await app.agent.patch(BASE).set(app.auth(adminA)).send({ commissionBudgetPct: 3 });
    expect(second.body as CommissionSettings).toEqual({
      commissionBudgetPct: 3,
      commissionExamsPct: 1.75,
      commissionCheckupPct: 1.5,
    });
  });

  it('manager recebe FORBIDDEN (so admin escreve)', async () => {
    const res = await app.agent.patch(BASE).set(app.auth(managerA)).send({ commissionExamsPct: 2 });
    expect(res.status).toBe(403);
    expect((res.body as ApiErrorBody).error.details).toMatchObject({ requiredRoles: ['admin'] });
  });

  it('valor fora de 0..100 -> VALIDATION_ERROR', async () => {
    const res = await app.agent.patch(BASE).set(app.auth(adminA)).send({ commissionExamsPct: 101 });
    expect(res.status).toBe(400);
    expect((res.body as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
  });

  it('corpo vazio -> VALIDATION_ERROR', async () => {
    const res = await app.agent.patch(BASE).set(app.auth(adminA)).send({});
    expect(res.status).toBe(400);
  });

  it('campo desconhecido -> VALIDATION_ERROR (schema strict)', async () => {
    const res = await app.agent.patch(BASE).set(app.auth(adminA)).send({ commissionXyz: 1 });
    expect(res.status).toBe(400);
  });

  it('isolamento: PATCH do tenant A nao muda o default do tenant B', async () => {
    await app.agent.patch(BASE).set(app.auth(adminA)).send({ commissionBudgetPct: 9 }).expect(200);

    const tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
    const adminB = await createUser({ tenantId: tenantB.id, role: 'admin', db });
    const res = await app.agent.get(BASE).set(app.auth(adminB));
    expect((res.body as CommissionSettings).commissionBudgetPct).toBe(2.0);
  });
});
