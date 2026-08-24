/**
 * `GET /analytics/conversion|pipeline|team` — API_CONTRACTS.md §5.
 *
 * O que se prova aqui e o que so aparece atravessando o HTTP: o papel do TOKEN
 * (nao um parametro da query) decide o escopo, o guard de papel recusa antes do
 * service, e o cache compartilhado do app nao entrega o numero de um perfil ao
 * outro entre duas requisicoes.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { analyticsModule } from '../../src/controllers/analytics.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createDatedProposal } from './helpers.js';

const BASE = '/api/v1/analytics';
const PERIOD = '?startDate=2026-08-01&endDate=2026-08-31';

let db: DbClient;
let app: TestApp;

interface Scenario {
  tenantId: string;
  manager: UserRecord;
  ana: UserRecord;
  bruno: UserRecord;
}

/**
 * Cenario minimo com aritmetica obvia:
 *   Ana   ganhou 1000 (fechado em agosto) e tem 1 proposta em aberto de 250
 *   Bruno ganhou 3000 (fechado em agosto)
 * Time = 4000. Ana sozinha = 1000.
 */
async function seed(): Promise<Scenario> {
  const tenant = await createTenant({ db });
  const manager = await createUser({ tenantId: tenant.id, role: 'manager', name: 'Gestora', db });
  const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana', db });
  const bruno = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Bruno', db });

  await createDatedProposal({
    tenantId: tenant.id,
    createdBy: ana.id,
    status: 'ganho',
    totalPrice: 1000,
    createdAt: '2026-08-02 10:00:00',
    closedAt: '2026-08-05 10:00:00',
    db,
  });
  await createDatedProposal({
    tenantId: tenant.id,
    createdBy: bruno.id,
    status: 'ganho',
    totalPrice: 3000,
    createdAt: '2026-08-03 10:00:00',
    closedAt: '2026-08-06 10:00:00',
    db,
  });
  await createDatedProposal({
    tenantId: tenant.id,
    createdBy: ana.id,
    status: 'follow_up',
    totalPrice: 250,
    createdAt: '2026-08-04 10:00:00',
    db,
  });

  return { tenantId: tenant.id, manager, ana, bruno };
}

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  // App novo por teste = cache novo. Os testes de cache criam o seu de proposito.
  app = await createTestApp({ db, modules: [analyticsModule] });
});

describe('GET /analytics/conversion', () => {
  it('exige autenticacao', async () => {
    const res = await app.agent.get(`${BASE}/conversion`).expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('gestor recebe os numeros do time, com dinheiro em NUMERO', async () => {
    const scenario = await seed();
    const res = await app.agent
      .get(`${BASE}/conversion${PERIOD}`)
      .set(app.auth(scenario.manager))
      .expect(200);

    expect(res.body.partial).toBe(false);
    expect(res.body.revenue).toBe(4000);
    expect(res.body.averageTicket).toBe(2000);
    expect(res.body.funnel.ganho).toBe(2);
    // Dinheiro no fio e numero decimal, nunca "R$ 4.000,00" (D-018).
    expect(typeof res.body.revenue).toBe('number');
    expect(typeof res.body.topPerformers[0].revenue).toBe('number');
    expect(Object.keys(res.body.lossReasons)).toHaveLength(5);
  });

  it('atendente recebe partial:true e apenas as proprias metricas', async () => {
    const scenario = await seed();
    const res = await app.agent
      .get(`${BASE}/conversion${PERIOD}`)
      .set(app.auth(scenario.ana))
      .expect(200);

    expect(res.body.partial).toBe(true);
    expect(res.body.revenue).toBe(1000);
    expect(res.body.topPerformers).toHaveLength(1);
    expect(res.body.topPerformers[0].userId).toBe(scenario.ana.id);
  });

  it('o escopo vem do token, nao da query — atendente nao pede o time', async () => {
    const scenario = await seed();
    const res = await app.agent
      // Parametros forjados: o service nem os le.
      .get(`${BASE}/conversion${PERIOD}&scope=all&partial=false&createdBy=`)
      .set(app.auth(scenario.ana))
      .expect(200);

    expect(res.body.partial).toBe(true);
    expect(res.body.revenue).toBe(1000);
  });

  it('periodo invertido devolve VALIDATION_ERROR com details.fields', async () => {
    const scenario = await seed();
    const res = await app.agent
      .get(`${BASE}/conversion?startDate=2026-08-31&endDate=2026-08-01`)
      .set(app.auth(scenario.manager))
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.fields).toHaveProperty('endDate');
  });

  it('data em formato invalido devolve VALIDATION_ERROR', async () => {
    const scenario = await seed();
    const res = await app.agent
      .get(`${BASE}/conversion?startDate=ontem`)
      .set(app.auth(scenario.manager))
      .expect(400);
    expect(res.body.error.details.fields).toHaveProperty('startDate');
  });

  it('BLOQUEANTE: numero de outro tenant nao aparece', async () => {
    const scenario = await seed();
    const outro = await createTenant({ db });
    const intruso = await createUser({ tenantId: outro.id, role: 'manager', db });
    await createDatedProposal({
      tenantId: outro.id,
      createdBy: intruso.id,
      status: 'ganho',
      totalPrice: 777_000,
      createdAt: '2026-08-02 10:00:00',
      closedAt: '2026-08-03 10:00:00',
      db,
    });

    const res = await app.agent
      .get(`${BASE}/conversion${PERIOD}`)
      .set(app.auth(scenario.manager))
      .expect(200);
    expect(res.body.revenue).toBe(4000);
  });
});

describe('cache entre requisicoes', () => {
  it('nao serve o numero do gestor para o atendente (mesmo app, mesmo cache)', async () => {
    const scenario = await seed();

    const gestor = await app.agent
      .get(`${BASE}/conversion${PERIOD}`)
      .set(app.auth(scenario.manager))
      .expect(200);
    const atendente = await app.agent
      .get(`${BASE}/conversion${PERIOD}`)
      .set(app.auth(scenario.ana))
      .expect(200);

    expect(gestor.body.revenue).toBe(4000);
    expect(gestor.body.partial).toBe(false);
    expect(atendente.body.revenue).toBe(1000);
    expect(atendente.body.partial).toBe(true);
  });

  it('nao serve o numero de um tenant para outro', async () => {
    const scenario = await seed();

    const outro = await createTenant({ db });
    const gestorB = await createUser({ tenantId: outro.id, role: 'manager', db });
    await createDatedProposal({
      tenantId: outro.id,
      createdBy: gestorB.id,
      status: 'ganho',
      totalPrice: 55,
      createdAt: '2026-08-02 10:00:00',
      closedAt: '2026-08-03 10:00:00',
      db,
    });

    const a = await app.agent
      .get(`${BASE}/conversion${PERIOD}`)
      .set(app.auth(scenario.manager))
      .expect(200);
    const b = await app.agent
      .get(`${BASE}/conversion${PERIOD}`)
      .set(app.auth(gestorB))
      .expect(200);

    expect(a.body.revenue).toBe(4000);
    expect(b.body.revenue).toBe(55);
  });
});

describe('GET /analytics/pipeline', () => {
  it('devolve os 6 estagios e o que esta em aberto', async () => {
    const scenario = await seed();
    const res = await app.agent
      .get(`${BASE}/pipeline`)
      .set(app.auth(scenario.manager))
      .expect(200);

    expect(Object.keys(res.body.byStatus)).toHaveLength(6);
    expect(res.body.openCount).toBe(1);
    expect(res.body.totalValue).toBe(250);
    expect(res.body.oldestProposal).toMatchObject({ status: 'follow_up' });
    expect(typeof res.body.totalValue).toBe('number');
  });

  it('atendente sem proposta aberta recebe oldestProposal null', async () => {
    const scenario = await seed();
    const res = await app.agent
      .get(`${BASE}/pipeline`)
      .set(app.auth(scenario.bruno))
      .expect(200);
    expect(res.body.oldestProposal).toBeNull();
    expect(res.body.openCount).toBe(0);
  });
});

describe('GET /analytics/team', () => {
  it('atendente recebe FORBIDDEN', async () => {
    const scenario = await seed();
    const res = await app.agent
      .get(`${BASE}/team${PERIOD}`)
      .set(app.auth(scenario.ana))
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.details.requiredRoles).toEqual(['manager', 'admin']);
  });

  it('gestor recebe a tabela do time com os totais fechando', async () => {
    const scenario = await seed();
    const res = await app.agent
      .get(`${BASE}/team${PERIOD}`)
      .set(app.auth(scenario.manager))
      .expect(200);

    expect(res.body.totals).toMatchObject({ created: 3, won: 2, revenue: 4000 });
    const soma = res.body.members.reduce(
      (total: number, m: { revenue: number }) => total + m.revenue,
      0,
    );
    expect(soma).toBe(res.body.totals.revenue);
  });

  it('admin tambem pode', async () => {
    const scenario = await seed();
    const admin = await createUser({ tenantId: scenario.tenantId, role: 'admin', db });
    await app.agent.get(`${BASE}/team${PERIOD}`).set(app.auth(admin)).expect(200);
  });
});

describe('console da plataforma nao le metrica de laboratorio', () => {
  it('platform_operator recebe FORBIDDEN nas tres rotas', async () => {
    const scenario = await seed();
    const operador = { ...scenario.manager, role: 'platform_operator' as const };

    for (const path of ['/conversion', '/pipeline', '/team']) {
      const res = await app.agent
        .get(`${BASE}${path}${PERIOD}`)
        .set(app.auth(operador))
        .expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });
});
