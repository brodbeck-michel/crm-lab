/**
 * POST /users/:id/reset-password + troca obrigatória da senha provisória
 * — CRMLAB-186 (D-326).
 *
 * Critérios de aceite em forma de teste:
 * - só admin, contra OUTRO usuário do próprio tenant; o resto é 404/403;
 * - a senha provisória autentica, liga `must_change_password` e derruba as sessões;
 * - com a flag, o servidor recusa tudo menos `GET /users/me` e `PATCH /users/me/password`;
 * - trocar a senha desliga a flag e o refresh seguinte sai sem o claim.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { REFRESH_COOKIE_NAME } from '../../src/http/refresh-cookie.js';
import { authModule } from '../../src/controllers/auth.routes.js';
import { userModule } from '../../src/controllers/user.routes.js';
import { platformModule } from '../../src/controllers/platform.routes.js';
import { refreshSessionIsLive } from '../../src/services/auth.service.js';
import { verifyAccessToken } from '../../src/lib/tokens.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import {
  createTenant,
  createUser,
  DEFAULT_TEST_PASSWORD,
  type TenantRecord,
  type UserRecord,
} from '../helpers/factories.js';

const NEW_PASSWORD = 'ipê-amarelo-2026';

function refreshCookieValue(setCookie: string[] | undefined): string {
  const raw = setCookie?.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
  const value = raw?.split(';')[0]?.split('=')[1];
  if (!value) throw new Error('resposta sem o cookie de refresh');
  return value;
}

describe('POST /users/:id/reset-password (CRMLAB-186)', () => {
  let db: DbClient;
  let app: TestApp;
  let tenant: TenantRecord;
  let admin: UserRecord;
  let attendant: UserRecord;

  async function login(email: string, password: string) {
    const response = await app.agent.post('/api/v1/auth/login').send({ email, password }).expect(200);
    return {
      body: response.body as {
        accessToken: string;
        user: { mustChangePassword?: boolean };
      },
      refresh: refreshCookieValue(response.headers['set-cookie'] as string[] | undefined),
    };
  }

  async function flagOf(userId: string): Promise<boolean> {
    return db.withoutTenant(async (tx) => {
      const result = await tx.query<{ must_change_password: boolean }>(
        'SELECT must_change_password FROM users WHERE id = $1',
        [userId],
      );
      return result.rows[0]!.must_change_password;
    });
  }

  function reset(target: UserRecord, as: UserRecord = admin) {
    return app.agent.post(`/api/v1/users/${target.id}/reset-password`).set(app.auth(as));
  }

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    app = await createTestApp({ db, modules: [authModule, userModule, platformModule] });
    tenant = await createTenant({ name: 'Lab Santa Rita', slug: 'lab-santa-rita' });
    admin = await createUser({ tenantId: tenant.id, email: 'admin@rita.com', role: 'admin' });
    attendant = await createUser({
      tenantId: tenant.id,
      email: 'diana@rita.com',
      role: 'attendant',
    });
  });

  it('gera senha provisória que autentica, liga a flag e a senha antiga para de valer', async () => {
    const response = await reset(attendant).expect(200);
    const body = response.body as { userId: string; email: string; temporaryPassword: string };

    expect(body.userId).toBe(attendant.id);
    expect(body.email).toBe(attendant.email);
    expect(body.temporaryPassword).toHaveLength(16);
    expect(await flagOf(attendant.id)).toBe(true);

    await app.agent
      .post('/api/v1/auth/login')
      .send({ email: attendant.email, password: DEFAULT_TEST_PASSWORD })
      .expect(401);
    const session = await login(attendant.email, body.temporaryPassword);
    expect(session.body.user.mustChangePassword).toBe(true);
    const claims = verifyAccessToken(session.body.accessToken);
    expect(claims.ok && claims.payload.mustChangePassword).toBe(true);
  });

  it('derruba todas as sessões do usuário resetado', async () => {
    const before = await login(attendant.email, DEFAULT_TEST_PASSWORD);
    await reset(attendant).expect(200);

    await app.agent
      .post('/api/v1/auth/refresh')
      .set('X-Requested-With', 'crm-lab')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${before.refresh}`)
      .expect(401);
  });

  it('audita com o admin como autor e sem a senha no log', async () => {
    const response = await reset(attendant).expect(200);
    const { temporaryPassword } = response.body as { temporaryPassword: string };

    const rows = await db.withoutTenant(async (tx) => {
      const result = await tx.query<{
        user_id: string;
        entity_id: string;
        old_values: unknown;
        new_values: unknown;
      }>(
        `SELECT user_id, entity_id, old_values, new_values FROM audit_logs
          WHERE action = 'reset_user_password'`,
      );
      return result.rows;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(admin.id);
    expect(rows[0]!.entity_id).toBe(attendant.id);
    expect(JSON.stringify(rows[0])).not.toContain(temporaryPassword);
  });

  it('admin pode resetar gestor e outro admin', async () => {
    const manager = await createUser({ tenantId: tenant.id, email: 'gestor@rita.com', role: 'manager' });
    const otherAdmin = await createUser({ tenantId: tenant.id, email: 'admin2@rita.com', role: 'admin' });
    await reset(manager).expect(200);
    await reset(otherAdmin).expect(200);
  });

  it('a própria conta responde 404 (a própria senha é em Minha Conta)', async () => {
    const response = await reset(admin).expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(await flagOf(admin.id)).toBe(false);
  });

  it('usuário de outro tenant responde 404, nunca 403, e não é alterado', async () => {
    const other = await createTenant({ name: 'Lab Outro', slug: 'lab-outro' });
    const foreign = await createUser({ tenantId: other.id, email: 'x@outro.com', role: 'attendant' });

    const response = await reset(foreign).expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(await flagOf(foreign.id)).toBe(false);
    await login(foreign.email, DEFAULT_TEST_PASSWORD);
  });

  it('gestor e atendente recebem 403 FORBIDDEN', async () => {
    const manager = await createUser({ tenantId: tenant.id, email: 'gestor@rita.com', role: 'manager' });
    const forbiddenForManager = await reset(attendant, manager).expect(403);
    expect(forbiddenForManager.body.error.code).toBe('FORBIDDEN');
    await reset(manager, attendant).expect(403);
    expect(await flagOf(attendant.id)).toBe(false);
  });

  it('id não-uuid responde 400', async () => {
    await app.agent
      .post('/api/v1/users/nao-e-uuid/reset-password')
      .set(app.auth(admin))
      .expect(400);
  });

  describe('com a senha provisória pendente', () => {
    let temporaryPassword: string;
    let session: Awaited<ReturnType<typeof login>>;
    const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

    beforeEach(async () => {
      const response = await reset(attendant).expect(200);
      temporaryPassword = (response.body as { temporaryPassword: string }).temporaryPassword;
      session = await login(attendant.email, temporaryPassword);
    });

    it('recusa as demais rotas com 403 PASSWORD_CHANGE_REQUIRED', async () => {
      const response = await app.agent
        .get('/api/v1/users/presence')
        .set(bearer(session.body.accessToken))
        .expect(403);
      expect(response.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    });

    it('aceita GET /users/me', async () => {
      await app.agent.get('/api/v1/users/me').set(bearer(session.body.accessToken)).expect(200);
    });

    it('o refresh continua emitindo token com o claim enquanto não troca', async () => {
      const response = await app.agent
        .post('/api/v1/auth/refresh')
        .set('X-Requested-With', 'crm-lab')
        .set('Cookie', `${REFRESH_COOKIE_NAME}=${session.refresh}`)
        .expect(200);
      const claims = verifyAccessToken((response.body as { accessToken: string }).accessToken);
      expect(claims.ok && claims.payload.mustChangePassword).toBe(true);
    });

    it('o /ws fica fechado até a troca', async () => {
      expect(await refreshSessionIsLive(db, session.refresh)).toBe(false);
    });

    it('trocar a senha desliga a flag; o refresh seguinte sai sem o claim e libera as rotas', async () => {
      await app.agent
        .patch('/api/v1/users/me/password')
        .set(bearer(session.body.accessToken))
        .set('Cookie', `${REFRESH_COOKIE_NAME}=${session.refresh}`)
        .send({ currentPassword: temporaryPassword, newPassword: NEW_PASSWORD })
        .expect(200);
      expect(await flagOf(attendant.id)).toBe(false);

      const refreshed = await app.agent
        .post('/api/v1/auth/refresh')
        .set('X-Requested-With', 'crm-lab')
        .set('Cookie', `${REFRESH_COOKIE_NAME}=${session.refresh}`)
        .expect(200);
      const accessToken = (refreshed.body as { accessToken: string }).accessToken;
      const claims = verifyAccessToken(accessToken);
      expect(claims.ok && claims.payload.mustChangePassword).toBeUndefined();

      await app.agent.get('/api/v1/users/presence').set(bearer(accessToken)).expect(200);
      const next = await login(attendant.email, NEW_PASSWORD);
      expect(next.body.user.mustChangePassword).toBe(false);
    });
  });

  it('login normal informa mustChangePassword: false e o token sai sem o claim', async () => {
    const session = await login(attendant.email, DEFAULT_TEST_PASSWORD);
    expect(session.body.user.mustChangePassword).toBe(false);
    const claims = verifyAccessToken(session.body.accessToken);
    expect(claims.ok && 'mustChangePassword' in claims.payload).toBe(false);
  });

  it('o reset do console da plataforma também liga a troca obrigatória (D-326)', async () => {
    const operatorTenant = await createTenant({ name: 'Plataforma', slug: 'plataforma' });
    const operator = await createUser({
      tenantId: operatorTenant.id,
      email: 'op@plataforma.com',
      role: 'platform_operator',
    });
    await app.agent
      .post(`/api/v1/platform/tenants/${tenant.id}/users/${admin.id}/reset-password`)
      .set(app.auth(operator))
      .expect(200);
    expect(await flagOf(admin.id)).toBe(true);
  });
});
