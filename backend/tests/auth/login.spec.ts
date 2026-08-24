/**
 * POST /auth/login — SERVICES.md §1, WORKFLOWS.md §8, SECURITY.md "Autenticacao".
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LoginResponse } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { hashRefreshToken } from '../../src/repositories/refresh-token.repository.js';
import { DEFAULT_THEME } from '../../src/services/theme.service.js';
import { authModule } from '../../src/controllers/auth.routes.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import {
  createTenant,
  createUser,
  DEFAULT_TEST_PASSWORD,
  type TenantRecord,
  type UserRecord,
} from '../helpers/factories.js';

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

    expect(Object.keys(body).sort()).toEqual(
      ['accessToken', 'expiresIn', 'refreshToken', 'tenant', 'user'].sort(),
    );
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    expect(body.expiresIn).toBe(900);

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

    const plain = (response.body as LoginResponse).refreshToken;

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
});
