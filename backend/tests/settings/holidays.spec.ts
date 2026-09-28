/**
 * `/api/v1/settings/holidays` — API_CONTRACTS.md §6d (CRMLAB-62, D-213).
 *
 * Foco: nacionais calculados junto com os do laboratorio, papeis (GET todo
 * perfil, POST/DELETE manager/admin), validacao, data repetida, auditoria e
 * isolamento entre laboratorios.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, Holiday, HolidaysResponse } from '@crm-lab/shared';
import { holidayModule } from '../../src/controllers/holiday.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const BASE = '/api/v1/settings/holidays';

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let managerA: UserRecord;
let attendantA: UserRecord;
let managerB: UserRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [holidayModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  const tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', db });
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
  managerB = await createUser({ tenantId: tenantB.id, role: 'manager', db });
});

async function create(user: UserRecord, body: unknown) {
  return app.agent.post(BASE).set(app.auth(user)).send(body as object);
}

describe('GET /settings/holidays', () => {
  it('devolve os nacionais do ano e a lista vazia do laboratorio', async () => {
    const res = await app.agent.get(`${BASE}?year=2026`).set(app.auth(attendantA));
    expect(res.status).toBe(200);
    const body = res.body as HolidaysResponse;
    expect(body.year).toBe(2026);
    expect(body.national).toHaveLength(13);
    expect(body.national.map((h) => h.date)).toContain('2026-02-17');
    expect(body.custom).toEqual([]);
  });

  it('ano invalido -> VALIDATION_ERROR', async () => {
    const res = await app.agent.get(`${BASE}?year=abc`).set(app.auth(managerA));
    expect(res.status).toBe(400);
    expect((res.body as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
  });

  it('so os feriados do ano pedido e do proprio laboratorio', async () => {
    await create(managerA, { date: '2026-03-19', description: 'São José' });
    await create(managerA, { date: '2027-03-19', description: 'São José' });
    await create(managerB, { date: '2026-06-13', description: 'Santo Antônio' });
    const res = await app.agent.get(`${BASE}?year=2026`).set(app.auth(managerA));
    expect((res.body as HolidaysResponse).custom).toEqual([
      expect.objectContaining({ date: '2026-03-19', description: 'São José', source: 'custom' }),
    ]);
  });
});

describe('POST /settings/holidays', () => {
  it('gestor inclui, com auditoria', async () => {
    const res = await create(managerA, { date: '2026-03-19', description: '  São José  ' });
    expect(res.status).toBe(201);
    const holiday = res.body as Holiday;
    expect(holiday).toEqual(expect.objectContaining({ date: '2026-03-19', description: 'São José', source: 'custom' }));
    expect(holiday.id).toEqual(expect.any(String));
    const audit = await db.withoutTenant((tx) =>
      tx.query<{ action: string }>(`SELECT action FROM audit_logs WHERE tenant_id = $1`, [tenantA.id]),
    );
    expect(audit.rows.map((r) => r.action)).toContain('create_holiday');
  });

  it('atendente nao inclui', async () => {
    const res = await create(attendantA, { date: '2026-03-19', description: 'São José' });
    expect(res.status).toBe(403);
  });

  it('data repetida -> CONFLICT', async () => {
    await create(managerA, { date: '2026-03-19', description: 'São José' });
    const res = await create(managerA, { date: '2026-03-19', description: 'Outro' });
    expect(res.status).toBe(409);
    expect((res.body as ApiErrorBody).error.code).toBe('CONFLICT');
  });

  it('valida data e descricao', async () => {
    const res = await create(managerA, { date: '2026-02-30', description: '' });
    expect(res.status).toBe(400);
    const fields = (res.body as ApiErrorBody).error.details?.fields as Record<string, string>;
    expect(Object.keys(fields).sort()).toEqual(['date', 'description']);
  });
});

describe('DELETE /settings/holidays/:id', () => {
  it('gestor remove; de outro laboratorio e NOT_FOUND', async () => {
    const created = (await create(managerA, { date: '2026-03-19', description: 'São José' })).body as Holiday;
    const foreign = await app.agent.delete(`${BASE}/${created.id}`).set(app.auth(managerB));
    expect(foreign.status).toBe(404);
    const denied = await app.agent.delete(`${BASE}/${created.id}`).set(app.auth(attendantA));
    expect(denied.status).toBe(403);
    const ok = await app.agent.delete(`${BASE}/${created.id}`).set(app.auth(managerA));
    expect(ok.status).toBe(204);
    const again = await app.agent.delete(`${BASE}/${created.id}`).set(app.auth(managerA));
    expect(again.status).toBe(404);
  });

  it('id que nao e uuid -> VALIDATION_ERROR', async () => {
    const res = await app.agent.delete(`${BASE}/nao-e-uuid`).set(app.auth(managerA));
    expect(res.status).toBe(400);
  });
});
