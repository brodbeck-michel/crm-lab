/**
 * POST /auth/refresh e POST /auth/logout — rotacao, deteccao de reuso (D-015)
 * e revogacao. SECURITY.md "Autenticacao".
 *
 * CRMLAB-32: o refresh vive no cookie httpOnly `crm_refresh`
 * (`Path=/`, ampliado de `/api/v1/auth` no CRMLAB-33/D-151). `refreshToken` no corpo é fallback DEPRECIADO de
 * transição — testado à parte, mas o caminho normal é sempre o cookie.
 * `/auth/refresh` também exige `X-Requested-With: crm-lab` (proteção CSRF
 * extra além de `SameSite=Strict`).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LoginResponse, RefreshResponse } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { authModule, REFRESH_COOKIE_NAME } from '../../src/controllers/auth.routes.js';
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

const REQUESTED_WITH = { 'X-Requested-With': 'crm-lab' };

interface TokenRow {
  token_hash: string;
  revoked_at: unknown;
}

/** Extrai `crm_refresh=<valor>` (sem os atributos) de um `Set-Cookie` cru. */
function refreshCookieHeader(setCookie: string[] | undefined): string {
  const raw = setCookie?.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
  if (!raw) throw new Error('Set-Cookie crm_refresh ausente');
  return raw.split(';')[0] as string;
}

function refreshCookieValue(setCookie: string[] | undefined): string {
  return refreshCookieHeader(setCookie).split('=')[1] as string;
}

describe('rotacao de refresh token', () => {
  let db: DbClient;
  let app: TestApp;
  let tenant: TenantRecord;
  let user: UserRecord;

  const login = async (): Promise<{ body: LoginResponse; cookie: string }> => {
    const response = await app.agent
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD })
      .expect(200);
    return {
      body: response.body as LoginResponse,
      cookie: refreshCookieHeader(response.headers['set-cookie'] as unknown as string[]),
    };
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

  it('usar o cookie de refresh o revoga e emite outro (novo Set-Cookie)', async () => {
    const session = await login();

    const refreshed = await app.agent
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.cookie)
      .set(REQUESTED_WITH)
      .send({})
      .expect(200);

    expect(typeof refreshed.body.accessToken).toBe('string');
    expect(refreshed.body.expiresIn).toBe(900);
    // O corpo NUNCA carrega refreshToken — só o Set-Cookie.
    expect(refreshed.body).not.toHaveProperty('refreshToken');

    const newCookie = refreshCookieValue(refreshed.headers['set-cookie'] as unknown as string[]);
    const oldValue = session.cookie.split('=')[1] as string;
    expect(newCookie).not.toBe(oldValue);

    const rows = await tokenRows();
    expect(rows).toHaveLength(2);

    const old = rows.find((r) => r.token_hash === hashRefreshToken(oldValue));
    const fresh = rows.find((r) => r.token_hash === hashRefreshToken(newCookie));
    expect(old?.revoked_at).not.toBeNull();
    expect(fresh?.revoked_at).toBeNull();
  });

  it('a resposta cabe em RefreshResponse de @crm-lab/shared (sem refreshToken)', async () => {
    const session = await login();

    const refreshed = await app.agent
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.cookie)
      .set(REQUESTED_WITH)
      .send({})
      .expect(200);

    const body = refreshed.body as RefreshResponse;
    expect(Object.keys(body).sort()).toEqual(['accessToken', 'expiresIn']);
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.expiresIn).toBe('number');
  });

  it('refresh sem cookie e sem body -> 401 REFRESH_TOKEN_INVALID', async () => {
    const response = await app.agent
      .post('/api/v1/auth/refresh')
      .set(REQUESTED_WITH)
      .send({})
      .expect(401);

    expect(response.body.error.code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('refresh sem o header X-Requested-With: crm-lab -> 401 REFRESH_TOKEN_INVALID', async () => {
    const session = await login();

    const response = await app.agent
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.cookie)
      .send({})
      .expect(401);

    expect(response.body.error.code).toBe('REFRESH_TOKEN_INVALID');
  });

  /**
   * Fallback DEPRECIADO de transição (ver cabeçalho do arquivo): sem cookie,
   * o corpo ainda funciona — até a remoção prevista em `RefreshRequest`
   * (`shared/types/auth.types.ts`, 2026-10-04).
   */
  it('sem cookie, o refreshToken no corpo ainda funciona (fallback depreciado)', async () => {
    const session = await login();
    const oldValue = session.cookie.split('=')[1] as string;

    const refreshed = await app.agent
      .post('/api/v1/auth/refresh')
      .set(REQUESTED_WITH)
      .send({ refreshToken: oldValue })
      .expect(200);

    expect(typeof refreshed.body.accessToken).toBe('string');
  });

  it('cookie tem prioridade sobre o corpo quando os dois vêm juntos', async () => {
    const session = await login();

    const refreshed = await app.agent
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.cookie)
      .set(REQUESTED_WITH)
      .send({ refreshToken: 'um-token-qualquer-invalido' })
      .expect(200);

    expect(typeof refreshed.body.accessToken).toBe('string');
  });

  it('o novo cookie continua funcionando na rodada seguinte', async () => {
    const session = await login();

    const first = await app.agent
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.cookie)
      .set(REQUESTED_WITH)
      .send({})
      .expect(200);

    const firstCookie = refreshCookieHeader(first.headers['set-cookie'] as unknown as string[]);

    await app.agent
      .post('/api/v1/auth/refresh')
      .set('Cookie', firstCookie)
      .set(REQUESTED_WITH)
      .send({})
      .expect(200);
  });

  it('reuso de cookie ja rotacionado -> REFRESH_TOKEN_INVALID e derruba a familia inteira', async () => {
    const session = await login();

    const rotated = await app.agent
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.cookie)
      .set(REQUESTED_WITH)
      .send({})
      .expect(200);

    // Atacante tenta usar o cookie antigo (ja rotacionado).
    const reuse = await app.agent
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.cookie)
      .set(REQUESTED_WITH)
      .send({})
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

    const rotatedCookie = refreshCookieHeader(rotated.headers['set-cookie'] as unknown as string[]);
    const afterTheft = await app.agent
      .post('/api/v1/auth/refresh')
      .set('Cookie', rotatedCookie)
      .set(REQUESTED_WITH)
      .send({})
      .expect(401);
    expect(afterTheft.body.error.code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('token desconhecido ou malformado -> REFRESH_TOKEN_INVALID', async () => {
    const malformed = await app.agent
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=nao-e-um-jwt`)
      .set(REQUESTED_WITH)
      .send({})
      .expect(401);
    expect(malformed.body.error.code).toBe('REFRESH_TOKEN_INVALID');

    // Assinatura valida, mas nunca emitido por nos (nao esta na tabela).
    const session = await login();
    await db.withoutTenant((tx) => tx.query('DELETE FROM refresh_tokens'));
    const unknown = await app.agent
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.cookie)
      .set(REQUESTED_WITH)
      .send({})
      .expect(401);
    expect(unknown.body.error.code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('logout limpa o cookie (Max-Age=0) e revoga — o cookie antigo nao serve mais', async () => {
    const session = await login();

    const loggedOut = await app.agent
      .post('/api/v1/auth/logout')
      .set('Cookie', session.cookie)
      .send({})
      .expect(200);
    expect(loggedOut.body).toEqual({ message: 'Logged out successfully' });

    const clearSetCookie = refreshCookieHeader(
      loggedOut.headers['set-cookie'] as unknown as string[],
    );
    expect(clearSetCookie).toBe(`${REFRESH_COOKIE_NAME}=`);
    const rawClear = (loggedOut.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith(`${REFRESH_COOKIE_NAME}=`),
    );
    expect(rawClear).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);

    const rows = await tokenRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revoked_at).not.toBeNull();

    const afterLogout = await app.agent
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.cookie)
      .set(REQUESTED_WITH)
      .send({})
      .expect(401);
    expect(afterLogout.body.error.code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('logout idempotente: sem cookie e sem body devolve a mesma resposta de sucesso', async () => {
    const response = await app.agent.post('/api/v1/auth/logout').send({}).expect(200);
    expect(response.body).toEqual({ message: 'Logged out successfully' });
  });

  it('login manda TAMBEM um Set-Cookie de expiracao no path antigo (D-159)', async () => {
    const response = await app.agent
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD })
      .expect(200);

    const cookies = (response.headers['set-cookie'] as string[] | undefined) ?? [];
    const doRefresh = cookies.filter((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));

    // Dois Set-Cookie do mesmo nome: o valido em Path=/ e a lapide do path
    // antigo. Sem a lapide, quem ja estava logado fica com os DOIS cookies, a
    // rota le eternamente o velho e a deteccao de reuso desloga todo mundo.
    expect(doRefresh).toHaveLength(2);
    // O VALIDO vem primeiro — cliente ingenuo que so olha o nome pega o certo.
    expect(doRefresh[0]).toMatch(/Path=\//);
    expect(doRefresh[0]).not.toMatch(new RegExp(`^${REFRESH_COOKIE_NAME}=;`));
    const lapide = doRefresh[1] ?? '';
    expect(lapide).toContain('Path=/api/v1/auth');
    expect(lapide).toMatch(new RegExp(`^${REFRESH_COOKIE_NAME}=;`));
  });
});
