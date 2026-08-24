import express from 'express';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../../src/lib/cache.js';
import { errorHandler } from '../../src/http/middleware/error-handler.js';
import { rateLimit } from '../../src/http/middleware/rate-limit.js';
import { requestContext } from '../../src/http/middleware/request-context.js';

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
