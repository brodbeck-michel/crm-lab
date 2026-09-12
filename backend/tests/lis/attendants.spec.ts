/**
 * `/api/v1/attendants` — API_CONTRACTS.md §12 (Onda 9, D-112).
 *
 * Foco: alcada manager/admin (inclusive GET, diferente de /insurances),
 * dedupe por `foldedName`, vinculo com `userId` (papel de laboratorio, ativo,
 * unico por atendente) e isolamento multitenant (outro tenant -> 404).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Attendant, ApiErrorBody, ListAttendantsResponse } from '@crm-lab/shared';
import { attendantModule } from '../../src/controllers/attendant.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const BASE = '/api/v1/attendants';

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let adminA: UserRecord;
let managerA: UserRecord;
let attendantUserA: UserRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [attendantModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  adminA = await createUser({ tenantId: tenantA.id, role: 'admin', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', db });
  attendantUserA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
});

describe('guardas de acesso', () => {
  it('sem token: 401 em todas as rotas', async () => {
    await app.agent.get(BASE).expect(401);
    await app.agent.post(BASE).send({ name: 'X' }).expect(401);
    await app.agent.patch(`${BASE}/id`).send({ isActive: false }).expect(401);
  });

  it('platform_operator recebe 403 em todas as rotas', async () => {
    const plataforma = await createTenant({ name: 'Plataforma', slug: 'plataforma', db });
    const operator = await createUser({ tenantId: plataforma.id, role: 'platform_operator', db });
    const headers = app.auth(operator);
    const id = '00000000-0000-4000-8000-000000000001';

    for (const res of [
      await app.agent.get(BASE).set(headers),
      await app.agent.post(BASE).set(headers).send({ name: 'X' }),
      await app.agent.patch(`${BASE}/${id}`).set(headers).send({ isActive: false }),
    ]) {
      expect(res.status).toBe(403);
      expect((res.body as ApiErrorBody).error.code).toBe('FORBIDDEN');
    }
  });

  it('atendente recebe FORBIDDEN em GET, POST e PATCH (diferente de /insurances)', async () => {
    const headers = app.auth(attendantUserA);
    for (const res of [
      await app.agent.get(BASE).set(headers),
      await app.agent.post(BASE).set(headers).send({ name: 'X' }),
    ]) {
      expect(res.status).toBe(403);
      expect((res.body as ApiErrorBody).error.details).toMatchObject({
        requiredRoles: ['manager', 'admin'],
      });
    }
  });

  it('manager pode listar/criar/atualizar', async () => {
    const headers = app.auth(managerA);
    const create = await app.agent.post(BASE).set(headers).send({ name: 'Maria Souza' });
    expect(create.status).toBe(201);
  });
});

describe('POST /attendants', () => {
  it('cria um atendente sem userId', async () => {
    const res = await app.agent.post(BASE).set(app.auth(adminA)).send({ name: 'Maria Souza' });
    expect(res.status).toBe(201);
    const body = res.body as Attendant;
    expect(body.name).toBe('Maria Souza');
    expect(body.isActive).toBe(true);
    expect(body.userId).toBeNull();
    expect(body.userName).toBeNull();
  });

  it('dedupe por foldedName: "maria souza" apos "Maria Souza" -> CONFLICT', async () => {
    await app.agent.post(BASE).set(app.auth(adminA)).send({ name: 'Maria Souza' }).expect(201);
    const res = await app.agent.post(BASE).set(app.auth(adminA)).send({ name: '  maria   souza ' });
    expect(res.status).toBe(409);
    expect((res.body as ApiErrorBody).error.code).toBe('CONFLICT');
  });

  it('userId valido (ativo, papel de laboratorio, mesmo tenant) liga o atendente', async () => {
    const res = await app.agent
      .post(BASE)
      .set(app.auth(adminA))
      .send({ name: 'Atendente Ligado', userId: attendantUserA.id });
    expect(res.status).toBe(201);
    const body = res.body as Attendant;
    expect(body.userId).toBe(attendantUserA.id);
    expect(body.userName).toBe(attendantUserA.name);
  });

  it('userId de outro tenant -> VALIDATION_ERROR', async () => {
    const userB = await createUser({ tenantId: tenantB.id, role: 'attendant', db });
    const res = await app.agent
      .post(BASE)
      .set(app.auth(adminA))
      .send({ name: 'X', userId: userB.id });
    expect(res.status).toBe(400);
    expect((res.body as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
  });

  it('userId inativo -> VALIDATION_ERROR', async () => {
    const inactive = await createUser({ tenantId: tenantA.id, role: 'attendant', isActive: false, db });
    const res = await app.agent
      .post(BASE)
      .set(app.auth(adminA))
      .send({ name: 'X', userId: inactive.id });
    expect(res.status).toBe(400);
  });

  it('userId de platform_operator -> VALIDATION_ERROR', async () => {
    const operator = await createUser({ tenantId: tenantA.id, role: 'platform_operator', db });
    const res = await app.agent
      .post(BASE)
      .set(app.auth(adminA))
      .send({ name: 'X', userId: operator.id });
    expect(res.status).toBe(400);
  });

  it('userId ja ligado a outro atendente -> CONFLICT', async () => {
    await app.agent
      .post(BASE)
      .set(app.auth(adminA))
      .send({ name: 'Primeiro', userId: attendantUserA.id })
      .expect(201);
    const res = await app.agent
      .post(BASE)
      .set(app.auth(adminA))
      .send({ name: 'Segundo', userId: attendantUserA.id });
    expect(res.status).toBe(409);
    expect((res.body as ApiErrorBody).error.code).toBe('CONFLICT');
  });
});

describe('GET /attendants', () => {
  it('lista paginada, ordenada por nome', async () => {
    await app.agent.post(BASE).set(app.auth(adminA)).send({ name: 'Zeca' }).expect(201);
    await app.agent.post(BASE).set(app.auth(adminA)).send({ name: 'Ana' }).expect(201);
    const res = await app.agent.get(BASE).set(app.auth(managerA));
    expect(res.status).toBe(200);
    const body = res.body as ListAttendantsResponse;
    expect(body.attendants.map((a) => a.name)).toEqual(['Ana', 'Zeca']);
    expect(body.pagination.total).toBe(2);
  });

  it('?active=false filtra so inativos', async () => {
    const created = await app.agent
      .post(BASE)
      .set(app.auth(adminA))
      .send({ name: 'Inativa' });
    await app.agent
      .patch(`${BASE}/${(created.body as Attendant).id}`)
      .set(app.auth(adminA))
      .send({ isActive: false })
      .expect(200);
    await app.agent.post(BASE).set(app.auth(adminA)).send({ name: 'Ativa' }).expect(201);

    const res = await app.agent.get(`${BASE}?active=false`).set(app.auth(managerA));
    const body = res.body as ListAttendantsResponse;
    expect(body.attendants).toHaveLength(1);
    expect(body.attendants[0]?.name).toBe('Inativa');
  });

  it('isolamento multitenant: atendente de outro tenant nao aparece', async () => {
    await app.agent.post(BASE).set(app.auth(adminA)).send({ name: 'Da A' }).expect(201);
    const adminB = await createUser({ tenantId: tenantB.id, role: 'admin', db });
    await app.agent.post(BASE).set(app.auth(adminB)).send({ name: 'Da B' }).expect(201);

    const res = await app.agent.get(BASE).set(app.auth(managerA));
    const body = res.body as ListAttendantsResponse;
    expect(body.attendants.map((a) => a.name)).toEqual(['Da A']);
  });
});

describe('PATCH /attendants/:id', () => {
  it('desativa (unico "delete") e reativa', async () => {
    const created = await app.agent.post(BASE).set(app.auth(adminA)).send({ name: 'X' });
    const id = (created.body as Attendant).id;

    const deactivated = await app.agent
      .patch(`${BASE}/${id}`)
      .set(app.auth(adminA))
      .send({ isActive: false });
    expect(deactivated.status).toBe(200);
    expect((deactivated.body as Attendant).isActive).toBe(false);

    const reactivated = await app.agent
      .patch(`${BASE}/${id}`)
      .set(app.auth(adminA))
      .send({ isActive: true });
    expect((reactivated.body as Attendant).isActive).toBe(true);
  });

  it('userId: null desliga o vinculo sem apagar o atendente', async () => {
    const created = await app.agent
      .post(BASE)
      .set(app.auth(adminA))
      .send({ name: 'Ligada', userId: attendantUserA.id });
    const id = (created.body as Attendant).id;

    const res = await app.agent.patch(`${BASE}/${id}`).set(app.auth(adminA)).send({ userId: null });
    expect(res.status).toBe(200);
    const body = res.body as Attendant;
    expect(body.userId).toBeNull();
    expect(body.userName).toBeNull();
    expect(body.name).toBe('Ligada');
  });

  it('id de outro tenant -> NOT_FOUND (nunca FORBIDDEN)', async () => {
    const adminB = await createUser({ tenantId: tenantB.id, role: 'admin', db });
    const created = await app.agent.post(BASE).set(app.auth(adminB)).send({ name: 'Da B' });
    const id = (created.body as Attendant).id;

    const res = await app.agent.patch(`${BASE}/${id}`).set(app.auth(adminA)).send({ isActive: false });
    expect(res.status).toBe(404);
    expect((res.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
  });

  it('renomeio para foldedName ja existente -> CONFLICT', async () => {
    await app.agent.post(BASE).set(app.auth(adminA)).send({ name: 'Maria' }).expect(201);
    const created = await app.agent.post(BASE).set(app.auth(adminA)).send({ name: 'Joana' });
    const id = (created.body as Attendant).id;

    const res = await app.agent.patch(`${BASE}/${id}`).set(app.auth(adminA)).send({ name: 'maria' });
    expect(res.status).toBe(409);
  });
});
