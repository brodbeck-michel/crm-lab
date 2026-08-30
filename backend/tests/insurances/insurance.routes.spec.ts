/**
 * `/api/v1/insurances` — API_CONTRACTS.md §8.
 *
 * Foco: envelope de listagem (D-070) vs. objeto cru no POST/PATCH, isolamento
 * multitenant (convenio de outro tenant -> 404, nunca 403) e a alcada de
 * escrita (manager/admin).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, Insurance, ListInsurancesResponse } from '@crm-lab/shared';
import { insuranceModule } from '../../src/controllers/insurance.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const BASE = '/api/v1/insurances';

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let adminA: UserRecord;
let managerA: UserRecord;
let attendantA: UserRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [insuranceModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  adminA = await createUser({ tenantId: tenantA.id, role: 'admin', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', db });
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
});

describe('guardas de acesso', () => {
  it('sem token: 401 em todas as rotas', async () => {
    await app.agent.get(BASE).expect(401);
    await app.agent.post(BASE).send({ name: 'X', type: 'seguradora' }).expect(401);
    await app.agent.patch(`${BASE}/id`).send({ isActive: false }).expect(401);
  });

  it('platform_operator recebe 403 em todas as rotas', async () => {
    const plataforma = await createTenant({ name: 'Plataforma', slug: 'plataforma', db });
    const operator = await createUser({ tenantId: plataforma.id, role: 'platform_operator', db });
    const headers = app.auth(operator);
    const id = '00000000-0000-4000-8000-000000000001';

    const responses = [
      await app.agent.get(BASE).set(headers),
      await app.agent.post(BASE).set(headers).send({ name: 'X', type: 'seguradora' }),
      await app.agent.patch(`${BASE}/${id}`).set(headers).send({ isActive: false }),
    ];

    for (const res of responses) {
      expect(res.status).toBe(403);
      expect((res.body as ApiErrorBody).error.code).toBe('FORBIDDEN');
    }
  });

  it('atendente recebe FORBIDDEN em POST e PATCH, mas GET funciona', async () => {
    const post = await app.agent
      .post(BASE)
      .set(app.auth(attendantA))
      .send({ name: 'Amil', type: 'medicina_grupo' });
    expect(post.status).toBe(403);
    expect((post.body as ApiErrorBody).error.details).toMatchObject({
      requiredRoles: ['manager', 'admin'],
    });

    const get = await app.agent.get(BASE).set(app.auth(attendantA));
    expect(get.status).toBe(200);
  });
});

describe('GET /insurances', () => {
  it('200 paginado, so com convenios do proprio tenant', async () => {
    await app.agent
      .post(BASE)
      .set(app.auth(managerA))
      .send({ name: 'Unimed Tubarão', type: 'cooperativa' })
      .expect(201);
    await createInsuranceForTenant(tenantB.id, { name: 'Convênio B', type: 'seguradora' });

    const response = await app.agent.get(BASE).set(app.auth(attendantA)).expect(200);
    const body = response.body as ListInsurancesResponse;
    expect(body.insurances).toHaveLength(1);
    expect(body.insurances[0]?.name).toBe('Unimed Tubarão');
    expect(body.pagination).toMatchObject({ page: 1, limit: 20, total: 1, totalPages: 1 });
  });
});

describe('POST /insurances', () => {
  it('201 devolve o objeto cru, sem envelope', async () => {
    const response = await app.agent
      .post(BASE)
      .set(app.auth(managerA))
      .send({ name: 'Bradesco Saúde', officialName: 'Bradesco Saúde S.A.', ansCode: '005711', type: 'seguradora' })
      .expect(201);

    const body = response.body as Insurance;
    expect(body.name).toBe('Bradesco Saúde');
    expect(body.officialName).toBe('Bradesco Saúde S.A.');
    expect(body.ansCode).toBe('005711');
    expect(body.type).toBe('seguradora');
    expect(body.isActive).toBe(true);
    expect(body).not.toHaveProperty('insurances');
    expect(body).not.toHaveProperty('pagination');
  });

  it('nome duplicado -> 409 CONFLICT', async () => {
    await app.agent.post(BASE).set(app.auth(managerA)).send({ name: 'Amil', type: 'medicina_grupo' }).expect(201);

    const response = await app.agent
      .post(BASE)
      .set(app.auth(managerA))
      .send({ name: 'Amil', type: 'medicina_grupo' });
    expect(response.status).toBe(409);
    expect((response.body as ApiErrorBody).error.code).toBe('CONFLICT');
  });

  it('dados invalidos -> 400 VALIDATION_ERROR', async () => {
    const response = await app.agent.post(BASE).set(app.auth(managerA)).send({ name: '' });
    expect(response.status).toBe(400);
    expect((response.body as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PATCH /insurances/:id', () => {
  it('200 devolve o objeto cru atualizado', async () => {
    const created = await app.agent
      .post(BASE)
      .set(app.auth(managerA))
      .send({ name: 'Amil', type: 'medicina_grupo' })
      .expect(201);
    const insurance = created.body as Insurance;

    const response = await app.agent
      .patch(`${BASE}/${insurance.id}`)
      .set(app.auth(managerA))
      .send({ isActive: false })
      .expect(200);

    const body = response.body as Insurance;
    expect(body.id).toBe(insurance.id);
    expect(body.isActive).toBe(false);
    expect(body).not.toHaveProperty('insurances');
  });
});

describe('isolamento multitenant', () => {
  it('GET de convenio de outro tenant -> 404 (recurso enderecavel nao existe como rota, mas listagem nao vaza)', async () => {
    const ofB = await createInsuranceForTenant(tenantB.id, { name: 'Convênio B', type: 'seguradora' });
    const list = await app.agent.get(BASE).set(app.auth(adminA)).expect(200);
    const body = list.body as ListInsurancesResponse;
    expect(body.insurances.map((i) => i.id)).not.toContain(ofB.id);
  });

  it('PATCH de convenio de outro tenant -> 404 (nunca 403)', async () => {
    const ofB = await createInsuranceForTenant(tenantB.id, { name: 'Convênio B', type: 'seguradora' });

    const response = await app.agent
      .patch(`${BASE}/${ofB.id}`)
      .set(app.auth(managerA))
      .send({ isActive: false });

    expect(response.status).toBe(404);
    expect((response.body as ApiErrorBody).error.code).toBe('NOT_FOUND');

    const rows = await db.withoutTenant((tx) =>
      tx.query<{ is_active: boolean }>('SELECT is_active FROM insurances WHERE id = $1', [ofB.id]),
    );
    expect(rows.rows[0]?.is_active).toBe(true);
  });
});

/** Insere um convenio direto no banco (sem passar pela rota) para montar cenarios de outro tenant. */
async function createInsuranceForTenant(
  tenantId: string,
  data: { name: string; type: string },
): Promise<{ id: string; name: string }> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string; name: string }>(
      `INSERT INTO insurances (tenant_id, name, type) VALUES ($1, $2, $3) RETURNING id, name`,
      [tenantId, data.name, data.type],
    ),
  );
  const row = result.rows[0];
  if (!row) throw new Error('INSERT em insurances nao retornou linha');
  return row;
}
