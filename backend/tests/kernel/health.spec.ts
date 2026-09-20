/**
 * Health honesto (CRMLAB-29).
 *
 * O que estes testes protegem: que `/api/v1/health` responda 503 quando uma
 * dependencia cai, e que a liveness NAO caia junto — foi exatamente a confusao
 * entre os dois papeis que deixou o deploy declarar "no ar" com o backend
 * morto. Caos de verdade (`docker stop postgres`) e em homologacao; aqui a
 * dependencia e simulada.
 */
import { describe, expect, it } from 'vitest';
import type { DbClient, QueryResult, Row } from '../../src/db/types.js';
import { MemoryCache, type CacheService } from '../../src/lib/cache.js';
import { createHealthChecker } from '../../src/lib/health.js';
import { createTestApp } from '../helpers/test-app.js';

/** DbClient minimo: so `query` importa para o health. */
function stubDb(query: () => Promise<QueryResult<Row>>): DbClient {
  const naoUsado = (): never => {
    throw new Error('o health nao deveria chamar este metodo');
  };
  return {
    driver: 'pg',
    query: query as DbClient['query'],
    exec: naoUsado,
    transaction: naoUsado as DbClient['transaction'],
    withTenant: naoUsado as DbClient['withTenant'],
    withoutTenant: naoUsado as DbClient['withoutTenant'],
    close: async () => {},
  };
}

const dbOk = (): DbClient =>
  stubDb(async () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }));

const dbFora = (): DbClient =>
  stubDb(async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
  });

/** Cache que responde a tudo, menos ao PING — e o Redis caido do mundo real. */
function cacheFora(): CacheService {
  const real = new MemoryCache();
  return {
    get: (key) => real.get(key),
    set: (key, value, ttl) => real.set(key, value, ttl),
    del: (key) => real.del(key),
    delByPrefix: (prefix) => real.delByPrefix(prefix),
    incr: (key, ttlSeconds) => real.incr(key, ttlSeconds),
    close: () => real.close(),
    ping: async () => {
      throw new Error('Redis nao respondeu ao PING');
    },
  };
}

describe('createHealthChecker', () => {
  it('reporta ok quando banco e cache respondem', async () => {
    const report = await createHealthChecker({ db: dbOk(), cache: new MemoryCache() })();

    expect(report.status).toBe('ok');
    expect(report.checks.database.status).toBe('up');
    expect(report.checks.cache.status).toBe('up');
    expect(report.checkedAt).toMatch(/Z$/);
  });

  it('reporta degraded e diz QUAL dependencia caiu', async () => {
    const report = await createHealthChecker({ db: dbFora(), cache: new MemoryCache() })();

    expect(report.status).toBe('degraded');
    expect(report.checks.database.status).toBe('down');
    expect(report.checks.database.error).toContain('ECONNREFUSED');
    // O cache continua de pe: o relatorio nao pode culpar quem esta vivo.
    expect(report.checks.cache.status).toBe('up');
  });

  it('marca `down` por TIMEOUT em vez de ficar pendurado', async () => {
    const pendurado = stubDb(() => new Promise<QueryResult<Row>>(() => {}));
    const report = await createHealthChecker({
      db: pendurado,
      cache: new MemoryCache(),
      timeoutMs: 10,
    })();

    expect(report.status).toBe('degraded');
    expect(report.checks.database.error).toContain('sem resposta');
  });

  it('memoiza dentro do TTL: monitor de 1 min nao vira N idas ao banco', async () => {
    let chamadas = 0;
    const db = stubDb(async () => {
      chamadas += 1;
      return { rows: [], rowCount: 0 };
    });
    let agora = 1_000;
    const check = createHealthChecker({
      db,
      cache: new MemoryCache(),
      ttlMs: 5_000,
      now: () => agora,
    });

    await check();
    await check();
    await check();
    expect(chamadas).toBe(1);

    agora += 5_001;
    await check();
    expect(chamadas).toBe(2);
  });

  it('checagens concorrentes compartilham a mesma execucao', async () => {
    let chamadas = 0;
    const db = stubDb(async () => {
      chamadas += 1;
      return { rows: [], rowCount: 0 };
    });
    const check = createHealthChecker({ db, cache: new MemoryCache(), ttlMs: 0 });

    await Promise.all([check(), check(), check()]);

    expect(chamadas).toBe(1);
  });
});

describe('GET /api/v1/health (readiness) e GET /health (liveness)', () => {
  it('200 com tudo no ar', async () => {
    const { agent } = await createTestApp();

    const res = await agent.get('/api/v1/health').expect(200);

    expect(res.body.status).toBe('ok');
    expect(res.body.checks.database.status).toBe('up');
    expect(res.body.checks.cache.status).toBe('up');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('503 com o banco fora, dizendo qual dependencia caiu', async () => {
    const { agent } = await createTestApp({ db: dbFora() });

    const res = await agent.get('/api/v1/health').expect(503);

    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.database.status).toBe('down');
  });

  it('503 com o cache fora', async () => {
    const { agent } = await createTestApp({ db: dbOk(), cache: cacheFora() });

    const res = await agent.get('/api/v1/health').expect(503);

    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.cache.status).toBe('down');
  });

  it('a liveness segue 200 com o banco fora — senao o container reinicia em loop', async () => {
    const { agent } = await createTestApp({ db: dbFora() });

    await agent.get('/health').expect(200);
    const res = await agent.get('/health/live').expect(200);

    expect(res.body.status).toBe('ok');
  });
});
