import { Router } from 'express';
import { describe, expect, it } from 'vitest';
import type { ApiModule, ApiModuleDeps } from '../../src/http/api-module.js';
import { getContext } from '../../src/http/context.js';
import { requireAuth, requireRoles } from '../../src/http/middleware/auth.js';
import { signAccessToken } from '../../src/lib/tokens.js';
import { createTestApp, type AuthenticatableUser } from '../helpers/test-app.js';

const USER: AuthenticatableUser = {
  id: '11111111-1111-1111-1111-111111111111',
  tenantId: '22222222-2222-2222-2222-222222222222',
  role: 'attendant',
  discountLimit: 15,
};

const MANAGER: AuthenticatableUser = { ...USER, id: '33333333-3333-3333-3333-333333333333', role: 'manager', discountLimit: 30 };

function guardedModule(_deps: ApiModuleDeps): ApiModule {
  const router = Router();
  router.get('/me', requireAuth(), (req, res) => {
    res.json(getContext(req));
  });
  router.get('/manager-only', requireAuth(), requireRoles('manager', 'admin'), (_req, res) => {
    res.json({ ok: true });
  });
  return { basePath: '/guarded', router, requiresAuth: true };
}

describe('auth middleware', () => {
  it('sem token -> 401 UNAUTHORIZED', async () => {
    const { agent } = await createTestApp({ modules: [guardedModule] });
    const res = await agent.get('/api/v1/guarded/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('esquema errado no header -> 401 UNAUTHORIZED', async () => {
    const { agent } = await createTestApp({ modules: [guardedModule] });
    const res = await agent.get('/api/v1/guarded/me').set('Authorization', 'Basic abc');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('token malformado -> 401 TOKEN_INVALID', async () => {
    const { agent } = await createTestApp({ modules: [guardedModule] });
    const res = await agent.get('/api/v1/guarded/me').set('Authorization', 'Bearer nao.e.um.jwt');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('token assinado com outro segredo -> 401 TOKEN_INVALID', async () => {
    const { agent } = await createTestApp({ modules: [guardedModule] });
    // Header/payload validos, assinatura trocada.
    const valid = signAccessToken({
      userId: USER.id,
      tenantId: USER.tenantId,
      role: USER.role,
      discountLimit: USER.discountLimit,
    });
    const tampered = `${valid.slice(0, valid.lastIndexOf('.'))}.assinaturafalsa`;
    const res = await agent.get('/api/v1/guarded/me').set('Authorization', `Bearer ${tampered}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('token expirado -> 401 TOKEN_EXPIRED (distinto de TOKEN_INVALID)', async () => {
    const { agent } = await createTestApp({ modules: [guardedModule] });
    const expired = signAccessToken(
      {
        userId: USER.id,
        tenantId: USER.tenantId,
        role: USER.role,
        discountLimit: USER.discountLimit,
      },
      -10,
    );
    const res = await agent.get('/api/v1/guarded/me').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('token valido popula req.ctx com os dados do TOKEN', async () => {
    const { agent, auth } = await createTestApp({ modules: [guardedModule] });
    const res = await agent.get('/api/v1/guarded/me').set(auth(USER));

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(USER.id);
    expect(res.body.tenantId).toBe(USER.tenantId);
    expect(res.body.role).toBe('attendant');
    expect(res.body.discountLimit).toBe(15);
    expect(typeof res.body.ip).toBe('string');
    expect(typeof res.body.userAgent).toBe('string');
  });

  it('tenantId do cliente e ignorado — vale so o do token', async () => {
    const { agent, auth } = await createTestApp({ modules: [guardedModule] });
    const res = await agent
      .get('/api/v1/guarded/me')
      .query({ tenantId: 'tenant-forjado' })
      .set(auth(USER))
      .set('X-Tenant-Id', 'tenant-forjado');

    expect(res.body.tenantId).toBe(USER.tenantId);
  });

  it('role errada -> 403 FORBIDDEN com details.requiredRoles', async () => {
    const { agent, auth } = await createTestApp({ modules: [guardedModule] });
    const res = await agent.get('/api/v1/guarded/manager-only').set(auth(USER));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.details.requiredRoles).toEqual(['manager', 'admin']);
  });

  it('role permitida passa', async () => {
    const { agent, auth } = await createTestApp({ modules: [guardedModule] });
    const res = await agent.get('/api/v1/guarded/manager-only').set(auth(MANAGER));
    expect(res.status).toBe(200);
  });
});
