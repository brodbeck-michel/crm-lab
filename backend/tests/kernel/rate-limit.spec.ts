import { randomUUID } from 'node:crypto';
import express, { type Request } from 'express';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { applyTrustProxy } from '../../src/app.js';
import { MemoryCache } from '../../src/lib/cache.js';
import { errorHandler } from '../../src/http/middleware/error-handler.js';
import { rateLimit, rateLimitKey } from '../../src/http/middleware/rate-limit.js';
import { signAccessToken } from '../../src/lib/tokens.js';
import { requestContext } from '../../src/http/middleware/request-context.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

function buildApp(options: { limit: number; windowMs?: number; now?: () => number }) {
  const cache = new MemoryCache(options.now);
  const app = express();
  app.use(requestContext());
  app.use(
    rateLimit({
      cache,
      limit: options.limit,
      windowMs: options.windowMs ?? 60_000,
      now: options.now,
      keyResolver: () => 'chave-fixa-do-teste',
    }),
  );
  app.get('/ping', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler());
  return { agent: supertest(app), cache };
}

describe('rate-limit', () => {
  it('libera ate o limite e devolve os headers X-RateLimit-*', async () => {
    const { agent } = buildApp({ limit: 3 });

    const first = await agent.get('/ping');
    expect(first.status).toBe(200);
    expect(first.headers['x-ratelimit-limit']).toBe('3');
    expect(first.headers['x-ratelimit-remaining']).toBe('2');
    expect(first.headers['x-ratelimit-reset']).toBeTruthy();

    const second = await agent.get('/ping');
    expect(second.headers['x-ratelimit-remaining']).toBe('1');

    const third = await agent.get('/ping');
    expect(third.status).toBe(200);
    expect(third.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('dispara no limite: 429 RATE_LIMIT_EXCEEDED com details.retryAfter', async () => {
    const { agent } = buildApp({ limit: 2 });

    await agent.get('/ping');
    await agent.get('/ping');
    const blocked = await agent.get('/ping');

    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({
      error: { code: 'RATE_LIMIT_EXCEEDED', statusCode: 429 },
    });
    expect(typeof blocked.body.error.details.retryAfter).toBe('number');
    expect(blocked.body.error.details.retryAfter).toBeGreaterThan(0);
    expect(blocked.body.error.details.retryAfter).toBeLessThanOrEqual(60);
    expect(blocked.headers['retry-after']).toBe(String(blocked.body.error.details.retryAfter));
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('a janela desliza: passado o periodo, volta a liberar', async () => {
    let clock = 1_700_000_000_000;
    const { agent } = buildApp({ limit: 2, windowMs: 60_000, now: () => clock });

    await agent.get('/ping');
    await agent.get('/ping');
    expect((await agent.get('/ping')).status).toBe(429);

    clock += 61_000;
    const afterWindow = await agent.get('/ping');
    expect(afterWindow.status).toBe(200);
    expect(afterWindow.headers['x-ratelimit-remaining']).toBe('1');
  });

  it('usa o default de 100 req/min quando nada e informado', async () => {
    const cache = new MemoryCache();
    const app = express();
    app.use(requestContext());
    app.use(rateLimit({ cache, keyResolver: () => 'default-key' }));
    app.get('/ping', (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler());

    const res = await supertest(app).get('/ping');
    expect(res.headers['x-ratelimit-limit']).toBe('100');
  });
});

/**
 * ===========================================================================
 * A CHAVE PRECISA ENXERGAR O USUARIO AUTENTICADO
 * ===========================================================================
 * O limitador roda no kernel, ANTES de qualquer `requireAuth()` de rota — a
 * ordem esta em `app.ts` e nao da para inverter sem duplicar `requireAuth` em
 * todo modulo. Enquanto a chave dependia so de `req.ctx` (que so existe DEPOIS
 * do `requireAuth`), o ramo `user:<id>` era codigo morto: todo o trafego
 * autenticado de TODOS os tenants dividia um unico balde por IP. Atras de um
 * load balancer ou NAT isso e um laboratorio inteiro se autobloqueando — foi o
 * que derrubou a suite E2E com 429 em cascata.
 *
 * Por isso `rateLimitKey` deriva a identidade do proprio Bearer token, sem
 * escrever em `req.ctx`: popular o contexto fora do `requireAuth` faria uma
 * rota que esqueceu o middleware receber um contexto valido de brinde.
 */
describe('rate-limit — chave por usuario autenticado', () => {
  const usuario = (userId: string, tenantId: string): string =>
    signAccessToken({ userId, tenantId, role: 'attendant', discountLimit: 15 });

  function buildAuthApp(limit: number): ReturnType<typeof supertest> {
    const cache = new MemoryCache();
    const app = express();
    app.use(requestContext());
    app.use(rateLimit({ cache, limit }));
    app.get('/ping', (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler());
    return supertest(app);
  }

  it('dois usuarios do MESMO IP nao dividem o balde', async () => {
    const agent = buildAuthApp(2);
    const ana = `Bearer ${usuario(randomUUID(), TENANT_A)}`;
    const bruno = `Bearer ${usuario(randomUUID(), TENANT_A)}`;

    await agent.get('/ping').set('Authorization', ana).expect(200);
    await agent.get('/ping').set('Authorization', ana).expect(200);
    await agent.get('/ping').set('Authorization', ana).expect(429);

    // Bruno vem do mesmo IP (supertest sempre 127.0.0.1) e nao pode ser punido
    // pelo consumo da Ana.
    const dele = await agent.get('/ping').set('Authorization', bruno).expect(200);
    expect(dele.headers['x-ratelimit-remaining']).toBe('1');
  });

  it('tenants diferentes tambem nao dividem o balde', async () => {
    const agent = buildAuthApp(1);
    const doLabA = `Bearer ${usuario(randomUUID(), TENANT_A)}`;
    const doLabB = `Bearer ${usuario(randomUUID(), TENANT_B)}`;

    await agent.get('/ping').set('Authorization', doLabA).expect(200);
    await agent.get('/ping').set('Authorization', doLabA).expect(429);
    await agent.get('/ping').set('Authorization', doLabB).expect(200);
  });

  it('a chave sai do token, nao de req.ctx — e o token nao vira contexto', async () => {
    const userId = randomUUID();
    const req = {
      headers: { authorization: `Bearer ${usuario(userId, TENANT_A)}` },
      ip: '203.0.113.7',
      socket: {},
    } as unknown as Request;

    expect(rateLimitKey(req)).toBe(`user:${userId}`);
    // O limitador NAO autentica ninguem: `req.ctx` continua vazio.
    expect(req.ctx).toBeUndefined();
  });

  it('trafego anonimo e token invalido continuam por IP', async () => {
    // `x-forwarded-for` vai junto DE PROPOSITO: o balde tem que sair de
    // `req.ip` (resolvido pelo Express com a cadeia confiavel), nunca do
    // header cru — senao trocar o header a cada request zera o limite (D-057).
    const anonimo = {
      headers: { 'x-forwarded-for': '10.0.0.1' },
      ip: '198.51.100.4',
      socket: {},
    } as unknown as Request;
    expect(rateLimitKey(anonimo)).toBe('ip:198.51.100.4');

    const lixo = {
      headers: { authorization: 'Bearer nao-e-um-jwt', 'x-forwarded-for': '10.0.0.2' },
      ip: '198.51.100.4',
      socket: {},
    } as unknown as Request;
    // Token invalido nao ganha balde proprio: seria um bypass trivial do limite.
    expect(rateLimitKey(lixo)).toBe('ip:198.51.100.4');
  });

  it('login e webhook (rotas publicas) seguem por IP', async () => {
    const agent = buildAuthApp(1);
    await agent.post('/ping').send({}).expect(404); // rota inexistente, mas passou pelo limite
    const primeira = await agent.get('/ping').expect(429);
    expect(primeira.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });
});

/**
 * REGRESSAO D-057 — o balde por IP e o que protege as rotas PUBLICAS (login,
 * refresh, webhook). Enquanto `clientIp` lia `X-Forwarded-For` cru, trocar o
 * header a cada requisicao criava um balde novo e o limite virava enfeite.
 */
describe('rate-limit — X-Forwarded-For forjado nao cria balde novo', () => {
  function buildTrustedApp(limit: number): ReturnType<typeof supertest> {
    const cache = new MemoryCache();
    const app = express();
    applyTrustProxy(app); // exatamente o que `createApp` faz
    app.use(requestContext());
    app.use(rateLimit({ cache, limit }));
    app.get('/ping', (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler());
    return supertest(app);
  }

  it('50 requisicoes variando o header ainda batem no limite de 3', async () => {
    const agent = buildTrustedApp(3);
    const status: number[] = [];

    for (let i = 0; i < 50; i += 1) {
      const response = await agent.get('/ping').set('X-Forwarded-For', `10.0.0.${i}`);
      status.push(response.status);
    }

    expect(status.slice(0, 3)).toEqual([200, 200, 200]);
    expect(status.filter((s) => s === 429)).toHaveLength(47);
    expect(status.filter((s) => s === 200)).toHaveLength(3);
  });

  it('o header nem sequer separa o balde de dois "IPs" diferentes', async () => {
    const agent = buildTrustedApp(1);
    await agent.get('/ping').set('X-Forwarded-For', '203.0.113.1').expect(200);
    const segunda = await agent.get('/ping').set('X-Forwarded-For', '198.51.100.9').expect(429);
    expect(segunda.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });
});
