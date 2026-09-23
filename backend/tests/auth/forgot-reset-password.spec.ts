/**
 * POST /auth/forgot-password + POST /auth/reset-password — CRMLAB-39 (D-172).
 *
 * Critério de aceite do card: e-mail inexistente e existente respondem igual;
 * token usado uma vez não funciona de novo; token vencido é recusado; depois
 * do reset, a sessão aberta cai (refresh revogado).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { authModule } from '../../src/controllers/auth.routes.js';
import { verifyPassword } from '../../src/lib/password.js';
import {
  generateResetToken,
  hashResetToken,
  insert as insertResetToken,
} from '../../src/repositories/password-reset-token.repository.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import {
  createTenant,
  createUser,
  DEFAULT_TEST_PASSWORD,
  type TenantRecord,
  type UserRecord,
} from '../helpers/factories.js';

const NEW_PASSWORD = 'jacarandá-roxo-42';

describe('POST /auth/forgot-password', () => {
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

  async function resetTokenCount(): Promise<number> {
    return db.withoutTenant(async (tx) => {
      const result = await tx.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`,
        [user.id],
      );
      return Number(result.rows[0]!.count);
    });
  }

  it('responde 200 com a mesma mensagem para e-mail existente e inexistente', async () => {
    const existing = await app.agent
      .post('/api/v1/auth/forgot-password')
      .send({ email: user.email })
      .expect(200);

    const missing = await app.agent
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'nao-existe@lab.com' })
      .expect(200);

    expect(existing.body).toEqual(missing.body);
  });

  it('e-mail existente e ativo: cria um token de reset vivo', async () => {
    await app.agent.post('/api/v1/auth/forgot-password').send({ email: user.email }).expect(200);

    expect(await resetTokenCount()).toBe(1);
  });

  it('e-mail inexistente: nenhum token é criado', async () => {
    await app.agent
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'nao-existe@lab.com' })
      .expect(200);

    expect(await resetTokenCount()).toBe(0);
  });

  it('pedido novo invalida o token anterior ainda não usado', async () => {
    await app.agent.post('/api/v1/auth/forgot-password').send({ email: user.email }).expect(200);
    expect(await resetTokenCount()).toBe(1);

    await app.agent.post('/api/v1/auth/forgot-password').send({ email: user.email }).expect(200);
    expect(await resetTokenCount()).toBe(1);
  });

  it('6a tentativa na janela de 15 min volta 429', async () => {
    for (let i = 0; i < 5; i += 1) {
      await app.agent
        .post('/api/v1/auth/forgot-password')
        .send({ email: user.email })
        .expect(200);
    }

    await app.agent
      .post('/api/v1/auth/forgot-password')
      .send({ email: user.email })
      .expect(429);
  });

  it('e-mail malformado: VALIDATION_ERROR', async () => {
    const response = await app.agent
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'nao-e-email' })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /auth/reset-password', () => {
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

  /** Grava um token de reset direto no banco (o "e-mail" desta suíte). */
  async function issueResetToken(expiresInMs = 30 * 60 * 1000): Promise<string> {
    const token = generateResetToken();
    await db.withTenant(tenant.id, (tx) =>
      insertResetToken(tx, {
        tenantId: tenant.id,
        userId: user.id,
        tokenHash: hashResetToken(token),
        expiresAt: new Date(Date.now() + expiresInMs),
      }),
    );
    return token;
  }

  it('redefine a senha: a nova autentica no login e a antiga para de autenticar', async () => {
    const token = await issueResetToken();

    await app.agent
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: NEW_PASSWORD })
      .expect(200);

    await app.agent
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: NEW_PASSWORD })
      .expect(200);

    await app.agent
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD })
      .expect(401);
  });

  it('grava o hash novo no banco (nunca a senha em claro)', async () => {
    const token = await issueResetToken();

    await app.agent
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: NEW_PASSWORD })
      .expect(200);

    const hash = await db.withoutTenant(async (tx) => {
      const result = await tx.query<{ password_hash: string }>(
        `SELECT password_hash FROM users WHERE id = $1`,
        [user.id],
      );
      return result.rows[0]!.password_hash;
    });

    expect(hash).not.toContain(NEW_PASSWORD);
    expect(await verifyPassword(NEW_PASSWORD, hash)).toBe(true);
  });

  it('revoga todas as sessões (refresh tokens) do usuário', async () => {
    await app.agent
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD })
      .expect(200);

    const token = await issueResetToken();
    await app.agent
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: NEW_PASSWORD })
      .expect(200);

    const live = await db.withoutTenant(async (tx) => {
      const result = await tx.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`,
        [user.id],
      );
      return Number(result.rows[0]!.count);
    });
    expect(live).toBe(0);
  });

  it('token já usado: RESET_TOKEN_INVALID na segunda tentativa', async () => {
    const token = await issueResetToken();

    await app.agent
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: NEW_PASSWORD })
      .expect(200);

    const response = await app.agent
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'outra-senha-nova-1' })
      .expect(400);
    expect(response.body.error.code).toBe('RESET_TOKEN_INVALID');
  });

  it('token vencido: RESET_TOKEN_INVALID', async () => {
    const token = await issueResetToken(-1000);

    const response = await app.agent
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: NEW_PASSWORD })
      .expect(400);
    expect(response.body.error.code).toBe('RESET_TOKEN_INVALID');
  });

  it('token desconhecido: RESET_TOKEN_INVALID', async () => {
    const response = await app.agent
      .post('/api/v1/auth/reset-password')
      .send({ token: 'token-que-nunca-existiu', newPassword: NEW_PASSWORD })
      .expect(400);
    expect(response.body.error.code).toBe('RESET_TOKEN_INVALID');
  });

  it('senha nova fora da política: VALIDATION_ERROR, token continua vivo', async () => {
    const token = await issueResetToken();

    const response = await app.agent
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'curta' })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');

    // Token não foi consumido pela tentativa inválida — ainda funciona.
    await app.agent
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: NEW_PASSWORD })
      .expect(200);
  });
});
