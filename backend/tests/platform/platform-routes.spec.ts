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
import type {
  ApiErrorBody,
  BillingResponse,
  CreateTenantRequest,
  CreateTenantResponse,
  ListTenantsResponse,
} from '@crm-lab/shared';
import { channelSettingsModule } from '../../src/controllers/channel-settings.routes.js';
import { conversationModule } from '../../src/controllers/conversation.routes.js';
import { examModule } from '../../src/controllers/exam.routes.js';
import { internalChatModule } from '../../src/controllers/internal-chat.routes.js';
import { operationModule } from '../../src/controllers/operation.routes.js';
import { patientModule } from '../../src/controllers/patient.routes.js';
import { platformModule } from '../../src/controllers/platform.routes.js';
import { proposalModule } from '../../src/controllers/proposal.routes.js';
import { themeModule } from '../../src/controllers/theme.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const BASE = '/api/v1/platform';

/**
 * O corpo do request tem o TIPO DO CONTRATO, nao um objeto solto: se
 * `CreateTenantRequest` mudar em `shared/types/`, este arquivo para de
 * compilar em vez de mandar um corpo obsoleto e receber um 400 misterioso.
 */
const NEW_TENANT: CreateTenantRequest = {
  name: 'Laboratorio Central',
  slug: 'lab-central',
  plan: 'starter',
  adminEmail: 'admin@labcentral.com.br',
  adminName: 'Admin Central',
  adminPassword: 'senha-super-segura',
};

/**
 * `supertest` devolve `response.body` como `any` — e `any` num teste e pior
 * que em producao: a asserção passa a compilar contra QUALQUER shape, entao um
 * campo renomeado no contrato nao quebra nada e o teste vira decoracao (foi a
 * pendencia D1 da Onda 5). Estes dois helpers reancoram cada leitura no tipo
 * compartilhado, sem `as any` no meio.
 */
function bodyOf<T>(response: { body: unknown }): T {
  return response.body as T;
}

function errorOf(response: { body: unknown }): ApiErrorBody['error'] {
  return (response.body as ApiErrorBody).error;
}

/** `details` do erro, ja estreitado — o catalogo o declara opcional. */
function detailsOf(response: { body: unknown }): Record<string, unknown> {
  const { details } = errorOf(response);
  expect(details, 'o erro precisa trazer `details`').toBeDefined();
  return details as Record<string, unknown>;
}

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
      // Onda 6: os tres modulos novos entram aqui a pedido do
      // Agent-API-Patients e do Agent-API-Operation, que deixaram a varredura
      // de `denyPlatformOperator` para o QA justamente para nao disputarem
      // este arquivo entre si.
      patientModule,
      channelSettingsModule,
      operationModule,
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
      expect(errorOf(lista).code).toBe('FORBIDDEN');
      expect(detailsOf(lista).requiredRoles).toEqual(['platform_operator']);

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
    expect(errorOf(res).code).toBe('FORBIDDEN');
  });

  it('propostas, chat interno e tema tambem recusam', async () => {
    const headers = app.auth(operator);
    for (const path of [
      '/api/v1/proposals',
      '/api/v1/internal-chat/channels',
      '/api/v1/themes/current',
    ]) {
      const res = await app.agent.get(path).set(headers).expect(403);
      expect(errorOf(res).code).toBe('FORBIDDEN');
    }
  });

  /**
   * Onda 6 — pacientes, canais e operacao.
   *
   * "Sem acesso a conversas, PACIENTES e canais internos" (PAGES.md §11) e o
   * texto do requisito, e o `patients` dele so passou a existir nesta onda.
   * A leitura da ficha e a exportacao LGPD sao o dado mais sensivel do
   * produto: se alguma rota nova esquecesse `denyPlatformOperator()`, o
   * operador da plataforma leria o cadastro completo de um paciente de
   * qualquer laboratorio.
   */
  it('pacientes, canais & equipe e operacao recusam o operador da plataforma', async () => {
    const headers = app.auth(operator);
    const patientId = '00000000-0000-4000-8000-000000000003';

    const respostas = await Promise.all([
      app.agent.get('/api/v1/patients').set(headers),
      app.agent.get(`/api/v1/patients/${patientId}`).set(headers),
      app.agent.patch(`/api/v1/patients/${patientId}`).set(headers).send({ notes: 'sonda' }),
      app.agent.get(`/api/v1/patients/${patientId}/timeline`).set(headers),
      app.agent.get(`/api/v1/patients/${patientId}/export`).set(headers),
      app.agent
        .post(`/api/v1/patients/${patientId}/anonymize`)
        .set(headers)
        .send({ reason: 'sonda' }),
      app.agent.get('/api/v1/settings/channels').set(headers),
      app.agent.patch('/api/v1/settings/channels').set(headers).send({ distributionMode: 'manual' }),
      app.agent.get('/api/v1/operations/overview').set(headers),
    ]);

    for (const res of respostas) {
      expect(res.status).toBe(403);
      expect(errorOf(res).code).toBe('FORBIDDEN');
    }
  });

  /**
   * O 403 tem que vir do GUARD DE PLATAFORMA, nao da tabela de papeis.
   *
   * `GET /settings/channels` e `GET /operations/overview` sao gestor+ e
   * `POST /patients/:id/anonymize` e admin: sem `denyPlatformOperator()`
   * explicito o 403 apareceria de graca pelo `requireRoles`, e sumiria no dia
   * em que alguem afrouxasse os papeis. Os `requiredRoles` de LABORATORIO no
   * corpo provam quem recusou.
   */
  it('as rotas novas recusam pelo guard de plataforma, nao pelos papeis', async () => {
    const headers = app.auth(operator);
    const patientId = '00000000-0000-4000-8000-000000000003';

    const respostas = await Promise.all([
      app.agent.get('/api/v1/settings/channels').set(headers),
      app.agent.get('/api/v1/operations/overview').set(headers),
      app.agent
        .post(`/api/v1/patients/${patientId}/anonymize`)
        .set(headers)
        .send({ reason: 'sonda' }),
    ]);

    for (const res of respostas) {
      expect(res.status).toBe(403);
      expect(detailsOf(res).requiredRoles).toEqual(['attendant', 'manager', 'admin']);
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
      expect(errorOf(res).code).toBe('FORBIDDEN');
      expect(detailsOf(res).requiredRoles).toEqual(['attendant', 'manager', 'admin']);
    }
  });
});

describe('GET /platform/tenants', () => {
  it('lista os laboratorios com paginacao', async () => {
    await createTenant({ name: 'Lab Alfa', slug: 'lab-alfa', db });
    const res = await app.agent.get(`${BASE}/tenants`).set(app.auth(operator)).expect(200);
    const body = bodyOf<ListTenantsResponse>(res);

    expect(body.pagination).toMatchObject({ page: 1, limit: 20, total: 2 });
    const alfa = body.tenants.find((tenant) => tenant.slug === 'lab-alfa');
    expect(alfa).toMatchObject({ name: 'Lab Alfa', isActive: true, userCount: 0 });
  });

  it('aceita busca e filtro de status pela query string', async () => {
    await createTenant({ name: 'Lab Alfa', slug: 'lab-alfa', db });
    await createTenant({ name: 'Lab Beta', slug: 'lab-beta', isActive: false, db });

    const busca = await app.agent
      .get(`${BASE}/tenants?search=Beta`)
      .set(app.auth(operator))
      .expect(200);
    expect(bodyOf<ListTenantsResponse>(busca).tenants).toHaveLength(1);

    const inativos = await app.agent
      .get(`${BASE}/tenants?isActive=false`)
      .set(app.auth(operator))
      .expect(200);
    const inativosBody = bodyOf<ListTenantsResponse>(inativos);
    expect(inativosBody.tenants).toHaveLength(1);
    expect(inativosBody.tenants[0]?.slug).toBe('lab-beta');
  });
});

describe('POST /platform/tenants', () => {
  it('cria o laboratorio e devolve 201', async () => {
    const res = await app.agent
      .post(`${BASE}/tenants`)
      .set(app.auth(operator))
      .send(NEW_TENANT)
      .expect(201);

    // Recurso unico viaja CRU (D-070): era `{ tenant }` ate a Onda 5.
    const criado = bodyOf<CreateTenantResponse>(res);
    expect(criado).toMatchObject({
      name: 'Laboratorio Central',
      slug: 'lab-central',
      subscriptionPlan: 'starter',
      userCount: 1,
    });
    // `CreateTenantResponse` e `TenantSummary` cru: `tenant` nao existe no
    // tipo, entao a sonda do envelope antigo le a resposta como `unknown`.
    expect((res.body as Record<string, unknown>).tenant).toBeUndefined();
    // A senha do admin nunca volta na resposta.
    expect(JSON.stringify(criado)).not.toContain(NEW_TENANT.adminPassword);
  });

  it('slug duplicado devolve 409 CONFLICT', async () => {
    await app.agent.post(`${BASE}/tenants`).set(app.auth(operator)).send(NEW_TENANT).expect(201);
    const res = await app.agent
      .post(`${BASE}/tenants`)
      .set(app.auth(operator))
      .send({ ...NEW_TENANT, adminEmail: 'outro@lab.com.br' })
      .expect(409);
    expect(errorOf(res).code).toBe('CONFLICT');
    expect(detailsOf(res).field).toBe('slug');
  });

  it('DTO invalido devolve 400 com details.fields', async () => {
    const res = await app.agent
      .post(`${BASE}/tenants`)
      .set(app.auth(operator))
      .send({ ...NEW_TENANT, adminEmail: 'nao-e-email', adminPassword: '123' })
      .expect(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    expect(detailsOf(res).fields).toHaveProperty('adminEmail');
    expect(detailsOf(res).fields).toHaveProperty('adminPassword');
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
    const body = bodyOf<BillingResponse>(res);

    expect(body.usage).toHaveLength(2);
    expect(typeof body.totals.mrr).toBe('number');
    expect(body.totals.tenants).toBe(2);

    const alfa = body.usage.find((row) => row.tenantName === 'Lab Alfa');
    expect(alfa).toMatchObject({ plan: 'pro', messagesUsed: 0, extraMessages: 0 });
    // Dinheiro no fio e numero decimal, nunca string formatada (CLAUDE.md §9).
    expect(typeof alfa?.monthlyPrice).toBe('number');
  });
});
