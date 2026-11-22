/**
 * `/api/v1/settings/visit-purposes` — API_CONTRACTS.md §14 "Finalidades da
 * visita" (CRMLAB-190, D-330).
 *
 * Foco: todo laboratório nasce com as 5 padrão; todos leem, só gestor/admin
 * escrevem; nome único no laboratório sem diferenciar maiúscula; cor só da
 * paleta; inativar em vez de excluir; outro tenant -> 404; audit com o diff.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_VISIT_PURPOSES,
  type ApiErrorBody,
  type ListVisitPurposesResponse,
  type VisitPurpose,
} from '@crm-lab/shared';
import { visitPurposeModule } from '../../src/controllers/visit-purpose.routes.js';
import type { DbClient } from '../../src/db/types.js';
import {
  createTenant,
  createUser,
  visitPurposeId,
  type TenantRecord,
  type UserRecord,
} from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const BASE = '/api/v1/settings/visit-purposes';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000001';

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let adminA: UserRecord;
let managerA: UserRecord;
let attendantA: UserRecord;
let managerB: UserRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [visitPurposeModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  adminA = await createUser({ tenantId: tenantA.id, role: 'admin', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', db });
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
  managerB = await createUser({ tenantId: tenantB.id, role: 'manager', db });
});

function errorOf(response: { body: unknown }) {
  return (response.body as ApiErrorBody).error;
}

async function listOf(user: UserRecord): Promise<VisitPurpose[]> {
  const res = await app.agent.get(BASE).set(app.auth(user)).expect(200);
  return (res.body as ListVisitPurposesResponse).purposes;
}

async function auditOf(entityId: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{
      action: string;
      tenant_id: string;
      old_values: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
    }>(
      `SELECT action, tenant_id, old_values, new_values FROM audit_logs
        WHERE entity_type = 'visit_purpose' AND entity_id = $1 ORDER BY timestamp, action`,
      [entityId],
    ),
  );
  return result.rows;
}

describe('GET /settings/visit-purposes', () => {
  it('todo papel lê; o laboratório nasce com as 5 padrão, na ordem, ativas', async () => {
    for (const user of [attendantA, managerA, adminA]) {
      const purposes = await listOf(user);
      expect(purposes.map((p) => ({ name: p.name, color: p.color, isActive: p.isActive }))).toEqual(
        DEFAULT_VISIT_PURPOSES.map((p) => ({ ...p, isActive: true })),
      );
    }
  });

  it('não vaza o cadastro de outro laboratório', async () => {
    const ids = new Set((await listOf(managerB)).map((p) => p.id));
    for (const purpose of await listOf(attendantA)) expect(ids.has(purpose.id)).toBe(false);
  });

  it('sem token 401; platform_operator 403', async () => {
    await app.agent.get(BASE).expect(401);
    const plataforma = await createTenant({ name: 'Plataforma', slug: 'plataforma', db });
    const operator = await createUser({ tenantId: plataforma.id, role: 'platform_operator', db });
    const h = app.auth(operator);
    for (const res of [
      await app.agent.get(BASE).set(h),
      await app.agent.post(BASE).set(h).send({ name: 'X', color: 'azul' }),
      await app.agent.patch(`${BASE}/${UNKNOWN_ID}`).set(h).send({ isActive: false }),
    ]) {
      expect(res.status).toBe(403);
    }
  });
});

describe('POST /settings/visit-purposes', () => {
  it('gestor cria no fim da ordem, ativa, com audit', async () => {
    const res = await app.agent
      .post(BASE)
      .set(app.auth(managerA))
      .send({ name: '  Treinamento   da equipe ', color: 'ambar' });
    expect(res.status).toBe(201);
    const created = res.body as VisitPurpose;
    expect(created).toMatchObject({ name: 'Treinamento da equipe', color: 'ambar', isActive: true, sortOrder: 5 });
    expect((await listOf(attendantA)).at(-1)?.id).toBe(created.id);

    const logs = await auditOf(created.id);
    expect(logs.map((l) => l.action)).toEqual(['create_visit_purpose']);
    expect(logs[0]?.tenant_id).toBe(tenantA.id);
    expect(logs[0]?.new_values).toEqual({ name: 'Treinamento da equipe', color: 'ambar', isActive: true, sortOrder: 5 });
  });

  it('atendente não cria (403)', async () => {
    const res = await app.agent.post(BASE).set(app.auth(attendantA)).send({ name: 'Treino', color: 'azul' });
    expect(res.status).toBe(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
  });

  it('nome repetido (sem diferenciar maiúscula) -> 400 em fields.name; outro laboratório pode repetir', async () => {
    const res = await app.agent.post(BASE).set(app.auth(managerA)).send({ name: 'VISITA', color: 'rosa' });
    expect(res.status).toBe(400);
    expect(errorOf(res).details).toMatchObject({ fields: { name: expect.any(String) } });

    await app.agent.post(BASE).set(app.auth(managerA)).send({ name: 'Congresso', color: 'rosa' }).expect(201);
    await app.agent.post(BASE).set(app.auth(managerB)).send({ name: 'Congresso', color: 'rosa' }).expect(201);
  });

  it('cor fora da paleta, nome vazio e campo desconhecido -> 400', async () => {
    const h = app.auth(managerA);
    await app.agent.post(BASE).set(h).send({ name: 'Hex', color: '#ff0000' }).expect(400);
    await app.agent.post(BASE).set(h).send({ name: '   ', color: 'azul' }).expect(400);
    await app.agent.post(BASE).set(h).send({ name: 'X', color: 'azul', isActive: false }).expect(400);
    await app.agent.post(BASE).set(h).send({ name: 'x'.repeat(61), color: 'azul' }).expect(400);
  });
});

describe('PATCH /settings/visit-purposes/:id', () => {
  it('admin inativa, renomeia, troca a cor e a ordem; audit só com o diff; sem mudança, sem audit', async () => {
    const id = await visitPurposeId(tenantA.id, 'Acesso a exames', db);
    const h = app.auth(adminA);
    const res = await app.agent
      .patch(`${BASE}/${id}`)
      .set(h)
      .send({ name: 'Liberação de exames', color: 'rosa', isActive: false, sortOrder: 9 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Liberação de exames', color: 'rosa', isActive: false, sortOrder: 9 });

    await app.agent.patch(`${BASE}/${id}`).set(h).send({ isActive: false }).expect(200);

    const logs = await auditOf(id);
    expect(logs.map((l) => l.action)).toEqual(['update_visit_purpose']);
    expect(logs[0]?.old_values).toEqual({ name: 'Acesso a exames', color: 'violeta', isActive: true, sortOrder: 3 });
    expect(logs[0]?.new_values).toEqual({ name: 'Liberação de exames', color: 'rosa', isActive: false, sortOrder: 9 });

    // Inativa continua na listagem (a tela decide o que oferecer).
    expect((await listOf(attendantA)).find((p) => p.id === id)?.isActive).toBe(false);
  });

  it('renomear para um nome já usado -> 400 em fields.name', async () => {
    const id = await visitPurposeId(tenantA.id, 'Compromisso interno', db);
    const res = await app.agent.patch(`${BASE}/${id}`).set(app.auth(managerA)).send({ name: 'visita' });
    expect(res.status).toBe(400);
    expect(errorOf(res).details).toMatchObject({ fields: { name: expect.any(String) } });
  });

  it('finalidade de outro laboratório ou inexistente -> 404 (nunca 403); atendente -> 403', async () => {
    const idB = await visitPurposeId(tenantB.id, 'Visita', db);
    for (const id of [idB, UNKNOWN_ID]) {
      const res = await app.agent.patch(`${BASE}/${id}`).set(app.auth(managerA)).send({ isActive: false });
      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('NOT_FOUND');
    }
    const idA = await visitPurposeId(tenantA.id, 'Visita', db);
    await app.agent.patch(`${BASE}/${idA}`).set(app.auth(attendantA)).send({ isActive: false }).expect(403);
    // O do outro laboratório continua ativo.
    expect((await listOf(managerB)).find((p) => p.id === idB)?.isActive).toBe(true);
  });
});
