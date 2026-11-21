/**
 * Dispositivos de captura e pareamento — API_CONTRACTS §15.1/§15.2
 * (CRMLAB-184, D-327).
 *
 * Protege: papeis (manager le, admin escreve, platform_operator nunca);
 * audit de cadastro/codigo/revogacao/pareamento; as quatro falhas do
 * pareamento respondem IGUAL; parear de novo derruba a credencial antiga;
 * `/capture/session` 401 sem credencial valida; rate limit do pair contado
 * antes de conferir e fail-closed sem Redis; Origin conferido.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { captureDeviceModule } from '../../src/controllers/capture-device.routes.js';
import { captureModule, PAIR_ATTEMPT_LIMIT } from '../../src/controllers/capture.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { MemoryCache } from '../../src/lib/cache.js';
import { CAPTURE_COOKIE_NAME } from '../../src/lib/cookies.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { ALLOWED_ORIGIN, auditActions, createDeviceViaApi, pairViaApi } from './helpers.js';

const MODULES = [captureDeviceModule, captureModule];

describe('dispositivos de captura e pareamento', () => {
  let db: DbClient;
  let app: TestApp;
  let tenant: TenantRecord;
  let admin: UserRecord;
  let manager: UserRecord;
  let attendant: UserRecord;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    app = await createTestApp({ db, modules: MODULES });
    tenant = await createTenant({ name: 'Laboratorio Sante', db });
    admin = await createUser({ tenantId: tenant.id, role: 'admin', db });
    manager = await createUser({ tenantId: tenant.id, role: 'manager', db });
    attendant = await createUser({ tenantId: tenant.id, role: 'attendant', db });
  });

  describe('/settings/capture-devices', () => {
    it('admin cadastra: 201 com codigo de 8 caracteres, 15 min, so o hash no banco e audit', async () => {
      const res = await app.agent
        .post('/api/v1/settings/capture-devices')
        .set(app.auth(admin))
        .send({ name: '  Celular recepcao  ' })
        .expect(201);
      expect(res.body.device).toMatchObject({
        name: 'Celular recepcao',
        status: 'pending',
        pairedAt: null,
        lastUsedAt: null,
        pendingScans: 0,
      });
      expect(res.body.pairing.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
      const ttl = new Date(res.body.pairing.expiresAt).getTime() - Date.now();
      expect(ttl).toBeGreaterThan(14 * 60_000);
      expect(ttl).toBeLessThanOrEqual(15 * 60_000);
      expect(res.body.device.pairingCodeExpiresAt).toBe(res.body.pairing.expiresAt);

      const stored = await db.withoutTenant((tx) =>
        tx.query<{ pairing_code_hash: string }>('SELECT pairing_code_hash FROM capture_devices'),
      );
      expect(stored.rows[0]?.pairing_code_hash).toHaveLength(64);
      expect(stored.rows[0]?.pairing_code_hash).not.toContain(res.body.pairing.code);

      expect(await auditActions(db, 'create_capture_device')).toEqual([
        { user_id: admin.id, entity_id: res.body.device.id },
      ]);
    });

    it('nome vazio ou acima de 60 caracteres e 400', async () => {
      for (const name of ['   ', 'x'.repeat(61)]) {
        await app.agent
          .post('/api/v1/settings/capture-devices')
          .set(app.auth(admin))
          .send({ name })
          .expect(400);
      }
    });

    it('manager le mas nao escreve; attendant nem le; platform_operator nunca', async () => {
      const device = await createDeviceViaApi(app, admin);
      const list = await app.agent.get('/api/v1/settings/capture-devices').set(app.auth(manager)).expect(200);
      expect(list.body.devices).toHaveLength(1);
      expect(list.body.pagination).toMatchObject({ page: 1, limit: 50, total: 1 });

      await app.agent.post('/api/v1/settings/capture-devices').set(app.auth(manager)).send({ name: 'x' }).expect(403);
      await app.agent
        .post(`/api/v1/settings/capture-devices/${device.id}/pairing-code`)
        .set(app.auth(manager))
        .expect(403);
      await app.agent.delete(`/api/v1/settings/capture-devices/${device.id}`).set(app.auth(manager)).expect(403);
      await app.agent.get('/api/v1/settings/capture-devices').set(app.auth(attendant)).expect(403);

      const plataforma = await createTenant({ db });
      const operator = await createUser({ tenantId: plataforma.id, role: 'platform_operator', db });
      await app.agent.get('/api/v1/settings/capture-devices').set(app.auth(operator)).expect(403);
    });

    it('revogar: 204 idempotente, um audit so, revogados por ultimo, novo codigo vira 409', async () => {
      const first = await createDeviceViaApi(app, admin, 'Antigo');
      await createDeviceViaApi(app, admin, 'Novo');
      await app.agent.delete(`/api/v1/settings/capture-devices/${first.id}`).set(app.auth(admin)).expect(204);
      await app.agent.delete(`/api/v1/settings/capture-devices/${first.id}`).set(app.auth(admin)).expect(204);
      expect(await auditActions(db, 'revoke_capture_device')).toHaveLength(1);

      const list = await app.agent.get('/api/v1/settings/capture-devices').set(app.auth(admin)).expect(200);
      expect(list.body.devices.map((d: { name: string; status: string }) => [d.name, d.status])).toEqual([
        ['Novo', 'pending'],
        ['Antigo', 'revoked'],
      ]);

      const renew = await app.agent
        .post(`/api/v1/settings/capture-devices/${first.id}/pairing-code`)
        .set(app.auth(admin))
        .expect(409);
      expect(renew.body.error.details).toEqual({ reason: 'device_revoked' });
    });

    it('dispositivo de outro laboratorio e 404', async () => {
      const other = await createTenant({ db });
      const otherAdmin = await createUser({ tenantId: other.id, role: 'admin', db });
      const device = await createDeviceViaApi(app, otherAdmin);
      await app.agent
        .post(`/api/v1/settings/capture-devices/${device.id}/pairing-code`)
        .set(app.auth(admin))
        .expect(404);
      await app.agent.delete(`/api/v1/settings/capture-devices/${device.id}`).set(app.auth(admin)).expect(404);
    });
  });

  describe('POST /capture/pair', () => {
    it('codigo certo (com hifen e minusculas) pareia: cookie httpOnly/Strict no path da captura, audit sem usuario', async () => {
      const device = await createDeviceViaApi(app, admin);
      const typed = `${device.code.slice(0, 4).toLowerCase()}-${device.code.slice(4)}`;
      const res = await app.agent
        .post('/api/v1/capture/pair')
        .set('Origin', ALLOWED_ORIGIN)
        .send({ code: typed })
        .expect(200);
      expect(res.body).toEqual({ deviceName: 'Celular recepcao', tenantName: 'Laboratorio Sante' });
      const cookie = (res.headers['set-cookie'] as unknown as string[])[0] as string;
      expect(cookie).toMatch(new RegExp(`^${CAPTURE_COOKIE_NAME}=[A-Za-z0-9_-]{43};`));
      expect(cookie).toContain('Path=/api/v1/capture');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain(`Max-Age=${400 * 24 * 60 * 60}`);

      expect(await auditActions(db, 'pair_capture_device')).toEqual([{ user_id: null, entity_id: device.id }]);
      const list = await app.agent.get('/api/v1/settings/capture-devices').set(app.auth(admin)).expect(200);
      expect(list.body.devices[0]).toMatchObject({ status: 'active', pairingCodeExpiresAt: null });
      expect(list.body.devices[0].pairedAt).not.toBeNull();
    });

    it('inexistente, vencido, ja usado e revogado respondem igual (PAIRING_CODE_INVALID)', async () => {
      const used = await createDeviceViaApi(app, admin, 'Usado');
      await pairViaApi(app, used.code);

      const expired = await createDeviceViaApi(app, admin, 'Vencido');
      await db.withoutTenant((tx) =>
        tx.query(`UPDATE capture_devices SET pairing_code_expires_at = now() - interval '1 minute' WHERE id = $1`, [
          expired.id,
        ]),
      );
      const revoked = await createDeviceViaApi(app, admin, 'Revogado');
      await app.agent.delete(`/api/v1/settings/capture-devices/${revoked.id}`).set(app.auth(admin)).expect(204);

      const bodies: unknown[] = [];
      for (const code of ['ZZZZZZZZ', expired.code, used.code, revoked.code]) {
        const res = await app.agent
          .post('/api/v1/capture/pair')
          .set('Origin', ALLOWED_ORIGIN)
          .send({ code })
          .expect(400);
        expect(res.headers['set-cookie']).toBeUndefined();
        bodies.push(res.body);
      }
      expect(bodies.every((b) => JSON.stringify(b) === JSON.stringify(bodies[0]))).toBe(true);
      expect((bodies[0] as { error: { code: string } }).error.code).toBe('PAIRING_CODE_INVALID');
    });

    it('laboratorio inativo nao pareia', async () => {
      const device = await createDeviceViaApi(app, admin);
      await db.withoutTenant((tx) => tx.query('UPDATE tenants SET is_active = FALSE WHERE id = $1', [tenant.id]));
      const res = await app.agent
        .post('/api/v1/capture/pair')
        .set('Origin', ALLOWED_ORIGIN)
        .send({ code: device.code })
        .expect(400);
      expect(res.body.error.code).toBe('PAIRING_CODE_INVALID');
    });

    it('parear de novo (codigo novo) troca a credencial: a antiga deixa de valer', async () => {
      const device = await createDeviceViaApi(app, admin);
      const oldCookie = await pairViaApi(app, device.code);
      await app.agent.get('/api/v1/capture/session').set('Cookie', oldCookie).expect(200);

      const renew = await app.agent
        .post(`/api/v1/settings/capture-devices/${device.id}/pairing-code`)
        .set(app.auth(admin))
        .expect(200);
      expect(await auditActions(db, 'renew_capture_device_pairing_code')).toHaveLength(1);
      // Gerar o codigo nao derruba o celular; parear com ele, sim.
      await app.agent.get('/api/v1/capture/session').set('Cookie', oldCookie).expect(200);
      const newCookie = await pairViaApi(app, renew.body.code as string);

      const old = await app.agent.get('/api/v1/capture/session').set('Cookie', oldCookie).expect(401);
      expect(old.body.error.code).toBe('CAPTURE_DEVICE_UNPAIRED');
      await app.agent.get('/api/v1/capture/session').set('Cookie', newCookie).expect(200);
    });

    it('Origin ausente ou fora da lista e 403 sem consumir o codigo', async () => {
      const device = await createDeviceViaApi(app, admin);
      await app.agent.post('/api/v1/capture/pair').send({ code: device.code }).expect(403);
      await app.agent
        .post('/api/v1/capture/pair')
        .set('Origin', 'https://evil.example')
        .send({ code: device.code })
        .expect(403);
      await pairViaApi(app, device.code);
    });

    it('10 tentativas / 15 min por IP, contadas antes de conferir: a 11a e 429 mesmo com o codigo certo', async () => {
      const device = await createDeviceViaApi(app, admin);
      for (let i = 0; i < PAIR_ATTEMPT_LIMIT; i += 1) {
        await app.agent.post('/api/v1/capture/pair').set('Origin', ALLOWED_ORIGIN).send({ code: 'ZZZZZZZZ' }).expect(400);
      }
      const res = await app.agent
        .post('/api/v1/capture/pair')
        .set('Origin', ALLOWED_ORIGIN)
        .send({ code: device.code })
        .expect(429);
      expect(res.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('Redis fora do ar: 503 (fail-closed)', async () => {
      const cache = new MemoryCache();
      const broken = await createTestApp({ db, cache, modules: MODULES });
      await cache.close();
      cache.incr = async () => {
        throw new Error('redis down');
      };
      const res = await broken.agent
        .post('/api/v1/capture/pair')
        .set('Origin', ALLOWED_ORIGIN)
        .send({ code: 'ZZZZZZZZ' })
        .expect(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    });
  });

  describe('GET /capture/session', () => {
    it('sem cookie, credencial desconhecida, revogado ou laboratorio inativo: 401 CAPTURE_DEVICE_UNPAIRED', async () => {
      const device = await createDeviceViaApi(app, admin);
      const cookie = await pairViaApi(app, device.code);
      const ok = await app.agent.get('/api/v1/capture/session').set('Cookie', cookie).expect(200);
      expect(ok.body).toEqual({ deviceName: 'Celular recepcao', tenantName: 'Laboratorio Sante' });

      const noCookie = await app.agent.get('/api/v1/capture/session').expect(401);
      expect(noCookie.body.error.code).toBe('CAPTURE_DEVICE_UNPAIRED');
      await app.agent
        .get('/api/v1/capture/session')
        .set('Cookie', `${CAPTURE_COOKIE_NAME}=${'A'.repeat(43)}`)
        .expect(401);

      await db.withoutTenant((tx) => tx.query('UPDATE tenants SET is_active = FALSE WHERE id = $1', [tenant.id]));
      await app.agent.get('/api/v1/capture/session').set('Cookie', cookie).expect(401);
      await db.withoutTenant((tx) => tx.query('UPDATE tenants SET is_active = TRUE WHERE id = $1', [tenant.id]));
      await app.agent.get('/api/v1/capture/session').set('Cookie', cookie).expect(200);

      await app.agent.delete(`/api/v1/settings/capture-devices/${device.id}`).set(app.auth(admin)).expect(204);
      await app.agent.get('/api/v1/capture/session').set('Cookie', cookie).expect(401);
    });

    it('o Bearer de um usuario nao abre a captura', async () => {
      await app.agent.get('/api/v1/capture/session').set(app.auth(admin)).expect(401);
    });
  });
});
