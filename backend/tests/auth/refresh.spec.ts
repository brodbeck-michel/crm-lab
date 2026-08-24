/**
 * POST /auth/refresh e POST /auth/logout — rotacao, deteccao de reuso (D-015)
 * e revogacao. SECURITY.md "Autenticacao".
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LoginResponse, RefreshResponse } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { authModule } from '../../src/controllers/auth.routes.js';
import { hashRefreshToken } from '../../src/repositories/refresh-token.repository.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import {
  createTenant,
  createUser,
  DEFAULT_TEST_PASSWORD,
  type TenantRecord,
  type UserRecord,
} from '../helpers/factories.js';

interface TokenRow {
  token_hash: string;
  revoked_at: unknown;
}

describe('rotacao de refresh token', () => {
  let db: DbClient;
  let app: TestApp;
  let tenant: TenantRecord;
  let user: UserRecord;

  const login = async (): Promise<LoginResponse> => {
    const response = await app.agent
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD })
      .expect(200);
    return response.body as LoginResponse;
  };

  const tokenRows = async (): Promise<TokenRow[]> => {
    const result = await db.withoutTenant((tx) =>
      tx.query<TokenRow>('SELECT token_hash, revoked_at FROM refresh_tokens'),
    );
    return result.rows;
  };

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    app = await createTestApp({ db, modules: [authModule] });
    tenant = await createTenant();
    user = await createUser({ tenantId: tenant.id, role: 'manager' });
  });

  it('usar um refresh token o revoga e emite outro', async () => {
    const session = await login();

    const refreshed = await app.agent
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(200);

    expect(typeof refreshed.body.accessToken).toBe('string');
    expect(refreshed.body.expiresIn).toBe(900);
    // D-014: a rotacao devolve o novo refresh — sem ele o cliente perderia a sessao.
    expect(typeof refreshed.body.refreshToken).toBe('string');
    expect(refreshed.body.refreshToken).not.toBe(session.refreshToken);

    const rows = await tokenRows();
    expect(rows).toHaveLength(2);

    const old = rows.find((r) => r.token_hash === hashRefreshToken(session.refreshToken));
    const fresh = rows.find(
      (r) => r.token_hash === hashRefreshToken(refreshed.body.refreshToken as string),
    );
    expect(old?.revoked_at).not.toBeNull();
    expect(fresh?.revoked_at).toBeNull();
  });

  /**
   * O tipo compartilhado e o contrato: se `RefreshResponse` nao declarar
   * `refreshToken`, esta leitura nao compila. Antes da correcao do tipo, este
   * teste falhava no `tsc` — que e onde o contrato vive.
   */
  it('a resposta cabe em RefreshResponse de @crm-lab/shared, refreshToken incluso', async () => {
    const session = await login();

    const refreshed = await app.agent
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(200);

    const body = refreshed.body as RefreshResponse;
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.expiresIn).toBe('number');
    expect(typeof body.refreshToken).toBe('string');
    expect(body.refreshToken).not.toBe(session.refreshToken);
  });

  it('o novo refresh token continua funcionando na rodada seguinte', async () => {
    const session = await login();

    const first = await app.agent
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(200);

    await app.agent
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.body.refreshToken })
      .expect(200);
  });

  it('reuso de token revogado -> REFRESH_TOKEN_INVALID e derruba a familia inteira', async () => {
    const session = await login();

    const rotated = await app.agent
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(200);

    // Atacante tenta usar o token antigo (ja rotacionado).
    const reuse = await app.agent
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(401);
    expect(reuse.body.error.code).toBe('REFRESH_TOKEN_INVALID');

    const logs = await db.withoutTenant((tx) =>
      tx.query<{ action: string }>(
        `SELECT action FROM audit_logs WHERE action = 'refresh_token_reuse_detected'`,
      ),
    );
    expect(logs.rows).toHaveLength(1);

    // Toda a familia cai: o token legitimo, que ainda estava vivo, morre junto.
    const rows = await tokenRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.revoked_at !== null)).toBe(true);

    const afterTheft = await app.agent
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: rotated.body.refreshToken })
      .expect(401);
    expect(afterTheft.body.error.code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('token desconhecido ou malformado -> REFRESH_TOKEN_INVALID', async () => {
    const malformed = await app.agent
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: 'nao-e-um-jwt' })
      .expect(401);
    expect(malformed.body.error.code).toBe('REFRESH_TOKEN_INVALID');

    // Assinatura valida, mas nunca emitido por nos (nao esta na tabela).
    const session = await login();
    await db.withoutTenant((tx) => tx.query('DELETE FROM refresh_tokens'));
    const unknown = await app.agent
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(401);
    expect(unknown.body.error.code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('logout revoga o refresh e o token nao serve mais', async () => {
    const session = await login();

    const loggedOut = await app.agent
      .post('/api/v1/auth/logout')
      .send({ refreshToken: session.refreshToken })
      .expect(200);
    expect(loggedOut.body).toEqual({ message: 'Logged out successfully' });

    const rows = await tokenRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revoked_at).not.toBeNull();

    const afterLogout = await app.agent
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(401);
    expect(afterLogout.body.error.code).toBe('REFRESH_TOKEN_INVALID');
  });
});
