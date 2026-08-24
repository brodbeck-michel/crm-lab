/**
 * Montagem do app Express.
 *
 * Ordem dos middlewares (nao reordene sem motivo):
 *   helmet -> cors -> json -> request-context -> rate-limit
 *   -> GET /health (publico) -> /api/v1/<modulos> -> 404 -> error-handler
 *
 * O error-handler e SEMPRE o ultimo.
 */
import express, { Router, type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import type { DbClient } from './db/types.js';
import type { CacheService } from './lib/cache.js';
import { createCache } from './lib/cache.js';
import { noopWsHub, type WsHub } from './lib/ws-hub.js';
import { type ApiModule, type ApiModuleDeps, type ApiModuleFactory } from './http/api-module.js';
import { apiModuleFactories } from './http/modules.js';
import { errorHandler, notFoundHandler } from './http/middleware/error-handler.js';
import { rateLimit } from './http/middleware/rate-limit.js';
import { requestContext } from './http/middleware/request-context.js';

export const API_PREFIX = '/api/v1';

export interface AppDeps {
  db: DbClient;
  cache?: CacheService;
  wsHub?: WsHub;
  /**
   * Modulos a montar. Default: `apiModuleFactories` de `src/http/modules.ts`.
   * Testes passam so o que precisam.
   */
  moduleFactories?: ApiModuleFactory[];
}

export interface BuiltApp {
  app: Express;
  cache: CacheService;
  wsHub: WsHub;
  modules: ApiModule[];
}

/** Monta os routers dos modulos sob `/api/v1`, recusando `basePath` duplicado. */
export function mountApiModules(
  api: Router,
  factories: ApiModuleFactory[],
  deps: ApiModuleDeps,
): ApiModule[] {
  const seen = new Map<string, ApiModule>();
  for (const factory of factories) {
    const mod = factory(deps);
    if (!mod.basePath.startsWith('/')) {
      throw new Error(`ApiModule.basePath deve comecar com "/": recebido "${mod.basePath}"`);
    }
    if (seen.has(mod.basePath)) {
      throw new Error(
        `Dois modulos de API declaram o mesmo basePath "${mod.basePath}". ` +
          'Ajuste em src/http/modules.ts.',
      );
    }
    seen.set(mod.basePath, mod);
    api.use(mod.basePath, mod.router);
  }
  return [...seen.values()];
}

/**
 * Cadeia de proxies confiavel (D-057) — ponto UNICO onde `X-Forwarded-For`
 * ganha (ou nao) credibilidade.
 *
 * O valor sai de `TRUSTED_PROXIES` / `TRUST_PROXY_HOPS`, com default `false`:
 * sem configuracao explicita o header e ignorado e `req.ip` e o endereco do
 * socket. `trust proxy: true` (o que havia aqui) confia em QUALQUER proxy, o
 * que na pratica e confiar no cliente — e o cliente alimenta o balde do rate
 * limit, o contador de lockout de login e o `ip_address` do audit log.
 *
 * Exportada para que os testes montem um app com a MESMA configuracao do real.
 */
export function applyTrustProxy(app: Express): void {
  app.set('trust proxy', env.trustProxy);
}

export function createApp(deps: AppDeps): BuiltApp {
  const cache = deps.cache ?? createCache();
  const wsHub = deps.wsHub ?? noopWsHub;
  const app = express();

  applyTrustProxy(app);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: false,
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-Id'],
      exposedHeaders: [
        'X-Correlation-Id',
        'X-RateLimit-Limit',
        'X-RateLimit-Remaining',
        'X-RateLimit-Reset',
        'Retry-After',
      ],
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(requestContext());

  // Publico e fora do rate limit: usado por health check de container/LB.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', driver: deps.db.driver, uptime: process.uptime() });
  });

  // O limitador fica aqui de proposito, ANTES dos routers: `requireAuth()` e
  // por rota, entao nao existe ponto unico "depois da autenticacao" onde
  // montar. Quem resolve a identidade e a propria chave — `rateLimitKey`
  // verifica o Bearer token e limita por usuario; rota publica (login,
  // refresh, webhook) fica por IP. Ver o cabecalho de `rate-limit.ts`.
  app.use(rateLimit({ cache }));

  const api = Router();
  const modules = mountApiModules(api, deps.moduleFactories ?? apiModuleFactories, {
    db: deps.db,
    cache,
    wsHub,
  });
  app.use(API_PREFIX, api);

  app.use(notFoundHandler());
  app.use(errorHandler()); // SEMPRE por ultimo

  return { app, cache, wsHub, modules };
}
