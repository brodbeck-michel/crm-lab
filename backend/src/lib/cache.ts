/**
 * CacheService — interface unica, duas implementacoes (D-011).
 *
 * - `MemoryCache` (default): in-process, expira de verdade por timestamp.
 * - `RedisCache`  (quando `REDIS_URL` esta setado): mesma interface.
 *
 * TTLs esperados por SERVICES.md: catalogo de exames 1h (3600s),
 * analytics 5min (300s).
 */
import { env } from '../config/env.js';
import { logger } from './logger.js';

export interface CacheService {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Invalida todas as chaves com o prefixo dado (ex.: `exams:${tenantId}:`). */
  delByPrefix(prefix: string): Promise<void>;
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
 * Adaptador Redis.
 *
 * STUB: o cliente Redis ainda nao e dependencia do backend (D-011 permite
 * ligar depois trocando so a env var). Enquanto nao existe, esta classe
 * mantem o comportamento correto delegando para memoria e avisando UMA vez —
 * assim nada quebra em dev/CI sem Redis. Substituir o corpo pelos comandos
 * `GET/SETEX/DEL/SCAN` quando o cliente entrar no package.json.
 */
export class RedisCache implements CacheService {
  private readonly fallback = new MemoryCache();
  private warned = false;

  constructor(private readonly url: string) {}

  private warnOnce(): void {
    if (this.warned) return;
    this.warned = true;
    logger.warn('cache.redis_stub_in_use', {
      hasUrl: Boolean(this.url),
      detail: 'REDIS_URL definido mas o cliente Redis ainda nao esta implementado; usando memoria',
    });
  }

  async get<T>(key: string): Promise<T | null> {
    this.warnOnce();
    return this.fallback.get<T>(key);
  }
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.warnOnce();
    return this.fallback.set(key, value, ttlSeconds);
  }
  async del(key: string): Promise<void> {
    return this.fallback.del(key);
  }
  async delByPrefix(prefix: string): Promise<void> {
    return this.fallback.delByPrefix(prefix);
  }
  async close(): Promise<void> {
    return this.fallback.close();
  }
}

/** Escolhe a implementacao pelo ambiente. Testes constroem `MemoryCache` direto. */
export function createCache(): CacheService {
  if (env.REDIS_URL && !env.isTest) return new RedisCache(env.REDIS_URL);
  return new MemoryCache();
}
