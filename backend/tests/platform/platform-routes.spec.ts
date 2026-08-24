/**
 * `/api/v1/platform/*` — console da plataforma (PAGES.md §11).
 *
 * Duas direcoes sao testadas, e as duas importam:
 *   - ninguem alem do `platform_operator` entra em `/platform/*`
 *   - o `platform_operator` NAO entra nas rotas de laboratorio, `/conversations`
 *     inclusive. "Sem acesso a conversas, pacientes e canais internos" e
 *     requisito, nao configuracao — entao e teste, nao comentario.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { conversationModule } from '../../src/controllers/conversation.routes.js';
import { examModule } from '../../src/controllers/exam.routes.js';
import { internalChatModule } from '../../src/controllers/internal-chat.routes.js';
import { platformModule } from '../../src/controllers/platform.routes.js';
import { proposalModule } from '../../src/controllers/proposal.routes.js';
import { themeModule } from '../../src/controllers/theme.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const BASE = '/api/v1/platform';

const NEW_TENANT = {
  name: 'Laboratorio Central',
  slug: 'lab-central',
  plan: 'starter',
  adminEmail: 'admin@labcentral.com.br',
  adminName: 'Admin Central',
  adminPassword: 'senha-super-segura',
};

let db: DbClient;
let app: TestApp;
let operator: UserRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({
    db,
    modules: [
      platformModule,
      themeModule,
      conversationModule,
      proposalModule,
      internalChatModule,
      examModule,
    ],
  });
  const plataforma = await createTenant({ name: 'Plataforma', slug: 'plataforma', db });
  operator = await createUser({
    tenantId: plataforma.id,
    role: 'platform_operator',
    name: 'Operadora',
    db,
  });
});

describe('guarda de acesso ao console', () => {
  it('sem token: 401', async () => {
    await app.agent.get(`${BASE}/tenants`).expect(401);
    await app.agent.get(`${BASE}/billing`).expect(401);
    await app.agent.post(`${BASE}/tenants`).send(NEW_TENANT).expect(401);
  });

  it('nao-operador recebe FORBIDDEN nas tres rotas', async () => {
    const lab = await createTenant({ db });
    for (const role of ['attendant', 'manager', 'admin'] as const) {
      const user = await createUser({ tenantId: lab.id, role, db });
      const headers = app.auth(user);

      const lista = await app.agent.get(`${BASE}/tenants`).set(headers).expect(403);
      expect(lista.body.error.code).toBe('FORBIDDEN');
      expect(lista.body.error.details.requiredRoles).toEqual(['platform_operator']);

      await app.agent.get(`${BASE}/billing`).set(headers).expect(403);
      await app.agent.post(`${BASE}/tenants`).set(headers).send(NEW_TENANT).expect(403);
    }
  });
});

describe('o operador NAO acessa dado de laboratorio', () => {
  it('/conversations recusa o operador da plataforma', async () => {
    const res = await app.agent
      .get('/api/v1/conversations')
      .set(app.auth(operator))
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('propostas, chat interno e tema tambem recusam', async () => {
    const headers = app.auth(operator);
    for (const path of [
      '/api/v1/proposals',
      '/api/v1/internal-chat/channels',
      '/api/v1/themes/current',
    ]) {
      const res = await app.agent.get(path).set(headers).expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  /**
   * As rotas de escrita reservadas a gestor/admin tambem precisam do
   * `denyPlatformOperator()` EXPLICITO. Sem ele o 403 vem por tabela — do
   * `requireRoles('manager','admin')` — e some no dia em que alguem afrouxar
   * os papeis. A assercao olha `details.requiredRoles`: os papeis de
   * LABORATORIO (`attendant/manager/admin`) provam que quem recusou foi o
   * guard de plataforma, nao a checagem de papel.
   */
  it('rotas de aprovacao e de catalogo recusam pelo guard de plataforma', async () => {
    const headers = app.auth(operator);
    const proposalId = '00000000-0000-4000-8000-000000000001';
    const examId = '00000000-0000-4000-8000-000000000002';

    const responses = await Promise.all([
      app.agent.patch(`/api/v1/proposals/${proposalId}/approve`).set(headers),
      app.agent
        .patch(`/api/v1/proposals/${proposalId}/reject`)
        .set(headers)
        .send({ reason: 'nao autorizado' }),
      app.agent.post('/api/v1/exams').set(headers).send({
        name: 'Hemograma',
        code: 'HEM-001',
        pricePrivate: 50,
        priceInsurance: 30,
      }),
      app.agent.patch(`/api/v1/exams/${examId}`).set(headers).send({ isActive: false }),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.details.requiredRoles).toEqual(['attendant', 'manager', 'admin']);
    }
  });
});

describe('GET /platform/tenants', () => {
  it('lista os laboratorios com paginacao', async () => {
    await createTenant({ name: 'Lab Alfa', slug: 'lab-alfa', db });
    const res = await app.agent.get(`${BASE}/tenants`).set(app.auth(operator)).expect(200);

    expect(res.body.pagination).toMatchObject({ page: 1, limit: 20, total: 2 });
    const alfa = res.body.tenants.find((t: { slug: string }) => t.slug === 'lab-alfa');
    expect(alfa).toMatchObject({ name: 'Lab Alfa', isActive: true, userCount: 0 });
  });

  it('aceita busca e filtro de status pela query string', async () => {
    await createTenant({ name: 'Lab Alfa', slug: 'lab-alfa', db });
    await createTenant({ name: 'Lab Beta', slug: 'lab-beta', isActive: false, db });

    const busca = await app.agent
      .get(`${BASE}/tenants?search=Beta`)
      .set(app.auth(operator))
      .expect(200);
    expect(busca.body.tenants).toHaveLength(1);

    const inativos = await app.agent
      .get(`${BASE}/tenants?isActive=false`)
      .set(app.auth(operator))
      .expect(200);
    expect(inativos.body.tenants).toHaveLength(1);
    expect(inativos.body.tenants[0].slug).toBe('lab-beta');
  });
});

describe('POST /platform/tenants', () => {
  it('cria o laboratorio e devolve 201', async () => {
    const res = await app.agent
      .post(`${BASE}/tenants`)
      .set(app.auth(operator))
      .send(NEW_TENANT)
      .expect(201);

    expect(res.body.tenant).toMatchObject({
      name: 'Laboratorio Central',
      slug: 'lab-central',
      subscriptionPlan: 'starter',
      userCount: 1,
    });
    // A senha do admin nunca volta na resposta.
    expect(JSON.stringify(res.body)).not.toContain(NEW_TENANT.adminPassword);
  });

  it('slug duplicado devolve 409 CONFLICT', async () => {
    await app.agent.post(`${BASE}/tenants`).set(app.auth(operator)).send(NEW_TENANT).expect(201);
    const res = await app.agent
      .post(`${BASE}/tenants`)
      .set(app.auth(operator))
      .send({ ...NEW_TENANT, adminEmail: 'outro@lab.com.br' })
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.details.field).toBe('slug');
  });

  it('DTO invalido devolve 400 com details.fields', async () => {
    const res = await app.agent
      .post(`${BASE}/tenants`)
      .set(app.auth(operator))
      .send({ ...NEW_TENANT, adminEmail: 'nao-e-email', adminPassword: '123' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.fields).toHaveProperty('adminEmail');
    expect(res.body.error.details.fields).toHaveProperty('adminPassword');
  });

  it('recusa campo desconhecido no corpo', async () => {
    await app.agent
      .post(`${BASE}/tenants`)
      .set(app.auth(operator))
      .send({ ...NEW_TENANT, isActive: true })
      .expect(400);
  });
});

describe('GET /platform/billing', () => {
  it('devolve uso e totais, com dinheiro em numero', async () => {
    await createTenant({ name: 'Lab Alfa', slug: 'lab-alfa', subscriptionPlan: 'pro', db });
    const res = await app.agent.get(`${BASE}/billing`).set(app.auth(operator)).expect(200);

    expect(res.body.usage).toHaveLength(2);
    expect(typeof res.body.totals.mrr).toBe('number');
    expect(res.body.totals.tenants).toBe(2);

    const alfa = res.body.usage.find((row: { tenantName: string }) => row.tenantName === 'Lab Alfa');
    expect(alfa).toMatchObject({ plan: 'pro', messagesUsed: 0, extraMessages: 0 });
    expect(typeof alfa.monthlyPrice).toBe('number');
  });
});
