/**
 * POST /auth/login — SERVICES.md §1, WORKFLOWS.md §8, SECURITY.md "Autenticacao".
 *
 * CRMLAB-32: o refresh token deixou de vir no corpo — sai SO em
 * `Set-Cookie: crm_refresh=...; HttpOnly; SameSite=Strict; Path=/`
 * (Path ampliado de `/api/v1/auth` para `/` no CRMLAB-33/D-151).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LoginResponse } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import {
  MemoryCache,
  resetCacheUnavailableThrottleForTest,
  type CacheService,
} from '../../src/lib/cache.js';
import { hashRefreshToken } from '../../src/repositories/refresh-token.repository.js';
import { DEFAULT_THEME } from '../../src/services/theme.service.js';
import { authModule, REFRESH_COOKIE_NAME } from '../../src/controllers/auth.routes.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import {
  createTenant,
  createUser,
  DEFAULT_TEST_PASSWORD,
  type TenantRecord,
  type UserRecord,
} from '../helpers/factories.js';

/** Extrai o valor do cookie `crm_refresh` de um `Set-Cookie` de supertest. */
function refreshCookieValue(setCookie: string[] | undefined): string | undefined {
  const raw = setCookie?.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
  return raw?.split(';')[0]?.split('=')[1];
}

describe('POST /auth/login', () => {
  let db: DbClient;
  let app: TestApp;
  let tenant: TenantRecord;
  let user: UserRecord;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    app = await createTestApp({ db, modules: [authModule] });
    tenant = await createTenant({ name: 'Lab Sao Jose', slug: 'lab-sao-jose' });
    user = await createUser({
      tenantId: tenant.id,
      email: 'joao@lab.com',
      name: 'João Silva',
      role: 'attendant',
    });
  });

  it('credenciais validas devolvem o shape exato de LoginResponse, com o tema embutido', async () => {
    const response = await app.agent
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD })
      .expect(200);

    const body = response.body as LoginResponse;

    expect(Object.keys(body).sort()).toEqual(['accessToken', 'expiresIn', 'tenant', 'user'].sort());
    expect(typeof body.accessToken).toBe('string');
    expect(body.expiresIn).toBe(900);

    // O refresh NUNCA aparece no corpo — só no Set-Cookie httpOnly.
    expect(JSON.stringify(body)).not.toContain('refreshToken');
    const cookie = response.headers['set-cookie'] as unknown as string[] | undefined;
    const setCookie = cookie?.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');

    expect(body.user).toEqual({
      id: user.id,
      email: 'joao@lab.com',
      name: 'João Silva',
      role: 'attendant',
      discountLimit: 15,
    });

    expect(body.tenant.id).toBe(tenant.id);
    expect(body.tenant.name).toBe('Lab Sao Jose');
    expect(body.tenant.slug).toBe('lab-sao-jose');
    // D-005: so as 5 cores base + radius + font + brand. Nenhuma rampa no fio.
    expect(Object.keys(body.tenant.theme).sort()).toEqual(
      ['accent', 'accent2', 'bg', 'brandName', 'fontId', 'logoUrl', 'radiusId', 'surface', 'text'].sort(),
    );
    expect(body.tenant.theme).toEqual(DEFAULT_THEME);
  });

  it('e-mail inexistente e senha errada devolvem exatamente o mesmo erro', async () => {
    const unknownEmail = await app.agent
      .post('/api/v1/auth/login')
      .send({ email: 'ninguem@lab.com', password: DEFAULT_TEST_PASSWORD })
      .expect(401);

    const wrongPassword = await app.agent
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'senha-errada-mesmo' })
      .expect(401);

    expect(unknownEmail.body).toEqual({
      error: {
        code: 'INVALID_CREDENTIALS',
        message: 'Credenciais invalidas',
        statusCode: 401,
      },
    });
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  it('usuario desativado -> USER_INACTIVE', async () => {
    const inactive = await createUser({
      tenantId: tenant.id,
      email: 'desativado@lab.com',
      isActive: false,
    });

    const response = await app.agent
      .post('/api/v1/auth/login')
      .send({ email: inactive.email, password: DEFAULT_TEST_PASSWORD })
      .expect(403);

    expect(response.body.error.code).toBe('USER_INACTIVE');
  });

  it('tenant suspenso -> TENANT_INACTIVE', async () => {
    const suspended = await createTenant({ name: 'Lab Suspenso', isActive: false });
    const userOfSuspended = await createUser({
      tenantId: suspended.id,
      email: 'admin@suspenso.com',
      role: 'admin',
    });

    const response = await app.agent
      .post('/api/v1/auth/login')
      .send({ email: userOfSuspended.email, password: DEFAULT_TEST_PASSWORD })
      .expect(403);

    expect(response.body.error.code).toBe('TENANT_INACTIVE');
  });

  it('o refresh token e guardado HASHEADO — o valor em claro nao existe no banco', async () => {
    const response = await app.agent
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD })
      .expect(200);

    const plain = refreshCookieValue(response.headers['set-cookie'] as unknown as string[]);
    if (!plain) throw new Error('Set-Cookie crm_refresh ausente na resposta de login');

    const stored = await db.withoutTenant((tx) =>
      tx.query<{ token_hash: string; user_id: string; revoked_at: unknown }>(
        'SELECT token_hash, user_id, revoked_at FROM refresh_tokens',
      ),
    );

    expect(stored.rows).toHaveLength(1);
    const row = stored.rows[0]!;
    expect(row.user_id).toBe(user.id);
    expect(row.revoked_at).toBeNull();
    expect(row.token_hash).not.toBe(plain);
    expect(row.token_hash).not.toContain(plain);
    expect(row.token_hash).toBe(hashRefreshToken(plain));
  });

  it('atualiza last_login_at', async () => {
    const before = await db.withoutTenant((tx) =>
      tx.query<{ last_login_at: unknown }>('SELECT last_login_at FROM users WHERE id = $1', [
        user.id,
      ]),
    );
    expect(before.rows[0]?.last_login_at).toBeNull();

    await app.agent
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD })
      .expect(200);

    const after = await db.withoutTenant((tx) =>
      tx.query<{ last_login_at: unknown }>('SELECT last_login_at FROM users WHERE id = $1', [
        user.id,
      ]),
    );
    expect(after.rows[0]?.last_login_at).not.toBeNull();
  });

  it('login bem-sucedido gera entrada de auditoria no tenant certo', async () => {
    await app.agent
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD })
      .expect(200);

    const logs = await db.withoutTenant((tx) =>
      tx.query<{ action: string; tenant_id: string; user_id: string }>(
        'SELECT action, tenant_id, user_id FROM audit_logs',
      ),
    );
    expect(logs.rows).toEqual([
      { action: 'login', tenant_id: tenant.id, user_id: user.id },
    ]);
  });

  it('DTO invalido -> VALIDATION_ERROR com details.fields', async () => {
    const response = await app.agent
      .post('/api/v1/auth/login')
      .send({ email: 'nao-e-email', password: '' })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details.fields).toHaveProperty('email');
    expect(response.body.error.details.fields).toHaveProperty('password');
  });

  it('tentativas falhas repetidas passam a ser barradas (SECURITY.md: 5 / 15 min por email+IP)', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await app.agent
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: 'errada' })
        .expect(401);
    }

    // A 6a tentativa nao chega a comparar a senha — nem com a senha correta.
    const blocked = await app.agent
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD })
      .expect(429);

    expect(blocked.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  /**
   * REGRESSAO D-057. A chave do lockout e `login-failures:<email>:<ip>`. Se o
   * `<ip>` sair de um header que o proprio cliente escreve, o atacante ganha um
   * contador novo a cada tentativa e a politica de 5/15min nunca dispara —
   * forca bruta ilimitada contra qualquer e-mail conhecido.
   */
  it('variar X-Forwarded-For NAO burla o lockout de 5 tentativas', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await app.agent
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', `10.0.0.${attempt}`)
        .send({ email: user.email, password: 'errada' })
        .expect(401);
    }

    const blocked = await app.agent
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '198.51.100.77')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD })
      .expect(429);

    expect(blocked.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('o audit log de login grava o IP da conexao, nao o que o cliente mandou (D-057)', async () => {
    await app.agent
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '203.0.113.66')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD })
      .expect(200);

    const rows = await db.withoutTenant((tx) =>
      tx.query<{ ip_address: string | null }>(
        `SELECT ip_address FROM audit_logs WHERE action = 'login'`,
      ),
    );

    expect(rows.rows).toHaveLength(1);
    expect(String(rows.rows[0]?.ip_address)).not.toContain('203.0.113.66');
  });

  /**
   * D-139: o contador de falhas trocou `get`+`set` por `incr` atomico
   * justamente porque 20 senhas erradas em paralelo, com o padrao antigo,
   * liam o MESMO valor e escreviam o MESMO `hits + 1` — perdendo 19
   * incrementos e nunca disparando o lockout de 5. `Promise.all` dispara as
   * 20 tentativas de verdade em paralelo (nao um loop sequencial).
   */
  it('20 senhas erradas em paralelo NAO furam o lockout de 5 (D-139)', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.agent
          .post('/api/v1/auth/login')
          .send({ email: user.email, password: 'errada-tambem' }),
      ),
    );
    // Nenhuma das 20 pode "vazar" um status inesperado — todas 401 (o lockout
    // atua so DEPOIS que o contador acumulou, e o pre-check de todas roda
    // antes de qualquer incremento terminar, entao a rajada inteira ainda
    // compara senha).
    expect(attempts.every((r) => r.status === 401)).toBe(true);

    // O que importa: o contador ficou correto DEPOIS da rajada — a proxima
    // tentativa, mesmo com a senha certa, e barrada.
    const blocked = await app.agent
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD })
      .expect(429);
    expect(blocked.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });
});

/**
 * D-139: Redis fora do ar EM RUNTIME e rota PUBLICA (login) -> fail-CLOSED,
 * 503 SERVICE_UNAVAILABLE, nunca 500 generico.
 */
describe('POST /auth/login — Redis indisponivel em runtime (D-139)', () => {
  let db: DbClient;
  let tenant: TenantRecord;
  let user: UserRecord;

  class FailingCache implements CacheService {
    async get<T>(): Promise<T | null> {
      throw new Error('ECONNREFUSED 127.0.0.1:6379');
    }
    async set(): Promise<void> {
      throw new Error('ECONNREFUSED 127.0.0.1:6379');
    }
    async del(): Promise<void> {
      throw new Error('ECONNREFUSED 127.0.0.1:6379');
    }
    async delByPrefix(): Promise<void> {}
    async incr(): Promise<number> {
      throw new Error('ECONNREFUSED 127.0.0.1:6379');
    }
    async ping(): Promise<void> {}
    async close(): Promise<void> {}
  }

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    resetCacheUnavailableThrottleForTest();
    await resetDatabase(db);
    tenant = await createTenant({ name: 'Lab Sao Jose', slug: 'lab-sao-jose' });
    user = await createUser({ tenantId: tenant.id, email: 'joao@lab.com', role: 'attendant' });
  });

  it('responde 503 SERVICE_UNAVAILABLE em vez de 500 quando o cache falha', async () => {
    const app = await createTestApp({ db, cache: new FailingCache(), modules: [authModule] });

    const response = await app.agent
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD })
      .expect(503);

    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('cache saudavel (MemoryCache) continua respondendo normalmente', async () => {
    const app = await createTestApp({ db, cache: new MemoryCache(), modules: [authModule] });

    await app.agent
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD })
      .expect(200);
  });
});
