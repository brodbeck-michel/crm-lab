/**
 * CacheService — interface unica, duas implementacoes (D-011).
 *
 * - `MemoryCache` (default): in-process, expira de verdade por timestamp.
 * - `RedisCache`  (quando `REDIS_URL` esta setado): mesma interface.
 *
 * TTLs esperados por SERVICES.md: catalogo de exames 1h (3600s),
 * analytics 5min (300s).
 */
import Redis from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export interface CacheService {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Invalida todas as chaves com o prefixo dado (ex.: `exams:${tenantId}:`). */
  delByPrefix(prefix: string): Promise<void>;
  /**
   * Verifica que o backing store responde. `MemoryCache`: no-op.
   * Usado no boot para falhar rapido em vez de degradar em silencio (D-058).
   */
  ping(): Promise<void>;
  /** Libera recursos (conexao Redis / timers). */
  close(): Promise<void>;
}

interface Entry {
  value: unknown;
  /** Epoch ms em que a entrada deixa de valer. */
  expiresAt: number;
}

export class MemoryCache implements CacheService {
  private readonly store = new Map<string, Entry>();

  /** Injetavel para teste de expiracao sem esperar wall-clock. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  private live(key: string): Entry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.live(key);
    return entry ? (entry.value as T) : null;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async delByPrefix(prefix: string): Promise<void> {
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  async ping(): Promise<void> {
    // Sempre disponivel: o store E o processo.
  }

  async close(): Promise<void> {
    this.store.clear();
  }

  /** Somente para diagnostico/teste. */
  get size(): number {
    for (const key of [...this.store.keys()]) this.live(key);
    return this.store.size;
  }
}

/**
 * Superficie MINIMA do Redis que o `CacheService` usa (D-058).
 *
 * Existe por dois motivos: manter `cache.ts` livre dos tipos sobrecarregados do
 * `ioredis` e permitir que o teste injete um duplo com a semantica de verdade
 * (strings, TTL, SCAN por glob) sem subir um servidor.
 */
export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  /** `SET key value EX ttl`. */
  setEx(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(keys: string[]): Promise<void>;
  /** `SCAN cursor MATCH pattern COUNT count`. */
  scan(cursor: string, pattern: string, count: number): Promise<{ cursor: string; keys: string[] }>;
  ping(): Promise<void>;
  quit(): Promise<void>;
}

export type RedisClientFactory = (url: string) => RedisClientLike;

/** Quantas chaves o `SCAN` pede por volta em `delByPrefix`. */
const SCAN_COUNT = 100;

/** Caracteres especiais do glob do Redis, neutralizados no prefixo. */
function escapeGlob(text: string): string {
  return text.replace(/[\\*?[\]]/g, (ch) => `\\${ch}`);
}

function defaultRedisClient(url: string): RedisClientLike {
  const client = new Redis(url, {
    // Sem fila offline: comando enviado com o Redis fora do ar falha na hora em
    // vez de ficar pendurado — o chamador precisa saber que o cache caiu.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    lazyConnect: true,
  });
  client.on('error', (err: Error) => {
    logger.error('cache.redis_error', { message: err.message });
  });

  return {
    get: (key) => client.get(key),
    setEx: async (key, value, ttlSeconds) => {
      await client.set(key, value, 'EX', ttlSeconds);
    },
    del: async (keys) => {
      if (keys.length > 0) await client.del(...keys);
    },
    scan: async (cursor, pattern, count) => {
      const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', count);
      return { cursor: next, keys };
    },
    ping: async () => {
      await client.connect().catch((err: unknown) => {
        // `connect()` de uma conexao ja pronta rejeita; so o PING decide.
        if (!(err instanceof Error) || !err.message.includes('already connect')) throw err;
      });
      await client.ping();
    },
    quit: async () => {
      await client.quit();
    },
  };
}

/**
 * Adaptador Redis de verdade (D-058).
 *
 * Antes daqui havia um stub que delegava para um `MemoryCache` in-process e
 * emitia um `warn`. Com `REDIS_URL` setado em producao (docker-compose.prod.yml
 * define), isso deixava POR PROCESSO as tres coisas que dependem deste cache:
 * o balde do rate limit (com N instancias, N x 100/min), o contador de lockout
 * de login (N x 5 tentativas) e a invalidacao de analytics da D-055 (o
 * relatorio obsoleto sobrevivia na instancia que nao recebeu a mutacao).
 *
 * Valores trafegam como JSON. TTL <= 0 apaga a chave, para casar com a
 * semantica do `MemoryCache` (`SET ... EX 0` seria erro de protocolo).
 */
export class RedisCache implements CacheService {
  private readonly client: RedisClientLike;

  constructor(url: string, clientFactory: RedisClientFactory = defaultRedisClient) {
    this.client = clientFactory(url);
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Chave escrita por outra versao/servico: trata como miss e nao derruba
      // o request. Quem chamou recalcula.
      logger.warn('cache.redis_invalid_json', { key });
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) {
      await this.client.del([key]);
      return;
    }
    await this.client.setEx(key, JSON.stringify(value), ttlSeconds);
  }

  async del(key: string): Promise<void> {
    await this.client.del([key]);
  }

  async delByPrefix(prefix: string): Promise<void> {
    const pattern = `${escapeGlob(prefix)}*`;
    let cursor = '0';
    do {
      const page = await this.client.scan(cursor, pattern, SCAN_COUNT);
      cursor = page.cursor;
      if (page.keys.length > 0) await this.client.del(page.keys);
    } while (cursor !== '0');
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

/** Escolhe a implementacao pelo ambiente. Testes constroem `MemoryCache` direto. */
export function createCache(): CacheService {
  if (env.REDIS_URL && !env.isTest) return new RedisCache(env.REDIS_URL);
  return new MemoryCache();
}

export class CacheUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      'REDIS_URL esta definido mas o Redis nao respondeu ao PING. ' +
        'O boot para aqui de proposito (D-058): rate limit, lockout de login e ' +
        'invalidacao de analytics ficariam por processo, e um cache silenciosamente ' +
        'degradado nao protege nenhum dos tres. Suba o Redis ou remova REDIS_URL. ' +
        `Causa: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'CacheUnavailableError';
  }
}

/**
 * FAIL-CLOSED (D-058): chamado no boot. `MemoryCache` passa direto (dev/CI sem
 * Redis continuam subindo); `RedisCache` so passa se o servidor responder.
 */
export async function verifyCacheReady(cache: CacheService): Promise<void> {
  try {
    await cache.ping();
  } catch (err) {
    throw new CacheUnavailableError(err);
  }
}
