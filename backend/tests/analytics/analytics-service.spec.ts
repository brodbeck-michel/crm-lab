/**
 * AnalyticsService — SERVICES.md §9.
 *
 * O foco destes testes NAO e "o metodo respondeu": e a ARITMETICA. Cada cenario
 * monta propostas com valores conhecidos e confere o numero contra a conta
 * feita a mao. Um funil que responde 200 com o total errado e pior que um erro
 * 500 — ninguem percebe.
 *
 * Cenario base (tenant A, periodo 2026-08-01..2026-08-31), montado por
 * `seedScenario()`:
 *
 *  #   criada       estagio             total   fechada      autor
 *  1   2026-08-02   novo_contato          100   —            p1
 *  2   2026-08-03   novo_contato          200   —            p2
 *  3   2026-08-04   orcamento_enviado     300   —            p1
 *  4   2026-08-05   follow_up             400   —            p1
 *  5   2026-08-06   negociacao            500   —            p2
 *  6   2026-08-07   ganho                1000   2026-08-10   p1
 *  7   2026-08-08   ganho                2000   2026-08-20   p2
 *  8   2026-08-09   perdido (preco)       700   2026-08-15   p1
 *  9   2026-08-11   perdido (silencio)    800   2026-08-16   p2
 * 10   2026-07-20   ganho                6000   2026-08-25   p1  <- fora do funil
 * 11   2026-08-12   ganho                9000   2026-09-02   p1  <- fora da receita
 *
 * As duas ultimas linhas existem para provar que as janelas de tempo sao
 * mesmo duas (criacao para o funil, fechamento para a receita) e que a borda de
 * data e respeitada em UTC.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TenantContext } from '../../src/http/context.js';
import type { DbClient } from '../../src/db/types.js';
import { MemoryCache } from '../../src/lib/cache.js';
import {
  createAnalyticsService,
  resolvePeriod,
  type AnalyticsService,
} from '../../src/services/analytics.service.js';
import { createTenant, createUser, type UserRecord } from '../helpers/factories.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createDatedProposal, ctxOf } from './helpers.js';

const PERIOD = { startDate: '2026-08-01', endDate: '2026-08-31' };
/** Relogio fixo: `daysOpen` e o periodo padrao nao podem depender do dia real. */
const NOW = new Date('2026-09-01T00:00:00.000Z');

let db: DbClient;

interface Scenario {
  tenantId: string;
  manager: UserRecord;
  p1: UserRecord;
  p2: UserRecord;
  managerCtx: TenantContext;
  p1Ctx: TenantContext;
}

async function seedScenario(): Promise<Scenario> {
  const tenant = await createTenant({ db });
  const manager = await createUser({ tenantId: tenant.id, role: 'manager', name: 'Gestora', db });
  const p1 = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana', db });
  const p2 = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Bruno', db });

  const rows: Array<{
    createdAt: string;
    status: string;
    totalPrice: number;
    closedAt?: string;
    reasonLost?: string;
    by: string;
  }> = [
    { createdAt: '2026-08-02 00:00:00', status: 'novo_contato', totalPrice: 100, by: p1.id },
    { createdAt: '2026-08-03 10:00:00', status: 'novo_contato', totalPrice: 200, by: p2.id },
    { createdAt: '2026-08-04 10:00:00', status: 'orcamento_enviado', totalPrice: 300, by: p1.id },
    { createdAt: '2026-08-05 10:00:00', status: 'follow_up', totalPrice: 400, by: p1.id },
    { createdAt: '2026-08-06 10:00:00', status: 'negociacao', totalPrice: 500, by: p2.id },
    {
      createdAt: '2026-08-07 10:00:00',
      status: 'ganho',
      totalPrice: 1000,
      closedAt: '2026-08-10 10:00:00',
      by: p1.id,
    },
    {
      createdAt: '2026-08-08 10:00:00',
      status: 'ganho',
      totalPrice: 2000,
      closedAt: '2026-08-20 10:00:00',
      by: p2.id,
    },
    {
      createdAt: '2026-08-09 10:00:00',
      status: 'perdido',
      totalPrice: 700,
      closedAt: '2026-08-15 10:00:00',
      reasonLost: 'preco',
      by: p1.id,
    },
    {
      createdAt: '2026-08-11 10:00:00',
      status: 'perdido',
      totalPrice: 800,
      closedAt: '2026-08-16 10:00:00',
      reasonLost: 'silencio',
      by: p2.id,
    },
    {
      createdAt: '2026-07-20 10:00:00',
      status: 'ganho',
      totalPrice: 6000,
      closedAt: '2026-08-25 10:00:00',
      by: p1.id,
    },
    {
      createdAt: '2026-08-12 10:00:00',
      status: 'ganho',
      totalPrice: 9000,
      closedAt: '2026-09-02 10:00:00',
      by: p1.id,
    },
  ];

  for (const row of rows) {
    await createDatedProposal({
      tenantId: tenant.id,
      createdBy: row.by,
      status: row.status,
      totalPrice: row.totalPrice,
      ...(row.reasonLost !== undefined ? { reasonLost: row.reasonLost } : {}),
      createdAt: row.createdAt,
      ...(row.closedAt !== undefined ? { closedAt: row.closedAt } : {}),
      db,
    });
  }

  return {
    tenantId: tenant.id,
    manager,
    p1,
    p2,
    managerCtx: ctxOf(manager),
    p1Ctx: ctxOf(p1),
  };
}

function service(cache = new MemoryCache()): AnalyticsService {
  return createAnalyticsService({ db, cache, now: () => NOW });
}

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
});

describe('getConversionFunnel — os numeros fecham', () => {
  it('conta cada estagio pelas propostas CRIADAS no periodo', async () => {
    const scenario = await seedScenario();
    const report = await service().getConversionFunnel(scenario.managerCtx, PERIOD);

    expect(report.funnel).toEqual({
      novoContato: 2,
      orcamentoEnviado: 1,
      followUp: 1,
      negociacao: 1,
      // #6, #7 e #11. A #10 foi criada em julho: aparece na receita, nao aqui.
      ganho: 3,
      perdido: 2,
      // 3 ganhos / 10 criadas no periodo
      conversionRate: 30,
    });

    const criadas = Object.entries(report.funnel)
      .filter(([key]) => key !== 'conversionRate')
      .reduce((total, [, value]) => total + value, 0);
    expect(criadas).toBe(10);
    // A taxa e exatamente a razao calculada a mao, nao um numero parecido.
    expect(report.funnel.conversionRate).toBe(
      Math.round((report.funnel.ganho / criadas) * 10000) / 100,
    );
  });

  it('revenue e a soma exata dos ganhos fechados no periodo', async () => {
    const scenario = await seedScenario();
    const report = await service().getConversionFunnel(scenario.managerCtx, PERIOD);

    // #6 (1000) + #7 (2000) + #10 (6000). A #11 fechou em setembro.
    expect(report.revenue).toBe(9000);
    expect(report.averageTicket).toBe(3000);
    expect(typeof report.revenue).toBe('number');
  });

  it('revenue muda quando a proposta sai do periodo — borda de data em UTC', async () => {
    const tenant = await createTenant({ db });
    const user = await createUser({ tenantId: tenant.id, role: 'manager', db });
    const ctx = ctxOf(user);

    // Ultimo instante do dia final: DENTRO.
    await createDatedProposal({
      tenantId: tenant.id,
      createdBy: user.id,
      status: 'ganho',
      totalPrice: 500,
      createdAt: '2026-08-30 10:00:00',
      closedAt: '2026-08-31 23:59:59',
      db,
    });
    // Primeiro instante do dia seguinte: FORA.
    await createDatedProposal({
      tenantId: tenant.id,
      createdBy: user.id,
      status: 'ganho',
      totalPrice: 400,
      createdAt: '2026-08-30 10:00:00',
      closedAt: '2026-09-01 00:00:00',
      db,
    });
    // Instante anterior ao inicio: FORA.
    await createDatedProposal({
      tenantId: tenant.id,
      createdBy: user.id,
      status: 'ganho',
      totalPrice: 300,
      createdAt: '2026-07-10 10:00:00',
      closedAt: '2026-07-31 23:59:59',
      db,
    });

    const report = await service().getConversionFunnel(ctx, PERIOD);
    expect(report.revenue).toBe(500);
    expect(report.averageTicket).toBe(500);

    // Esticar o periodo em um dia traz a proposta de volta — mesma origem,
    // janela diferente.
    const wider = await service().getConversionFunnel(ctx, {
      startDate: '2026-08-01',
      endDate: '2026-09-01',
    });
    expect(wider.revenue).toBe(900);
  });

  it('averageTicket e 0 (nao NaN) quando nao ha nenhum ganho no periodo', async () => {
    const tenant = await createTenant({ db });
    const user = await createUser({ tenantId: tenant.id, role: 'manager', db });
    await createDatedProposal({
      tenantId: tenant.id,
      createdBy: user.id,
      status: 'follow_up',
      totalPrice: 250,
      createdAt: '2026-08-05 10:00:00',
      db,
    });

    const report = await service().getConversionFunnel(ctxOf(user), PERIOD);
    expect(report.revenue).toBe(0);
    expect(report.averageTicket).toBe(0);
    expect(Number.isNaN(report.averageTicket)).toBe(false);
    expect(report.funnel.conversionRate).toBe(0);
  });

  it('lossReasons traz as 5 chaves, com zero onde nao houve perda', async () => {
    const scenario = await seedScenario();
    const report = await service().getConversionFunnel(scenario.managerCtx, PERIOD);

    expect(report.lossReasons).toEqual({
      preco: 1,
      silencio: 1,
      exame_indisponivel: 0,
      prazo: 0,
      outro: 0,
    });
    // O grafico do frontend depende disso: 5 fatias, nenhuma faltando.
    expect(Object.keys(report.lossReasons)).toHaveLength(5);
    // E a soma fecha com o estagio perdido do funil.
    const soma = Object.values(report.lossReasons).reduce((a, b) => a + b, 0);
    expect(soma).toBe(report.funnel.perdido);
  });

  it('ordena topPerformers por receita, com a conta de cada um', async () => {
    const scenario = await seedScenario();
    const report = await service().getConversionFunnel(scenario.managerCtx, PERIOD);

    expect(report.topPerformers).toEqual([
      { userId: scenario.p1.id, name: 'Ana', conversions: 2, revenue: 7000 },
      { userId: scenario.p2.id, name: 'Bruno', conversions: 1, revenue: 2000 },
    ]);
    const soma = report.topPerformers.reduce((total, row) => total + row.revenue, 0);
    expect(soma).toBe(report.revenue);
  });

  it('BLOQUEANTE: proposta de outro tenant nao entra em nenhum numero', async () => {
    const scenario = await seedScenario();

    const outro = await createTenant({ db });
    const intruso = await createUser({ tenantId: outro.id, role: 'manager', db });
    await createDatedProposal({
      tenantId: outro.id,
      createdBy: intruso.id,
      status: 'ganho',
      totalPrice: 999_999,
      createdAt: '2026-08-05 10:00:00',
      closedAt: '2026-08-06 10:00:00',
      db,
    });
    await createDatedProposal({
      tenantId: outro.id,
      createdBy: intruso.id,
      status: 'perdido',
      reasonLost: 'prazo',
      totalPrice: 123,
      createdAt: '2026-08-05 10:00:00',
      closedAt: '2026-08-06 10:00:00',
      db,
    });

    const report = await service().getConversionFunnel(scenario.managerCtx, PERIOD);
    expect(report.revenue).toBe(9000);
    expect(report.funnel.ganho).toBe(3);
    expect(report.funnel.perdido).toBe(2);
    expect(report.lossReasons.prazo).toBe(0);
    expect(report.topPerformers.map((p) => p.userId)).not.toContain(intruso.id);

    const snapshot = await service().getPipelineSnapshot(scenario.managerCtx);
    expect(snapshot.byStatus.ganho.value).toBe(18_000);
  });
});

describe('escopo dentro do tenant', () => {
  it('atendente recebe partial:true e SO os proprios numeros', async () => {
    const scenario = await seedScenario();
    const report = await service().getConversionFunnel(scenario.p1Ctx, PERIOD);

    expect(report.partial).toBe(true);
    // Criadas por Ana no periodo: #1, #3, #4, #6, #8, #11 = 6
    expect(report.funnel).toEqual({
      novoContato: 1,
      orcamentoEnviado: 1,
      followUp: 1,
      negociacao: 0,
      ganho: 2,
      perdido: 1,
      conversionRate: 33.33,
    });
    // Ganhos de Ana fechados em agosto: #6 (1000) + #10 (6000)
    expect(report.revenue).toBe(7000);
    expect(report.averageTicket).toBe(3500);
    expect(report.lossReasons).toEqual({
      preco: 1,
      silencio: 0,
      exame_indisponivel: 0,
      prazo: 0,
      outro: 0,
    });
    expect(report.topPerformers).toEqual([
      { userId: scenario.p1.id, name: 'Ana', conversions: 2, revenue: 7000 },
    ]);
  });

  it('gestor recebe os numeros do time e partial:false', async () => {
    const scenario = await seedScenario();
    const report = await service().getConversionFunnel(scenario.managerCtx, PERIOD);
    expect(report.partial).toBe(false);
    expect(report.revenue).toBe(9000);
  });

  it('o cache NAO serve o numero do gestor para o atendente', async () => {
    const scenario = await seedScenario();
    // MESMA instancia de cache, mesma janela: e exatamente o caso em que uma
    // chave so por (tenant, periodo) vazaria o time inteiro para o atendente.
    const shared = service(new MemoryCache());

    const gestor = await shared.getConversionFunnel(scenario.managerCtx, PERIOD);
    const atendente = await shared.getConversionFunnel(scenario.p1Ctx, PERIOD);

    expect(gestor.revenue).toBe(9000);
    expect(gestor.partial).toBe(false);
    expect(atendente.revenue).toBe(7000);
    expect(atendente.partial).toBe(true);

    // E na ordem inversa tambem (o atendente esquenta o cache primeiro).
    const outro = service(new MemoryCache());
    const primeiro = await outro.getConversionFunnel(scenario.p1Ctx, PERIOD);
    const segundo = await outro.getConversionFunnel(scenario.managerCtx, PERIOD);
    expect(primeiro.revenue).toBe(7000);
    expect(segundo.revenue).toBe(9000);
  });

  it('o cache tambem nao mistura dois atendentes nem dois periodos', async () => {
    const scenario = await seedScenario();
    const shared = service(new MemoryCache());

    const ana = await shared.getConversionFunnel(scenario.p1Ctx, PERIOD);
    const bruno = await shared.getConversionFunnel(ctxOf(scenario.p2), PERIOD);
    expect(ana.revenue).toBe(7000);
    expect(bruno.revenue).toBe(2000);

    const julho = await shared.getConversionFunnel(scenario.managerCtx, {
      startDate: '2026-07-01',
      endDate: '2026-07-31',
    });
    expect(julho.revenue).toBe(0);
    expect(julho.funnel.ganho).toBe(1); // #10 foi criada em julho
  });

  it('serve do cache dentro do TTL (segunda chamada nao reflete escrita nova)', async () => {
    const scenario = await seedScenario();
    const shared = service(new MemoryCache());

    const antes = await shared.getConversionFunnel(scenario.managerCtx, PERIOD);
    await createDatedProposal({
      tenantId: scenario.tenantId,
      createdBy: scenario.p1.id,
      status: 'ganho',
      totalPrice: 5000,
      createdAt: '2026-08-20 10:00:00',
      closedAt: '2026-08-21 10:00:00',
      db,
    });
    const depois = await shared.getConversionFunnel(scenario.managerCtx, PERIOD);
    expect(depois.revenue).toBe(antes.revenue);

    // Cache novo (equivalente ao TTL expirado) ja enxerga a proposta.
    expect(
      (await service(new MemoryCache()).getConversionFunnel(scenario.managerCtx, PERIOD)).revenue,
    ).toBe(14_000);
  });

  it('platform_operator nao le metrica de laboratorio', async () => {
    const scenario = await seedScenario();
    const operador = ctxOf({ ...scenario.manager, role: 'platform_operator' });
    await expect(service().getConversionFunnel(operador, PERIOD)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(service().getPipelineSnapshot(operador)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('periodo', () => {
  it('recusa formato invalido com VALIDATION_ERROR e details.fields', async () => {
    const scenario = await seedScenario();
    await expect(
      service().getConversionFunnel(scenario.managerCtx, { startDate: '01/08/2026' }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { fields: { startDate: expect.any(String) } },
    });
  });

  it('recusa data inexistente no calendario', () => {
    expect(() => resolvePeriod({ startDate: '2026-02-30' }, NOW)).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });

  it('recusa periodo invertido apontando o campo endDate', async () => {
    const scenario = await seedScenario();
    await expect(
      service().getConversionFunnel(scenario.managerCtx, {
        startDate: '2026-08-31',
        endDate: '2026-08-01',
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { fields: { endDate: expect.any(String) } },
    });
  });

  it('sem datas, usa um padrao sensato (ultimos 30 dias, terminando hoje em UTC)', () => {
    const period = resolvePeriod({}, NOW);
    expect(period.endDate).toBe('2026-09-01');
    expect(period.startDate).toBe('2026-08-03');
    expect(period.bounds).toEqual({
      start: '2026-08-03 00:00:00',
      endExclusive: '2026-09-02 00:00:00',
    });
  });

  it('endDate e inclusivo: o limite superior e o dia seguinte as 00:00', () => {
    expect(resolvePeriod({ startDate: '2026-08-01', endDate: '2026-08-31' }, NOW).bounds).toEqual({
      start: '2026-08-01 00:00:00',
      endExclusive: '2026-09-01 00:00:00',
    });
  });

  it('devolve o periodo efetivamente aplicado no payload', async () => {
    const scenario = await seedScenario();
    const report = await service().getConversionFunnel(scenario.managerCtx, PERIOD);
    expect(report.period).toEqual({ startDate: '2026-08-01', endDate: '2026-08-31' });
  });
});

describe('getPipelineSnapshot', () => {
  it('traz os 6 estagios, o valor em aberto e a proposta mais antiga', async () => {
    const scenario = await seedScenario();
    const snapshot = await service().getPipelineSnapshot(scenario.managerCtx);

    expect(snapshot.byStatus).toEqual({
      novo_contato: { count: 2, value: 300 },
      orcamento_enviado: { count: 1, value: 300 },
      follow_up: { count: 1, value: 400 },
      negociacao: { count: 1, value: 500 },
      ganho: { count: 4, value: 18_000 },
      perdido: { count: 2, value: 1500 },
    });

    // Em aberto = os 4 estagios nao terminais: 2 + 1 + 1 + 1
    expect(snapshot.openCount).toBe(5);
    expect(snapshot.totalValue).toBe(1500);
    expect(snapshot.averageTicket).toBe(300);

    // Mais antiga EM ABERTO e a #1 (2026-08-02) — a #10, de julho, ja fechou.
    expect(snapshot.oldestProposal).toEqual({
      id: expect.any(String),
      status: 'novo_contato',
      daysOpen: 30, // 2026-08-02 -> 2026-09-01
    });
  });

  it('oldestProposal e null quando nao ha proposta aberta', async () => {
    const tenant = await createTenant({ db });
    const user = await createUser({ tenantId: tenant.id, role: 'manager', db });
    await createDatedProposal({
      tenantId: tenant.id,
      createdBy: user.id,
      status: 'ganho',
      totalPrice: 100,
      createdAt: '2026-08-01 10:00:00',
      closedAt: '2026-08-02 10:00:00',
      db,
    });

    const snapshot = await service().getPipelineSnapshot(ctxOf(user));
    expect(snapshot.oldestProposal).toBeNull();
    expect(snapshot.openCount).toBe(0);
    expect(snapshot.totalValue).toBe(0);
    expect(snapshot.averageTicket).toBe(0);
    expect(snapshot.byStatus.novo_contato).toEqual({ count: 0, value: 0 });
  });

  it('tenant sem nenhuma proposta devolve os 6 estagios zerados', async () => {
    const tenant = await createTenant({ db });
    const user = await createUser({ tenantId: tenant.id, role: 'admin', db });
    const snapshot = await service().getPipelineSnapshot(ctxOf(user));
    expect(Object.keys(snapshot.byStatus)).toHaveLength(6);
    expect(snapshot.oldestProposal).toBeNull();
  });

  it('atendente ve apenas o proprio pipeline', async () => {
    const scenario = await seedScenario();
    const snapshot = await service().getPipelineSnapshot(scenario.p1Ctx);
    // Abertas de Ana: #1 (100), #3 (300), #4 (400)
    expect(snapshot.openCount).toBe(3);
    expect(snapshot.totalValue).toBe(800);
    expect(snapshot.byStatus.ganho).toEqual({ count: 3, value: 16_000 });
  });
});

describe('getTeamPerformance', () => {
  it('exige gestor/admin', async () => {
    const scenario = await seedScenario();
    await expect(
      service().getTeamPerformance(scenario.p1Ctx, PERIOD),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', details: { requiredRoles: ['manager', 'admin'] } });
  });

  it('fecha a conta de cada atendente e os totais', async () => {
    const scenario = await seedScenario();
    const report = await service().getTeamPerformance(scenario.managerCtx, PERIOD);

    const porId = new Map(report.members.map((m) => [m.userId, m]));
    expect(porId.get(scenario.p1.id)).toEqual({
      userId: scenario.p1.id,
      name: 'Ana',
      created: 6,
      won: 2,
      lost: 1,
      conversionRate: 33.33,
      revenue: 7000,
      averageTicket: 3500,
    });
    expect(porId.get(scenario.p2.id)).toEqual({
      userId: scenario.p2.id,
      name: 'Bruno',
      created: 4,
      won: 1,
      lost: 1,
      conversionRate: 25,
      revenue: 2000,
      averageTicket: 2000,
    });
    // Gestora nao criou nada: aparece zerada, nao some da tabela.
    expect(porId.get(scenario.manager.id)).toMatchObject({
      created: 0,
      won: 0,
      revenue: 0,
      conversionRate: 0,
      averageTicket: 0,
    });

    expect(report.totals).toEqual({
      created: 10,
      won: 3,
      lost: 2,
      conversionRate: 30,
      revenue: 9000,
      averageTicket: 3000,
    });

    // Os totais do time batem com o funil do mesmo periodo — mesma origem.
    const funnel = await service().getConversionFunnel(scenario.managerCtx, PERIOD);
    expect(report.totals.revenue).toBe(funnel.revenue);
    expect(report.totals.conversionRate).toBe(funnel.funnel.conversionRate);
  });

  it('nao enxerga usuario nem proposta de outro tenant', async () => {
    const scenario = await seedScenario();
    const outro = await createTenant({ db });
    const intruso = await createUser({ tenantId: outro.id, role: 'attendant', name: 'Espia', db });
    await createDatedProposal({
      tenantId: outro.id,
      createdBy: intruso.id,
      status: 'ganho',
      totalPrice: 50_000,
      createdAt: '2026-08-05 10:00:00',
      closedAt: '2026-08-06 10:00:00',
      db,
    });

    const report = await service().getTeamPerformance(scenario.managerCtx, PERIOD);
    expect(report.members.map((m) => m.userId)).not.toContain(intruso.id);
    expect(report.totals.revenue).toBe(9000);
  });
});
