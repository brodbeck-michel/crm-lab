/**
 * Ciclo de vida da sessao — CRMLAB-35 (D-154 teto absoluto e desativacao,
 * D-155 limpeza). Os tres criterios de aceite do card que sobram depois do
 * `change-password.spec.ts`:
 *
 *   - login ha 31 dias -> refresh recusado;
 *   - desativar usuario -> refresh recusado imediatamente;
 *   - apos o job, nao sobra linha expirada ha mais de 7 dias.
 *
 * O tempo e simulado mexendo nas colunas no banco (nao em fake timers): o teto
 * vive em `refresh_tokens.absolute_expires_at` e e o banco que o compara.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { REFRESH_COOKIE_NAME } from '../../src/http/refresh-cookie.js';
import { deleteExpiredOrRevoked } from '../../src/repositories/refresh-token.repository.js';
import { authModule } from '../../src/controllers/auth.routes.js';
import { userModule } from '../../src/controllers/user.routes.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import {
  createTenant,
  createUser,
  DEFAULT_TEST_PASSWORD,
  type TenantRecord,
  type UserRecord,
} from '../helpers/factories.js';

function refreshCookieValue(setCookie: string[] | undefined): string {
  const raw = setCookie?.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
  const value = raw?.split(';')[0]?.split('=')[1];
  if (!value) throw new Error('resposta de login nao trouxe o cookie de refresh');
  return value;
}

describe('ciclo de vida da sessao (CRMLAB-35)', () => {
  let db: DbClient;
  let app: TestApp;
  let tenant: TenantRecord;
  let user: UserRecord;

  async function loginSession(): Promise<string> {
    const response = await app.agent
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD })
      .expect(200);
    return refreshCookieValue(response.headers['set-cookie'] as string[] | undefined);
  }

  function refresh(token: string) {
    return app.agent
      .post('/api/v1/auth/refresh')
      .set('X-Requested-With', 'crm-lab')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${token}`);
  }

  async function countRefreshRows(): Promise<number> {
    return db.withoutTenant(async (tx) => {
      const result = await tx.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM refresh_tokens WHERE user_id = $1`,
        [user.id],
      );
      return Number(result.rows[0]!.n);
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
      role: 'admin',
    });
  });

  describe('teto absoluto da familia (D-154)', () => {
    it('o login grava `absolute_expires_at` no futuro', async () => {
      await loginSession();

      const row = await db.withoutTenant(async (tx) => {
        const result = await tx.query<{ absolute_expires_at: Date | string }>(
          `SELECT absolute_expires_at FROM refresh_tokens WHERE user_id = $1`,
          [user.id],
        );
        return result.rows[0]!;
      });

      expect(new Date(row.absolute_expires_at).getTime()).toBeGreaterThan(Date.now());
    });

    it('criterio de aceite: familia com 31 dias tem o refresh recusado', async () => {
      const token = await loginSession();

      // Simula o login ter acontecido ha 31 dias: o teto (30 dias) ja passou,
      // mas o token em si continua dentro dos 7 dias rotativos.
      await db.withoutTenant(async (tx) => {
        await tx.query(
          `UPDATE refresh_tokens SET absolute_expires_at = NOW() - INTERVAL '1 day'
            WHERE user_id = $1`,
          [user.id],
        );
      });

      await refresh(token).expect(401);
    });

    it('a rotacao CARREGA o teto adiante em vez de reinicia-lo', async () => {
      const token = await loginSession();

      const antes = await db.withoutTenant(async (tx) => {
        const result = await tx.query<{ absolute_expires_at: Date | string }>(
          `SELECT absolute_expires_at FROM refresh_tokens WHERE user_id = $1`,
          [user.id],
        );
        return new Date(result.rows[0]!.absolute_expires_at).getTime();
      });

      await refresh(token).expect(200);

      const depois = await db.withoutTenant(async (tx) => {
        const result = await tx.query<{ absolute_expires_at: Date | string }>(
          `SELECT absolute_expires_at FROM refresh_tokens
            WHERE user_id = $1 AND revoked_at IS NULL`,
          [user.id],
        );
        return new Date(result.rows[0]!.absolute_expires_at).getTime();
      });

      // Mesmo teto (ate o segundo): se a rotacao renovasse o teto, "absoluto"
      // nao seria absoluto e a sessao viveria para sempre.
      expect(Math.abs(depois - antes)).toBeLessThan(1000);
    });
  });

  describe('desativacao do usuario (D-154)', () => {
    it('criterio de aceite: desativar recusa o refresh imediatamente', async () => {
      const alvo = await createUser({
        tenantId: tenant.id,
        email: 'maria@lab.com',
        name: 'Maria Souza',
        role: 'attendant',
      });

      const response = await app.agent
        .post('/api/v1/auth/login')
        .send({ email: alvo.email, password: DEFAULT_TEST_PASSWORD })
        .expect(200);
      const token = refreshCookieValue(response.headers['set-cookie'] as string[] | undefined);

      await refresh(token).expect(200);

      await app.agent
        .patch(`/api/v1/users/${alvo.id}`)
        .set(app.auth(user))
        .send({ isActive: false })
        .expect(200);

      await app.agent
        .post('/api/v1/auth/refresh')
        .set('X-Requested-With', 'crm-lab')
        .set('Cookie', `${REFRESH_COOKIE_NAME}=${token}`)
        .expect(401);
    });

    it('editar outro campo NAO derruba a sessao', async () => {
      const alvo = await createUser({
        tenantId: tenant.id,
        email: 'carlos@lab.com',
        name: 'Carlos Lima',
        role: 'attendant',
      });

      const response = await app.agent
        .post('/api/v1/auth/login')
        .send({ email: alvo.email, password: DEFAULT_TEST_PASSWORD })
        .expect(200);
      const token = refreshCookieValue(response.headers['set-cookie'] as string[] | undefined);

      await app.agent
        .patch(`/api/v1/users/${alvo.id}`)
        .set(app.auth(user))
        .send({ name: 'Carlos Lima Filho' })
        .expect(200);

      await app.agent
        .post('/api/v1/auth/refresh')
        .set('X-Requested-With', 'crm-lab')
        .set('Cookie', `${REFRESH_COOKIE_NAME}=${token}`)
        .expect(200);
    });
  });

  describe('limpeza periodica (D-155)', () => {
    it('criterio de aceite: apaga expirado e revogado ha mais de 7 dias, preserva o resto', async () => {
      await loginSession(); // familia viva, nao deve sumir
      expect(await countRefreshRows()).toBe(1);

      await db.withoutTenant(async (tx) => {
        // expirado ha 8 dias
        await tx.query(
          `INSERT INTO refresh_tokens (tenant_id, user_id, token_hash, expires_at, absolute_expires_at)
           VALUES ($1, $2, 'hash-expirado-ha-8-dias', NOW() - INTERVAL '8 days', NOW() + INTERVAL '1 day')`,
          [tenant.id, user.id],
        );
        // revogado ha 8 dias
        await tx.query(
          `INSERT INTO refresh_tokens (tenant_id, user_id, token_hash, expires_at, absolute_expires_at, revoked_at)
           VALUES ($1, $2, 'hash-revogado-ha-8-dias', NOW() + INTERVAL '1 day', NOW() + INTERVAL '10 days',
                   NOW() - INTERVAL '8 days')`,
          [tenant.id, user.id],
        );
        // expirado ha 1 dia — dentro da carencia de 7 dias, fica
        await tx.query(
          `INSERT INTO refresh_tokens (tenant_id, user_id, token_hash, expires_at, absolute_expires_at)
           VALUES ($1, $2, 'hash-expirado-ontem', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day')`,
          [tenant.id, user.id],
        );
      });
      expect(await countRefreshRows()).toBe(4);

      const deleted = await deleteExpiredOrRevoked(db);

      expect(deleted).toBe(2);
      const restantes = await db.withoutTenant(async (tx) => {
        const result = await tx.query<{ token_hash: string }>(
          `SELECT token_hash FROM refresh_tokens WHERE user_id = $1 ORDER BY token_hash`,
          [user.id],
        );
        return result.rows.map((r) => r.token_hash);
      });
      expect(restantes).toContain('hash-expirado-ontem');
      expect(restantes).toHaveLength(2); // o de ontem + a familia viva do login
    });

    it('e idempotente: rodar de novo nao apaga mais nada', async () => {
      await loginSession();
      await deleteExpiredOrRevoked(db);
      expect(await deleteExpiredOrRevoked(db)).toBe(0);
    });
  });
});
