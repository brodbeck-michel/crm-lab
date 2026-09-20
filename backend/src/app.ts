/**
 * Montagem do app Express.
 *
 * Ordem dos middlewares (nao reordene sem motivo):
 *   helmet -> cors -> json -> request-context
 *   -> sondas de saude (GET /health, /health/live, /api/v1/health — publicas)
 *   -> rate-limit -> /api/v1/<modulos> -> 404 -> error-handler
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
import { createHealthChecker } from './lib/health.js';
import { noopWsHub, type WsHub } from './lib/ws-hub.js';
import { type ApiModule, type ApiModuleDeps, type ApiModuleFactory } from './http/api-module.js';
import { apiModuleFactories } from './http/modules.js';
import { errorHandler, notFoundHandler } from './http/middleware/error-handler.js';
import { isChannelWebhook, rateLimit } from './http/middleware/rate-limit.js';
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
      // `X-Requested-With` (D-142): header exigido por `POST /auth/refresh`.
      // Sem CORS credenciado o cookie não atravessa mesmo assim (D-143 é o
      // que resolve isso via mesmo origin), mas sem o header na allow-list o
      // preflight de um cliente cross-origin genuíno rejeitaria antes de
      // chegar na rota.
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-Id', 'X-Requested-With'],
      exposedHeaders: [
        'X-Correlation-Id',
        'X-RateLimit-Limit',
        'X-RateLimit-Remaining',
        'X-RateLimit-Reset',
        'Retry-After',
      ],
    }),
  );
  // `verify` guarda os bytes exatos do corpo em `req.rawBody` ANTES do parse.
  // `rawBodyOf` (webhook.routes.ts) prefere esse campo para a verificacao HMAC
  // do webhook: comparar contra uma reserializacao de `req.body` ja parseado
  // (JSON.stringify) perde formatacao do corpo original (espacos, por
  // exemplo) e faz a assinatura nunca bater, mesmo com o segredo certo.
  app.use(
    express.json({
      // 25mb: mídia viaja em base64 dentro do JSON (Onda 8 §4.3, MediaService
      // teto de 15 MiB por arquivo) — base64 infla ~33%, mais a margem do
      // envelope JSON. O teto de negocio (`MEDIA_TOO_LARGE`, 413 explicito)
      // continua sendo o de `MediaService`; este e so o limite de transporte.
      limit: '25mb',
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(requestContext());

  // --- Sondas de saude (CRMLAB-29) --------------------------------------
  // Publicas e fora do rate limit: um monitor batendo a cada minuto nao pode
  // consumir a cota de ninguem, e um health que responde 429 nao serve de
  // health. Ver o cabecalho de `lib/health.ts` para o porque de serem DUAS.
  //
  // LIVENESS: trivial. `HEALTHCHECK` do Dockerfile e compose apontam para ca.
  // Nao consulta dependencia de proposito — queda do Postgres nao pode
  // reiniciar o container do backend em loop.
  const liveness: express.RequestHandler = (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'ok', driver: deps.db.driver, uptime: process.uptime() });
  };
  app.get('/health', liveness);
  app.get('/health/live', liveness);

  // READINESS: `SELECT 1` + `PING`, 503 quando alguma dependencia cai.
  // Montado em `/api/v1/health` porque e o prefixo que o nginx faz proxy —
  // `/health` pela internet cai no `try_files` da SPA e devolve HTML com 200.
  // Registrado ANTES do `rateLimit` e do router de modulos.
  const checkHealth = createHealthChecker({ db: deps.db, cache });
  app.get(`${API_PREFIX}/health`, (_req, res, next) => {
    checkHealth()
      .then((report) => {
        res.set('Cache-Control', 'no-store');
        res.status(report.status === 'ok' ? 200 : 503).json(report);
      })
      .catch(next);
  });

  // O limitador fica aqui de proposito, ANTES dos routers: `requireAuth()` e
  // por rota, entao nao existe ponto unico "depois da autenticacao" onde
  // montar. Quem resolve a identidade e a propria chave — `rateLimitKey`
  // verifica o Bearer token e limita por usuario; rota publica (login,
  // refresh, webhook) fica por IP. Ver o cabecalho de `rate-limit.ts`.
  // Os webhooks de canal NAO entram neste balde — eles tem o seu, montado no
  // proprio modulo (`RATE_LIMIT_WEBHOOK_PER_MINUTE`). O gateway fala por IP
  // fixo e sem Bearer, entao caia na mesma cota de 100/min de um usuario
  // humano: a auditoria de 2026-09-17 mediu 3754 respostas 429 e 462 entregas
  // abandonadas por causa disso.
  app.use(rateLimit({ cache, skip: isChannelWebhook }));

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
