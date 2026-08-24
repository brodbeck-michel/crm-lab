/**
 * `/users` — tela `/settings/users` (PAGES.md §10).
 *
 * Inclui os testes de isolamento multitenant, que TESTING.md marca como
 * bloqueantes de release: usuario do tenant A nao lista, nao le e nao edita
 * usuario do tenant B — e a resposta e 404, nunca 403 (SECURITY.md camada 2).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ListUsersResponse, ManagedUser } from '@crm-lab/shared';
import { DEFAULT_DISCOUNT_LIMIT } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { userModule } from '../../src/controllers/user.routes.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import {
  createTenant,
  createUser,
  type TenantRecord,
  type UserRecord,
} from '../helpers/factories.js';

describe('/users', () => {
  let db: DbClient;
  let app: TestApp;
  let tenantA: TenantRecord;
  let tenantB: TenantRecord;
  let adminA: UserRecord;
  let attendantA: UserRecord;
  let adminB: UserRecord;
  let attendantB: UserRecord;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    app = await createTestApp({ db, modules: [userModule] });

    tenantA = await createTenant({ name: 'Lab A' });
    tenantB = await createTenant({ name: 'Lab B' });
    adminA = await createUser({ tenantId: tenantA.id, role: 'admin', name: 'Admin A' });
    attendantA = await createUser({
      tenantId: tenantA.id,
      role: 'attendant',
      name: 'Atendente A',
    });
    adminB = await createUser({ tenantId: tenantB.id, role: 'admin', name: 'Admin B' });
    attendantB = await createUser({
      tenantId: tenantB.id,
      role: 'attendant',
      name: 'Atendente B',
    });
  });

  describe('GET /users/me', () => {
    it('sem token -> 401 UNAUTHORIZED', async () => {
      const response = await app.agent.get('/api/v1/users/me').expect(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
    });

    it('devolve o shape de CurrentUserResponse', async () => {
      const response = await app.agent
        .get('/api/v1/users/me')
        .set(app.auth(attendantA))
        .expect(200);

      expect(Object.keys(response.body).sort()).toEqual(
        ['createdAt', 'discountLimit', 'email', 'id', 'name', 'role'].sort(),
      );
      expect(response.body.id).toBe(attendantA.id);
      expect(response.body.name).toBe('Atendente A');
      expect(response.body.role).toBe('attendant');
      expect(response.body.discountLimit).toBe(15);
      // Nunca vaza hash de senha.
      expect(JSON.stringify(response.body)).not.toContain('$2');
    });

    it('token com userId de A mas tenantId de B nao enxerga o usuario -> 404', async () => {
      const forgedContext = { ...attendantA, tenantId: tenantB.id };

      const response = await app.agent
        .get('/api/v1/users/me')
        .set(app.auth(forgedContext))
        .expect(404);

      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /users (admin)', () => {
    it('lista apenas os usuarios do proprio tenant', async () => {
      const response = await app.agent.get('/api/v1/users').set(app.auth(adminA)).expect(200);

      const body = response.body as ListUsersResponse;
      const ids = body.users.map((u) => u.id).sort();
      expect(ids).toEqual([adminA.id, attendantA.id].sort());
      expect(ids).not.toContain(adminB.id);
      expect(ids).not.toContain(attendantB.id);

      expect(body.pagination).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
      expect(Object.keys(body.users[0]!).sort()).toEqual(
        [
          'createdAt',
          'discountLimit',
          'email',
          'id',
          'isActive',
          'lastLoginAt',
          'name',
          'role',
        ].sort(),
      );
    });

    it('atendente nao lista -> FORBIDDEN com details.requiredRoles', async () => {
      const response = await app.agent
        .get('/api/v1/users')
        .set(app.auth(attendantA))
        .expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
      expect(response.body.error.details.requiredRoles).toEqual(['admin']);
    });
  });

  describe('POST /users (admin)', () => {
    it('cria usuario com a alcada padrao do papel (DEFAULT_DISCOUNT_LIMIT)', async () => {
      const response = await app.agent
        .post('/api/v1/users')
        .set(app.auth(adminA))
        .send({
          email: 'nova.gestora@lab.com',
          name: 'Nova Gestora',
          password: 'senha-forte-123',
          role: 'manager',
        })
        .expect(201);

      const created = response.body as ManagedUser;
      expect(created.role).toBe('manager');
      expect(created.discountLimit).toBe(DEFAULT_DISCOUNT_LIMIT.manager);
      expect(created.isActive).toBe(true);

      // Nasceu no tenant de quem criou — e so la e visivel.
      const visibleToB = await app.agent.get('/api/v1/users').set(app.auth(adminB)).expect(200);
      expect((visibleToB.body as ListUsersResponse).users.map((u) => u.id)).not.toContain(
        created.id,
      );
    });

    it('atendente nao cria -> FORBIDDEN com details.requiredRoles', async () => {
      const response = await app.agent
        .post('/api/v1/users')
        .set(app.auth(attendantA))
        .send({
          email: 'tentativa@lab.com',
          name: 'Tentativa',
          password: 'senha-forte-123',
          role: 'admin',
        })
        .expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
      expect(response.body.error.details.requiredRoles).toEqual(['admin']);
    });

    it('nao permite criar platform_operator dentro de um laboratorio', async () => {
      const response = await app.agent
        .post('/api/v1/users')
        .set(app.auth(adminA))
        .send({
          email: 'operador@plataforma.com',
          name: 'Operador',
          password: 'senha-forte-123',
          role: 'platform_operator',
        })
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details.fields).toHaveProperty('role');
    });

    it('e-mail repetido no mesmo tenant -> CONFLICT', async () => {
      const response = await app.agent
        .post('/api/v1/users')
        .set(app.auth(adminA))
        .send({
          email: attendantA.email,
          name: 'Duplicado',
          password: 'senha-forte-123',
          role: 'attendant',
        })
        .expect(409);

      expect(response.body.error.code).toBe('CONFLICT');
    });

    it('senha curta -> VALIDATION_ERROR', async () => {
      const response = await app.agent
        .post('/api/v1/users')
        .set(app.auth(adminA))
        .send({ email: 'curta@lab.com', name: 'Curta', password: 'abc', role: 'attendant' })
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details.fields).toHaveProperty('password');
    });
  });

  describe('PATCH /users/:id (admin)', () => {
    it('desativa em vez de deletar', async () => {
      const response = await app.agent
        .patch(`/api/v1/users/${attendantA.id}`)
        .set(app.auth(adminA))
        .send({ isActive: false })
        .expect(200);

      expect((response.body as ManagedUser).isActive).toBe(false);

      // A linha continua existindo — desativar nao apaga historico.
      const rows = await db.withoutTenant((tx) =>
        tx.query('SELECT id FROM users WHERE id = $1', [attendantA.id]),
      );
      expect(rows.rows).toHaveLength(1);
    });

    it('muda papel e alcada de outro usuario', async () => {
      const response = await app.agent
        .patch(`/api/v1/users/${attendantA.id}`)
        .set(app.auth(adminA))
        .send({ role: 'manager', discountLimit: 30 })
        .expect(200);

      expect((response.body as ManagedUser).role).toBe('manager');
      expect((response.body as ManagedUser).discountLimit).toBe(30);
    });

    it('D-013: admin nao eleva a propria alcada', async () => {
      // Admin com alcada reduzida: sem isso o teste comparava 100 com 100 e
      // nao chegava a exercitar a regra.
      const limitedAdmin = await createUser({
        tenantId: tenantA.id,
        role: 'admin',
        discountLimit: 40,
      });

      const response = await app.agent
        .patch(`/api/v1/users/${limitedAdmin.id}`)
        .set(app.auth(limitedAdmin))
        .send({ discountLimit: 100 })
        .expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
      expect(response.body.error.details.reason).toBe('self_privilege_change');
      expect(response.body.error.details.fields).toContain('discountLimit');
    });

    it('D-013: admin nao muda o proprio papel', async () => {
      const response = await app.agent
        .patch(`/api/v1/users/${adminA.id}`)
        .set(app.auth(adminA))
        .send({ role: 'attendant' })
        .expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
      expect(response.body.error.details.fields).toContain('role');
    });

    it('D-013: renomear a si mesmo continua permitido', async () => {
      const response = await app.agent
        .patch(`/api/v1/users/${adminA.id}`)
        .set(app.auth(adminA))
        .send({ name: 'Admin A Renomeado' })
        .expect(200);

      expect((response.body as ManagedUser).name).toBe('Admin A Renomeado');
    });

    it('ISOLAMENTO: editar usuario do tenant B devolve 404, nao 403', async () => {
      const response = await app.agent
        .patch(`/api/v1/users/${attendantB.id}`)
        .set(app.auth(adminA))
        .send({ role: 'manager', discountLimit: 90 })
        .expect(404);

      expect(response.body.error.code).toBe('NOT_FOUND');

      // E nada mudou do outro lado.
      const untouched = await db.withoutTenant((tx) =>
        tx.query<{ role: string; discount_limit_percent: number }>(
          'SELECT role, discount_limit_percent FROM users WHERE id = $1',
          [attendantB.id],
        ),
      );
      expect(untouched.rows[0]?.role).toBe('attendant');
      expect(untouched.rows[0]?.discount_limit_percent).toBe(15);
    });

    it('id inexistente -> 404', async () => {
      const response = await app.agent
        .patch('/api/v1/users/11111111-1111-4111-8111-111111111111')
        .set(app.auth(adminA))
        .send({ name: 'Fantasma' })
        .expect(404);

      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });
});
