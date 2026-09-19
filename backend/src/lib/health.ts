/**
 * Health HONESTO — readiness com dependencias de verdade (CRMLAB-29).
 *
 * Duas sondas, dois papeis diferentes, e a diferenca importa:
 *
 *   LIVENESS  (`GET /health`, `GET /health/live`)  -> "o processo esta vivo?"
 *     Trivial de proposito. E o que o `HEALTHCHECK` do Dockerfile e o
 *     `docker compose` consultam. Se ele checasse Postgres, uma queda do banco
 *     marcaria o backend como unhealthy e o orquestrador o reiniciaria em loop
 *     — matando as conexoes WebSocket abertas e jogando fora o cache em
 *     memoria para consertar um problema que NAO e do backend.
 *
 *   READINESS (`GET /api/v1/health`)               -> "o sistema serve?"
 *     Faz `SELECT 1` no pool e `PING` no cache e responde 503 quando uma
 *     dependencia cai, dizendo QUAL. E o que o `deploy.sh` e o monitor externo
 *     consultam; e passa pelo proxy `/api/` do nginx, entao e alcançavel de
 *     fora (o `/healthz` da borda e `return 200` do proprio nginx e nunca
 *     tocou o backend — auditoria de 19/09/2026).
 *
 * Custo: o resultado e memoizado por `HEALTH_CACHE_TTL_MS` e as checagens
 * concorrentes compartilham a MESMA execucao (single-flight). Um monitor
 * batendo a cada minuto — ou dez monitores — nao multiplica ida ao banco, e
 * nenhuma delas abre transacao: `SELECT 1` solto no pool, com timeout curto,
 * para um Postgres pendurado devolver 503 em vez de pendurar o health junto.
 */
import type { DbClient } from '../db/types.js';
import type { CacheService } from './cache.js';
import { logger } from './logger.js';

/** Janela em que uma resposta ja calculada e reaproveitada. */
export const HEALTH_CACHE_TTL_MS = 5_000;

/** Teto por dependencia. Estourou = `down`, nao "esperando". */
export const HEALTH_TIMEOUT_MS = 2_000;

export interface DependencyCheck {
  status: 'up' | 'down';
  latencyMs: number;
  /** So quando `down`: mensagem do erro ou do timeout. */
  error?: string;
}

export interface HealthReport {
  /** `ok` = todas as dependencias responderam. `degraded` = pelo menos uma caiu. */
  status: 'ok' | 'degraded';
  driver: DbClient['driver'];
  /** Segundos desde o boot do processo. */
  uptime: number;
  /** ISO 8601 UTC do momento em que ESTE relatorio foi medido (pode vir do cache). */
  checkedAt: string;
  checks: {
    database: DependencyCheck;
    cache: DependencyCheck;
  };
}

export interface HealthCheckerOptions {
  db: DbClient;
  cache: CacheService;
  /** Default: `HEALTH_CACHE_TTL_MS`. `0` desliga a memoizacao (usado em teste). */
  ttlMs?: number;
  /** Default: `HEALTH_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Injetaveis para teste sem esperar wall-clock. */
  now?: () => number;
  uptime?: () => number;
}

export type HealthChecker = () => Promise<HealthReport>;

async function probe(
  run: () => Promise<unknown>,
  timeoutMs: number,
  now: () => number,
): Promise<DependencyCheck> {
  const started = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`sem resposta em ${timeoutMs}ms`)),
          timeoutMs,
        );
        // Sem `unref`, um timer pendente segura o event loop no shutdown.
        timer.unref();
      }),
    ]);
    return { status: 'up', latencyMs: now() - started };
  } catch (err) {
    return {
      status: 'down',
      latencyMs: now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Devolve a funcao que produz o relatorio. Uma instancia por app: e ela que
 * guarda o cache curto e o single-flight.
 */
export function createHealthChecker(options: HealthCheckerOptions): HealthChecker {
  const { db, cache } = options;
  const ttlMs = options.ttlMs ?? HEALTH_CACHE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const now = options.now ?? ((): number => Date.now());
  const uptime = options.uptime ?? ((): number => process.uptime());

  let cached: { at: number; report: HealthReport } | undefined;
  let inFlight: Promise<HealthReport> | undefined;

  async function measure(): Promise<HealthReport> {
    const [database, cacheCheck] = await Promise.all([
      // `query` solto no pool: sem `BEGIN`/`COMMIT`, sem `SET LOCAL ROLE`.
      // Nao le dado de tenant nenhum, entao nao passa por `withTenant`.
      probe(() => db.query('SELECT 1'), timeoutMs, now),
      probe(() => cache.ping(), timeoutMs, now),
    ]);

    const status: HealthReport['status'] =
      database.status === 'up' && cacheCheck.status === 'up' ? 'ok' : 'degraded';

    if (status === 'degraded') {
      logger.error('health.degraded', {
        database: database.status,
        databaseError: database.error,
        cache: cacheCheck.status,
        cacheError: cacheCheck.error,
      });
    }

    return {
      status,
      driver: db.driver,
      uptime: uptime(),
      checkedAt: new Date(now()).toISOString(),
      checks: { database, cache: cacheCheck },
    };
  }

  return async function checkHealth(): Promise<HealthReport> {
    const hit = cached;
    if (hit && now() - hit.at < ttlMs) return hit.report;

    inFlight ??= measure().finally(() => {
      inFlight = undefined;
    });

    const report = await inFlight;
    cached = { at: now(), report };
    return report;
  };
}
