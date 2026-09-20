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
   * Incrementa `key` atomicamente e devolve o novo valor (D-139). O TTL e
   * aplicado SO na primeira increment (quando o valor recem-criado volta 1) —
   * janela fixa: a chave nasce no primeiro hit e expira sozinha depois de
   * `ttlSeconds`, sem round-trip extra de leitura+escrita.
   *
   * Existe para substituir o padrao `get` -> calcula -> `set`, que e um TOCTOU
   * classico: duas requisicoes concorrentes leem o MESMO estado, as duas
   * calculam "ainda cabe" e as duas escrevem, perdendo um incremento. Com
   * `RedisCache` isto roda como um UNICO comando atomico no servidor (script
   * Lua) — nao ha janela entre leitura e escrita para outra requisicao entrar.
   */
  incr(key: string, ttlSeconds: number): Promise<number>;
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

  /**
   * Sem `await` no corpo: roda ate o fim de uma so vez, dentro do MESMO tick.
   * E isso que torna atomico mesmo sob `Promise.all` — nao ha ponto onde o
   * event loop possa intercalar outra chamada no meio da leitura+escrita.
   */
  async incr(key: string, ttlSeconds: number): Promise<number> {
    const entry = this.live(key);
    if (!entry) {
      const next = 1;
      this.store.set(key, { value: next, expiresAt: this.now() + ttlSeconds * 1000 });
      return next;
    }
    const next = (entry.value as number) + 1;
    entry.value = next;
    return next;
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
  /**
   * `INCR key` + `EXPIRE key ttl` (SO na primeira increment) num UNICO
   * round-trip ao Redis — e o que torna `CacheService.incr` atomico de
   * verdade. Ver `INCR_EX_SCRIPT`.
   */
  incrEx(key: string, ttlSeconds: number): Promise<number>;
  ping(): Promise<void>;
  quit(): Promise<void>;
}

export type RedisClientFactory = (url: string) => RedisClientLike;

/** Quantas chaves o `SCAN` pede por volta em `delByPrefix`. */
const SCAN_COUNT = 100;

/**
 * Script Lua de `incrEx`: `INCR` + `EXPIRE` condicional num UNICO comando
 * atomico no servidor Redis (D-139). O `EXPIRE` so roda quando `current == 1`
 * (chave recem-criada nesta chamada) — reaplicar TTL a cada hit faria uma
 * janela sob trafego continuo nunca expirar.
 */
const INCR_EX_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`;

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
    incrEx: async (key, ttlSeconds) => {
      const result = await client.eval(INCR_EX_SCRIPT, 1, key, ttlSeconds);
      return Number(result);
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

  async incr(key: string, ttlSeconds: number): Promise<number> {
    return this.client.incrEx(key, ttlSeconds);
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

/**
 * FAIL-OPEN/FAIL-CLOSED em runtime (D-139) — distinto do fail-closed do BOOT
 * acima. Uma queda do Redis DEPOIS de subido nao pode virar 500 global
 * (`rate-limit.ts` e `auth.service.ts` sao os dois chamadores): rota
 * autenticada degrada fail-open (o JWT ja protege) e so loga; rota publica
 * (`/auth/login`, `/auth/refresh`, `/webhooks/*`) degrada fail-closed com 503
 * `SERVICE_UNAVAILABLE`, porque sem rate limit/lockout nessas rotas o Redis
 * fora do ar vira convite a forca bruta.
 *
 * Throttle de `CACHE_UNAVAILABLE_LOG_THROTTLE_MS`: sob uma queda real o mesmo
 * evento dispararia a cada request (centenas/min) e afogaria o log logo no
 * incidente que mais precisa ser visto.
 */
const CACHE_UNAVAILABLE_LOG_THROTTLE_MS = 30_000;
let lastCacheUnavailableLogAt = 0;

export function logCacheUnavailable(
  context: Record<string, unknown>,
  now: () => number = () => Date.now(),
): void {
  const at = now();
  if (at - lastCacheUnavailableLogAt < CACHE_UNAVAILABLE_LOG_THROTTLE_MS) return;
  lastCacheUnavailableLogAt = at;
  logger.error('cache.unavailable', context);
}

/** Uso exclusivo de teste: reseta a janela de throttle entre casos. */
export function resetCacheUnavailableThrottleForTest(): void {
  lastCacheUnavailableLogAt = 0;
}
