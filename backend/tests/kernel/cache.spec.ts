import { describe, expect, it } from 'vitest';
import {
  MemoryCache,
  RedisCache,
  verifyCacheReady,
  type RedisClientLike,
} from '../../src/lib/cache.js';

/**
 * Redis de mentira, mas com a semantica de verdade: guarda STRINGS, expira por
 * TTL e responde SCAN por padrao glob. Serve para provar que `RedisCache` fala
 * o protocolo — o que o stub antigo (delegando para memoria) nao provava.
 */
class FakeRedis implements RedisClientLike {
  readonly store = new Map<string, { value: string; expiresAt: number }>();
  pingFails = false;
  quitCalls = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  private live(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key);
  }

  async setEx(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async del(keys: string[]): Promise<void> {
    for (const key of keys) this.store.delete(key);
  }

  async scan(cursor: string, pattern: string, count: number): Promise<{ cursor: string; keys: string[] }> {
    const all = [...this.store.keys()].filter((key) => globMatch(pattern, key));
    const from = Number(cursor);
    const page = all.slice(from, from + count);
    const next = from + count >= all.length ? '0' : String(from + count);
    return { cursor: next, keys: page };
  }

  /** Reproduz `INCR_EX_SCRIPT`: INCR + EXPIRE condicional, sem `await` no meio. */
  async incrEx(key: string, ttlSeconds: number): Promise<number> {
    const entry = this.store.get(key);
    const alive = entry !== undefined && entry.expiresAt > this.now();
    if (!alive) {
      this.store.set(key, { value: '1', expiresAt: this.now() + ttlSeconds * 1000 });
      return 1;
    }
    const next = Number(entry.value) + 1;
    entry.value = String(next);
    return next;
  }

  async ping(): Promise<void> {
    if (this.pingFails) throw new Error('ECONNREFUSED 127.0.0.1:6379');
  }

  async quit(): Promise<void> {
    this.quitCalls += 1;
  }
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Glob do Redis reduzido ao que `delByPrefix` usa: literais, `\` e `*`. */
function globMatch(pattern: string, key: string): boolean {
  let regex = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\') {
      i += 1;
      regex += escapeRe(pattern[i] ?? '');
      continue;
    }
    regex += ch === '*' ? '.*' : escapeRe(ch ?? '');
  }
  return new RegExp(`^${regex}$`).test(key);
}

describe('CacheService (in-memory)', () => {
  it('get/set/del basicos', async () => {
    const cache = new MemoryCache();
    expect(await cache.get('ausente')).toBeNull();

    await cache.set('k', { a: 1 }, 60);
    expect(await cache.get<{ a: number }>('k')).toEqual({ a: 1 });

    await cache.del('k');
    expect(await cache.get('k')).toBeNull();
  });

  it('expira de verdade no TTL do catalogo (1h)', async () => {
    let clock = 1_000_000;
    const cache = new MemoryCache(() => clock);

    await cache.set('exams:tenant-a', ['exame'], 3600);
    clock += 3599 * 1000;
    expect(await cache.get('exams:tenant-a')).toEqual(['exame']);

    clock += 2 * 1000; // passou de 3600s
    expect(await cache.get('exams:tenant-a')).toBeNull();
  });

  it('expira no TTL do analytics (5min)', async () => {
    let clock = 0;
    const cache = new MemoryCache(() => clock);

    await cache.set('analytics:tenant-a:conversion', { rate: 0.42 }, 300);
    clock += 299_000;
    expect(await cache.get('analytics:tenant-a:conversion')).not.toBeNull();

    clock += 2_000;
    expect(await cache.get('analytics:tenant-a:conversion')).toBeNull();
  });

  it('delByPrefix invalida so o prefixo pedido', async () => {
    const cache = new MemoryCache();
    await cache.set('exams:tenant-a:1', 1, 60);
    await cache.set('exams:tenant-a:2', 2, 60);
    await cache.set('exams:tenant-b:1', 3, 60);

    await cache.delByPrefix('exams:tenant-a:');

    expect(await cache.get('exams:tenant-a:1')).toBeNull();
    expect(await cache.get('exams:tenant-a:2')).toBeNull();
    expect(await cache.get('exams:tenant-b:1')).toBe(3);
  });

  it('entrada expirada nao conta no tamanho (nao vaza memoria)', async () => {
    let clock = 0;
    const cache = new MemoryCache(() => clock);
    await cache.set('a', 1, 10);
    await cache.set('b', 2, 100);
    expect(cache.size).toBe(2);

    clock += 20_000;
    expect(cache.size).toBe(1);
  });

  it('TTL zero expira imediatamente', async () => {
    const cache = new MemoryCache();
    await cache.set('efemera', 1, 0);
    expect(await cache.get('efemera')).toBeNull();
  });

  /**
   * D-139: `incr` substitui o `get`+`set` do rate limit/lockout de login
   * justamente por nao ter TOCTOU. Sob `Promise.all` (100 chamadas
   * concorrentes de verdade, nao sequenciais) o resultado tem que ser
   * exatamente 1..100, sem incremento perdido.
   */
  it('incr e atomico sob concorrencia — 100 chamadas paralelas rendem 1..100 sem perda', async () => {
    const cache = new MemoryCache();
    const results = await Promise.all(
      Array.from({ length: 100 }, () => cache.incr('contador', 60)),
    );
    expect([...results].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 100 }, (_, i) => i + 1),
    );
  });

  it('incr aplica o TTL so na primeira chamada (janela fixa)', async () => {
    let clock = 0;
    const cache = new MemoryCache(() => clock);

    expect(await cache.incr('janela', 60)).toBe(1);
    clock += 30_000;
    expect(await cache.incr('janela', 60)).toBe(2); // TTL nao foi resetado pro 2o incr
    clock += 31_000; // passou dos 60s da 1a chamada
    expect(await cache.incr('janela', 60)).toBe(1); // chave expirou, comecou de novo
  });
});

/**
 * D-058: `RedisCache` deixou de ser stub. O que importa aqui e que ele FALE com
 * o cliente injetado — se voltar a delegar para um `MemoryCache` interno, o
 * balde de rate limit, o contador de lockout e a invalidacao de analytics
 * voltam a ser por processo (com N instancias, N x o limite).
 */
describe('RedisCache (cliente injetado)', () => {
  it('get/set/del passam pelo cliente Redis, nao por memoria local', async () => {
    const client = new FakeRedis();
    const cache = new RedisCache('redis://fake:6379', () => client);

    await cache.set('analytics:t1:funnel', { revenue: 179.8 }, 300);
    // A prova de que nao ha memoria paralela: o dado esta NO cliente.
    expect(client.store.has('analytics:t1:funnel')).toBe(true);
    expect(await cache.get<{ revenue: number }>('analytics:t1:funnel')).toEqual({ revenue: 179.8 });

    await cache.del('analytics:t1:funnel');
    expect(client.store.size).toBe(0);
    expect(await cache.get('analytics:t1:funnel')).toBeNull();
  });

  it('duas instancias do processo compartilham o MESMO Redis', async () => {
    const client = new FakeRedis();
    const instanciaA = new RedisCache('redis://fake:6379', () => client);
    const instanciaB = new RedisCache('redis://fake:6379', () => client);

    await instanciaA.set('login-failures:joao@lab.com:10.0.0.1', 5, 900);
    // Sem isto, o lockout de 5/15min vira 5 x N instancias.
    expect(await instanciaB.get<number>('login-failures:joao@lab.com:10.0.0.1')).toBe(5);
  });

  it('serializa como JSON e sobrevive ao round-trip de string', async () => {
    const client = new FakeRedis();
    const cache = new RedisCache('redis://fake:6379', () => client);

    await cache.set('ratelimit:ip:1.2.3.4', [1, 2, 3], 60);
    expect(client.store.get('ratelimit:ip:1.2.3.4')?.value).toBe('[1,2,3]');
    expect(await cache.get<number[]>('ratelimit:ip:1.2.3.4')).toEqual([1, 2, 3]);
  });

  it('valor corrompido no Redis vira miss, nao excecao', async () => {
    const client = new FakeRedis();
    client.store.set('quebrado', { value: '{nao-e-json', expiresAt: Date.now() + 60_000 });
    const cache = new RedisCache('redis://fake:6379', () => client);

    expect(await cache.get('quebrado')).toBeNull();
  });

  it('respeita o TTL (analytics 5min)', async () => {
    let clock = 0;
    const client = new FakeRedis(() => clock);
    const cache = new RedisCache('redis://fake:6379', () => client);

    await cache.set('analytics:t1:conversion', { rate: 0.42 }, 300);
    clock += 299_000;
    expect(await cache.get('analytics:t1:conversion')).not.toBeNull();
    clock += 2_000;
    expect(await cache.get('analytics:t1:conversion')).toBeNull();
  });

  it('TTL zero nao grava (mesma semantica do MemoryCache)', async () => {
    const client = new FakeRedis();
    const cache = new RedisCache('redis://fake:6379', () => client);

    await cache.set('efemera', 1, 0);
    expect(await cache.get('efemera')).toBeNull();
    expect(client.store.size).toBe(0);
  });

  it('delByPrefix varre por SCAN e nao encosta em outro tenant (regra 1)', async () => {
    const client = new FakeRedis();
    const cache = new RedisCache('redis://fake:6379', () => client);

    for (let i = 0; i < 25; i += 1) {
      await cache.set(`analytics:tenant-a:relatorio-${i}`, i, 300);
    }
    await cache.set('analytics:tenant-b:relatorio-0', 'do outro lab', 300);

    await cache.delByPrefix('analytics:tenant-a:');

    expect([...client.store.keys()]).toEqual(['analytics:tenant-b:relatorio-0']);
  });

  it('close encerra a conexao', async () => {
    const client = new FakeRedis();
    const cache = new RedisCache('redis://fake:6379', () => client);
    await cache.get('qualquer');
    await cache.close();
    expect(client.quitCalls).toBe(1);
  });

  it('incr delega pro incrEx do cliente (INCR + EXPIRE atomico no servidor)', async () => {
    const client = new FakeRedis();
    const cache = new RedisCache('redis://fake:6379', () => client);

    expect(await cache.incr('ratelimit:ip:1.2.3.4:100', 60)).toBe(1);
    expect(await cache.incr('ratelimit:ip:1.2.3.4:100', 60)).toBe(2);
    expect(client.store.get('ratelimit:ip:1.2.3.4:100')?.value).toBe('2');
  });
});

/**
 * D-058: fail-closed. Com `REDIS_URL` definido e Redis fora do ar, o boot
 * PARA — nao degrada em silencio para memoria (um `warn` que ninguem le nao
 * protege rate limit, lockout nem invalidacao de analytics).
 */
describe('verifyCacheReady', () => {
  it('MemoryCache passa (dev/CI sem Redis continua subindo)', async () => {
    await expect(verifyCacheReady(new MemoryCache())).resolves.toBeUndefined();
  });

  it('Redis fora do ar derruba o boot com mensagem clara', async () => {
    const client = new FakeRedis();
    client.pingFails = true;
    const cache = new RedisCache('redis://indisponivel:6379', () => client);

    await expect(verifyCacheReady(cache)).rejects.toThrow(/REDIS_URL/);
    await expect(verifyCacheReady(cache)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('Redis no ar passa', async () => {
    const cache = new RedisCache('redis://fake:6379', () => new FakeRedis());
    await expect(verifyCacheReady(cache)).resolves.toBeUndefined();
  });
});
