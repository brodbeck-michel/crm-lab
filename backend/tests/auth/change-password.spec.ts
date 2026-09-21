/**
 * PATCH /users/me/password — CRMLAB-35 (D-153: politica; D-154: sessoes).
 *
 * O criterio de aceite do card em forma de teste: trocar a senha derruba as
 * OUTRAS sessoes do usuario e preserva a que fez a troca (identificada pelo
 * cookie `crm_refresh` que a requisicao carrega).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { REFRESH_COOKIE_NAME } from '../../src/http/refresh-cookie.js';
import { hashRefreshToken } from '../../src/repositories/refresh-token.repository.js';
import { authModule } from '../../src/controllers/auth.routes.js';
import { userModule } from '../../src/controllers/user.routes.js';
import { verifyPassword } from '../../src/lib/password.js';
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

function refreshCookieValue(setCookie: string[] | undefined): string {
  const raw = setCookie?.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
  const value = raw?.split(';')[0]?.split('=')[1];
  if (!value) throw new Error('resposta de login nao trouxe o cookie de refresh');
  return value;
}

describe('PATCH /users/me/password', () => {
  let db: DbClient;
  let app: TestApp;
  let tenant: TenantRecord;
  let user: UserRecord;

  /** Faz login de verdade e devolve o refresh token daquela sessao. */
  async function loginSession(): Promise<string> {
    const response = await app.agent
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD })
      .expect(200);
    return refreshCookieValue(response.headers['set-cookie'] as string[] | undefined);
  }

  /** Quantas famílias de refresh do usuário continuam vivas. */
  async function liveTokenHashes(): Promise<string[]> {
    return db.withoutTenant(async (tx) => {
      const result = await tx.query<{ token_hash: string }>(
        `SELECT token_hash FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`,
        [user.id],
      );
      return result.rows.map((r) => r.token_hash);
    });
  }

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    app = await createTestApp({ db, modules: [authModule, userModule] });
    tenant = await createTenant({ name: 'Lab Sao Jose', slug: 'lab-sao-jose' });
    user = await createUser({
      tenantId: tenant.id,
      email: 'joao@lab.com',
      name: 'João Silva',
      role: 'attendant',
    });
  });

  it('troca a senha: a nova autentica no login e a antiga para de autenticar', async () => {
    const sessionToken = await loginSession();

    await app.agent
      .patch('/api/v1/users/me/password')
      .set(app.auth(user))
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${sessionToken}`)
      .send({ currentPassword: DEFAULT_TEST_PASSWORD, newPassword: NEW_PASSWORD })
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
    const sessionToken = await loginSession();

    await app.agent
      .patch('/api/v1/users/me/password')
      .set(app.auth(user))
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${sessionToken}`)
      .send({ currentPassword: DEFAULT_TEST_PASSWORD, newPassword: NEW_PASSWORD })
      .expect(200);

    const hash = await db.withoutTenant(async (tx) => {
      const result = await tx.query<{ password_hash: string }>(
        `SELECT password_hash FROM users WHERE id = $1`,
        [user.id],
      );
      return result.rows[0]!.password_hash;
    });

    expect(hash).not.toContain(NEW_PASSWORD);
    await expect(verifyPassword(NEW_PASSWORD, hash)).resolves.toBe(true);
  });

  it('criterio de aceite: derruba as OUTRAS sessoes e preserva a que trocou a senha', async () => {
    const outraSessao = await loginSession();
    const sessaoAtual = await loginSession();
    expect(await liveTokenHashes()).toHaveLength(2);

    await app.agent
      .patch('/api/v1/users/me/password')
      .set(app.auth(user))
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${sessaoAtual}`)
      .send({ currentPassword: DEFAULT_TEST_PASSWORD, newPassword: NEW_PASSWORD })
      .expect(200);

    // Sobra exatamente uma familia viva, e e a da sessao que trocou a senha.
    expect(await liveTokenHashes()).toEqual([hashRefreshToken(sessaoAtual)]);

    // O outro navegador so descobre no proximo refresh — que e recusado.
    await app.agent
      .post('/api/v1/auth/refresh')
      .set('X-Requested-With', 'crm-lab')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${outraSessao}`)
      .expect(401);

    // A sessao atual continua renovando normalmente — MESMO depois do outro
    // navegador ter batido no refresh com o token revogado acima. Regressao do
    // D-154: a deteccao de roubo (D-015) derruba a familia inteira quando um
    // token ja revogado reaparece, e sem separar "revogado por rotacao" de
    // "revogado por acao de seguranca" o proprio usuario derrubava a sessao
    // que acabara de trocar a senha, so por deixar a outra aba aberta.
    await app.agent
      .post('/api/v1/auth/refresh')
      .set('X-Requested-With', 'crm-lab')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${sessaoAtual}`)
      .expect(200);
  });

  it('replay de token derrubado por seguranca nao derruba familia, mas DEIXA RASTRO na auditoria', async () => {
    const outraSessao = await loginSession();
    const sessaoAtual = await loginSession();

    await app.agent
      .patch('/api/v1/users/me/password')
      .set(app.auth(user))
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${sessaoAtual}`)
      .send({ currentPassword: DEFAULT_TEST_PASSWORD, newPassword: NEW_PASSWORD })
      .expect(200);

    await app.agent
      .post('/api/v1/auth/refresh')
      .set('X-Requested-With', 'crm-lab')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${outraSessao}`)
      .expect(401);

    // Este e o caso pos-comprometimento: o usuario troca a senha PORQUE perdeu
    // o dispositivo, e o replay do ladrao e o unico sinal de que o token vazou.
    // Sem este registro, o 401 era mudo.
    const registros = await db.withoutTenant(async (tx) => {
      const result = await tx.query<{ action: string }>(
        `SELECT action FROM audit_logs WHERE user_id = $1 AND action = $2`,
        [user.id, 'refresh_token_replay_after_security'],
      );
      return result.rows;
    });
    expect(registros).toHaveLength(1);

    // E a familia da sessao que trocou a senha continua viva.
    expect(await liveTokenHashes()).toEqual([hashRefreshToken(sessaoAtual)]);
  });

  it('a deteccao de roubo (D-015) continua valendo para token ROTACIONADO', async () => {
    const original = await loginSession();

    // Rotaciona: `original` fica revogado com motivo 'rotated'.
    const rotacionado = await app.agent
      .post('/api/v1/auth/refresh')
      .set('X-Requested-With', 'crm-lab')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${original}`)
      .expect(200);
    const novo = refreshCookieValue(rotacionado.headers['set-cookie'] as string[] | undefined);

    // Reusar o token ja rotacionado é sinal de roubo: derruba a familia toda.
    await app.agent
      .post('/api/v1/auth/refresh')
      .set('X-Requested-With', 'crm-lab')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${original}`)
      .expect(401);

    expect(await liveTokenHashes()).toHaveLength(0);
    await app.agent
      .post('/api/v1/auth/refresh')
      .set('X-Requested-With', 'crm-lab')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${novo}`)
      .expect(401);
  });

  it('sem o cookie da sessao atual, revoga TUDO — inclusive quem fez a troca', async () => {
    const sessao = await loginSession();

    await app.agent
      .patch('/api/v1/users/me/password')
      .set(app.auth(user))
      .send({ currentPassword: DEFAULT_TEST_PASSWORD, newPassword: NEW_PASSWORD })
      .expect(200);

    expect(await liveTokenHashes()).toHaveLength(0);
    await app.agent
      .post('/api/v1/auth/refresh')
      .set('X-Requested-With', 'crm-lab')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${sessao}`)
      .expect(401);
  });

  it('senha atual errada devolve VALIDATION_ERROR e nao muda nada', async () => {
    const sessao = await loginSession();

    const response = await app.agent
      .patch('/api/v1/users/me/password')
      .set(app.auth(user))
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${sessao}`)
      .send({ currentPassword: 'nao-e-essa-123', newPassword: NEW_PASSWORD })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details.fields.currentPassword).toBeTruthy();

    // Senha antiga continua valendo e nenhuma sessao caiu.
    await app.agent
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD })
      .expect(200);
    expect((await liveTokenHashes()).length).toBeGreaterThan(0);
  });

  it('politica (D-153): recusa senha curta e senha trivial da lista', async () => {
    const sessao = await loginSession();
    const headers = { Cookie: `${REFRESH_COOKIE_NAME}=${sessao}` };

    const curta = await app.agent
      .patch('/api/v1/users/me/password')
      .set(app.auth(user))
      .set(headers)
      .send({ currentPassword: DEFAULT_TEST_PASSWORD, newPassword: 'curta123' })
      .expect(400);
    expect(curta.body.error.code).toBe('VALIDATION_ERROR');

    const trivial = await app.agent
      .patch('/api/v1/users/me/password')
      .set(app.auth(user))
      .set(headers)
      .send({ currentPassword: DEFAULT_TEST_PASSWORD, newPassword: 'Password123' })
      .expect(400);
    expect(trivial.body.error.details.fields.newPassword).toBeTruthy();

    // Nada mudou: a senha original ainda autentica.
    await app.agent
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD })
      .expect(200);
  });

  it('senha nova igual a atual e recusada pelo BACKEND (nao so pela tela)', async () => {
    const sessao = await loginSession();
    const antes = await liveTokenHashes();

    const response = await app.agent
      .patch('/api/v1/users/me/password')
      .set(app.auth(user))
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${sessao}`)
      .send({ currentPassword: DEFAULT_TEST_PASSWORD, newPassword: DEFAULT_TEST_PASSWORD })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details.fields.newPassword).toBeTruthy();
    // Nada de revogar sessoes nem escrever auditoria por uma troca que nao trocou nada.
    expect(await liveTokenHashes()).toEqual(antes);
  });

  it('exige autenticacao', async () => {
    await app.agent
      .patch('/api/v1/users/me/password')
      .send({ currentPassword: DEFAULT_TEST_PASSWORD, newPassword: NEW_PASSWORD })
      .expect(401);
  });

  it('nao troca a senha de outro usuario: /me sai do token, nao do corpo', async () => {
    const outro = await createUser({
      tenantId: tenant.id,
      email: 'maria@lab.com',
      name: 'Maria Souza',
      role: 'attendant',
    });

    await app.agent
      .patch('/api/v1/users/me/password')
      .set(app.auth(user))
      .send({
        currentPassword: DEFAULT_TEST_PASSWORD,
        newPassword: NEW_PASSWORD,
        userId: outro.id,
      })
      .expect(400); // `.strict()` no schema: campo extra e erro, nao e ignorado

    // A senha do outro continua intacta.
    await app.agent
      .post('/api/v1/auth/login')
      .send({ email: outro.email, password: DEFAULT_TEST_PASSWORD })
      .expect(200);
  });
});
