/**
 * Monta o app com dependencias de teste e devolve um agente supertest.
 *
 *   const { agent, wsHub, auth } = await createTestApp({ modules: [proposalModule] });
 *   const headers = auth(user);                       // { Authorization: 'Bearer ...' }
 *   await agent.get('/api/v1/proposals').set(headers).expect(200);
 */
import supertest from 'supertest';
import type { AppDeps } from '../../src/app.js';
import { createApp } from '../../src/app.js';
import type { ApiModuleFactory } from '../../src/http/api-module.js';
import type { DbClient } from '../../src/db/types.js';
import { MemoryCache, type CacheService } from '../../src/lib/cache.js';
import { signAccessToken } from '../../src/lib/tokens.js';
import { FakeWsHub } from './fake-ws.js';
import { getTestDb } from './test-db.js';

export interface AuthenticatableUser {
  id: string;
  tenantId: string;
  role: import('@crm-lab/shared').UserRole;
  discountLimit: number;
}

export interface TestAppOptions {
  db?: DbClient;
  cache?: CacheService;
  wsHub?: FakeWsHub;
  /** Modulos a montar. Default: nenhum (so `/health`). */
  modules?: ApiModuleFactory[];
}

export interface TestApp {
  agent: ReturnType<typeof supertest>;
  app: ReturnType<typeof createApp>['app'];
  db: DbClient;
  cache: CacheService;
  wsHub: FakeWsHub;
  /** Header `Authorization` pronto para o usuario dado. */
  auth: (user: AuthenticatableUser, ttlSeconds?: number) => { Authorization: string };
  /** Alias explicito pedido pelos testes de integracao. */
  loginAs: (user: AuthenticatableUser, ttlSeconds?: number) => { Authorization: string };
  token: (user: AuthenticatableUser, ttlSeconds?: number) => string;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const db = options.db ?? (await getTestDb());
  const cache = options.cache ?? new MemoryCache();
  const wsHub = options.wsHub ?? new FakeWsHub();

  const deps: AppDeps = {
    db,
    cache,
    wsHub,
    moduleFactories: options.modules ?? [],
  };
  const { app } = createApp(deps);

  const token = (user: AuthenticatableUser, ttlSeconds?: number): string =>
    signAccessToken(
      {
        userId: user.id,
        tenantId: user.tenantId,
        role: user.role,
        discountLimit: user.discountLimit,
      },
      ttlSeconds,
    );

  const auth = (user: AuthenticatableUser, ttlSeconds?: number): { Authorization: string } => ({
    Authorization: `Bearer ${token(user, ttlSeconds)}`,
  });

  return {
    agent: supertest(app),
    app,
    db,
    cache,
    wsHub,
    auth,
    loginAs: auth,
    token,
  };
}
