/**
 * GET/POST/PATCH /exam-packages + /:id/prices — CRMLAB-10, API_CONTRACTS.md §4b.
 *
 * O bloco "isolamento multitenant" e bloqueante de release (TESTING.md), mesmo
 * criterio de `exam-routes.spec.ts`.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ExamPackage, ListExamPackagesResponse } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { MemoryCache } from '../../src/lib/cache.js';
import { examPackageModule } from '../../src/controllers/exam-package.routes.js';
import { createAuditService } from '../../src/services/audit.service.js';
import { createInsuranceService } from '../../src/services/insurance.service.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createExam, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

const PACKAGE_KEYS = [
  'id',
  'name',
  'discountPercent',
  'items',
  'pricePrivate',
  'isActive',
  'createdAt',
  'updatedAt',
].sort();

describe('/api/v1/exam-packages', () => {
  let db: DbClient;
  let app: TestApp;
  let cache: MemoryCache;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    cache = new MemoryCache();
    app = await createTestApp({ db, cache, modules: [examPackageModule] });
  });

  describe('GET /exam-packages', () => {
    it('responde no shape exato de ListExamPackagesResponse', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
      const manager = await createUser({ tenantId: tenant.id, role: 'manager' });
      const exam = await createExam({ tenantId: tenant.id, pricePrivate: 100 });

      await app.agent
        .post('/api/v1/exam-packages')
        .set(app.auth(manager))
        .send({ name: 'Check-up', examIds: [exam.id], discountPercent: 10 })
        .expect(201);

      const response = await app.agent
        .get('/api/v1/exam-packages')
        .set(app.auth(user))
        .expect(200);

      const body = response.body as ListExamPackagesResponse;
      expect(Object.keys(body).sort()).toEqual(['packages', 'pagination']);
      const pkg = body.packages[0] as ExamPackage;
      expect(Object.keys(pkg).sort()).toEqual(PACKAGE_KEYS);
      expect(pkg.pricePrivate).toBe(90);
      expect(pkg.isActive).toBe(true);
    });

    it('exige autenticacao', async () => {
      const response = await app.agent.get('/api/v1/exam-packages').expect(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('POST /exam-packages', () => {
    it('gestor cria e recebe 201 com o pacote completo', async () => {
      const tenant = await createTenant();
      const manager = await createUser({ tenantId: tenant.id, role: 'manager' });
      const examA = await createExam({ tenantId: tenant.id, pricePrivate: 100 });
      const examB = await createExam({ tenantId: tenant.id, pricePrivate: 50 });

      const response = await app.agent
        .post('/api/v1/exam-packages')
        .set(app.auth(manager))
        .send({ name: 'Combo Cardio', examIds: [examA.id, examB.id], discountPercent: 10 })
        .expect(201);

      const pkg = response.body as ExamPackage;
      expect(Object.keys(pkg).sort()).toEqual(PACKAGE_KEYS);
      // (100 + 50) * (1 - 10%) = 135
      expect(pkg.pricePrivate).toBe(135);
      expect(pkg.items).toHaveLength(2);
    });

    it('atendente nao cria: FORBIDDEN com details.requiredRoles', async () => {
      const tenant = await createTenant();
      const attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });
      const exam = await createExam({ tenantId: tenant.id });

      const response = await app.agent
        .post('/api/v1/exam-packages')
        .set(app.auth(attendant))
        .send({ name: 'Combo', examIds: [exam.id], discountPercent: 0 })
        .expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
      expect(response.body.error.details.requiredRoles).toEqual(['manager', 'admin']);
    });

    it('examIds vazio -> VALIDATION_ERROR', async () => {
      const tenant = await createTenant();
      const manager = await createUser({ tenantId: tenant.id, role: 'manager' });

      const response = await app.agent
        .post('/api/v1/exam-packages')
        .set(app.auth(manager))
        .send({ name: 'Combo vazio', examIds: [], discountPercent: 0 })
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('examId inativo -> VALIDATION_ERROR', async () => {
      const tenant = await createTenant();
      const manager = await createUser({ tenantId: tenant.id, role: 'manager' });
      const inactive = await createExam({ tenantId: tenant.id, isActive: false });

      const response = await app.agent
        .post('/api/v1/exam-packages')
        .set(app.auth(manager))
        .send({ name: 'Combo inativo', examIds: [inactive.id], discountPercent: 0 })
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('name duplicado no tenant -> CONFLICT', async () => {
      const tenant = await createTenant();
      const manager = await createUser({ tenantId: tenant.id, role: 'manager' });
      const exam = await createExam({ tenantId: tenant.id });

      await app.agent
        .post('/api/v1/exam-packages')
        .set(app.auth(manager))
        .send({ name: 'Combo Dup', examIds: [exam.id], discountPercent: 0 })
        .expect(201);

      const response = await app.agent
        .post('/api/v1/exam-packages')
        .set(app.auth(manager))
        .send({ name: 'Combo Dup', examIds: [exam.id], discountPercent: 0 })
        .expect(409);

      expect(response.body.error.code).toBe('CONFLICT');
    });
  });

  describe('PATCH /exam-packages/:id', () => {
    it('gestor desativa em vez de deletar — a linha continua no banco', async () => {
      const tenant = await createTenant();
      const admin = await createUser({ tenantId: tenant.id, role: 'admin' });
      const exam = await createExam({ tenantId: tenant.id });
      const created = await app.agent
        .post('/api/v1/exam-packages')
        .set(app.auth(admin))
        .send({ name: 'Pacote Z', examIds: [exam.id], discountPercent: 0 })
        .expect(201);
      const packageId = (created.body as ExamPackage).id;

      const response = await app.agent
        .patch(`/api/v1/exam-packages/${packageId}`)
        .set(app.auth(admin))
        .send({ isActive: false })
        .expect(200);

      expect((response.body as ExamPackage).isActive).toBe(false);

      const rows = await db.withTenant(tenant.id, (tx) =>
        tx.query<{ id: string }>('SELECT id FROM exam_packages WHERE id = $1', [packageId]),
      );
      expect(rows.rows).toHaveLength(1);
    });

    it('nao existe DELETE /exam-packages/:id', async () => {
      const tenant = await createTenant();
      const admin = await createUser({ tenantId: tenant.id, role: 'admin' });
      const exam = await createExam({ tenantId: tenant.id });
      const created = await app.agent
        .post('/api/v1/exam-packages')
        .set(app.auth(admin))
        .send({ name: 'Pacote Del', examIds: [exam.id], discountPercent: 0 })
        .expect(201);

      await app.agent
        .delete(`/api/v1/exam-packages/${(created.body as ExamPackage).id}`)
        .set(app.auth(admin))
        .expect(404);
    });

    it('atualiza examIds — substitui o conjunto inteiro', async () => {
      const tenant = await createTenant();
      const manager = await createUser({ tenantId: tenant.id, role: 'manager' });
      const examA = await createExam({ tenantId: tenant.id, pricePrivate: 10 });
      const examB = await createExam({ tenantId: tenant.id, pricePrivate: 20 });
      const created = await app.agent
        .post('/api/v1/exam-packages')
        .set(app.auth(manager))
        .send({ name: 'Troca', examIds: [examA.id], discountPercent: 0 })
        .expect(201);
      const packageId = (created.body as ExamPackage).id;

      const response = await app.agent
        .patch(`/api/v1/exam-packages/${packageId}`)
        .set(app.auth(manager))
        .send({ examIds: [examB.id] })
        .expect(200);

      const pkg = response.body as ExamPackage;
      expect(pkg.items.map((i) => i.examId)).toEqual([examB.id]);
      expect(pkg.pricePrivate).toBe(20);
    });
  });

  // -------------------------------------------------------------------------
  // Isolamento multitenant — BLOQUEANTE (TESTING.md)
  // -------------------------------------------------------------------------
  describe('isolamento multitenant', () => {
    it('GET /exam-packages do tenant A nao traz pacote de B', async () => {
      const tenantA = await createTenant();
      const tenantB = await createTenant();
      const userA = await createUser({ tenantId: tenantA.id, role: 'attendant' });
      const managerA = await createUser({ tenantId: tenantA.id, role: 'manager' });
      const managerB = await createUser({ tenantId: tenantB.id, role: 'manager' });
      const examA = await createExam({ tenantId: tenantA.id });
      const examB = await createExam({ tenantId: tenantB.id });

      await app.agent
        .post('/api/v1/exam-packages')
        .set(app.auth(managerA))
        .send({ name: 'Pacote de A', examIds: [examA.id], discountPercent: 0 })
        .expect(201);
      await app.agent
        .post('/api/v1/exam-packages')
        .set(app.auth(managerB))
        .send({ name: 'Pacote de B', examIds: [examB.id], discountPercent: 0 })
        .expect(201);

      const response = await app.agent
        .get('/api/v1/exam-packages')
        .set(app.auth(userA))
        .expect(200);
      const body = response.body as ListExamPackagesResponse;

      expect(body.packages.map((p) => p.name)).toEqual(['Pacote de A']);
      expect(body.pagination.total).toBe(1);
    });

    it('PATCH em pacote de outro tenant -> 404, NUNCA 403', async () => {
      const tenantA = await createTenant();
      const tenantB = await createTenant();
      const adminA = await createUser({ tenantId: tenantA.id, role: 'admin' });
      const managerB = await createUser({ tenantId: tenantB.id, role: 'manager' });
      const examB = await createExam({ tenantId: tenantB.id });
      const createdB = await app.agent
        .post('/api/v1/exam-packages')
        .set(app.auth(managerB))
        .send({ name: 'Pacote de B', examIds: [examB.id], discountPercent: 0 })
        .expect(201);

      const response = await app.agent
        .patch(`/api/v1/exam-packages/${(createdB.body as ExamPackage).id}`)
        .set(app.auth(adminA))
        .send({ isActive: false })
        .expect(404);

      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  // Preco por convenio — GET/PUT /exam-packages/:id/prices
  // -------------------------------------------------------------------------
  describe('GET /exam-packages?insuranceId= e /exam-packages/:id/prices', () => {
    async function createInsurance(tenantId: string, name: string): Promise<{ id: string }> {
      const audit = createAuditService(db);
      const service = createInsuranceService({ db, audit });
      return service.create(
        {
          userId: (await createUser({ tenantId, role: 'admin' })).id,
          tenantId,
          role: 'admin',
          discountLimit: 100,
          ip: '127.0.0.1',
          userAgent: 'vitest',
        },
        { name, type: 'cooperativa' },
      );
    }

    it('?insuranceId= acrescenta effectivePrice/priceSource — fallback nunca bloqueia', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
      const manager = await createUser({ tenantId: tenant.id, role: 'manager' });
      const exam = await createExam({ tenantId: tenant.id, pricePrivate: 100 });
      const insurance = await createInsurance(tenant.id, 'Unimed Tubarão');

      const created = await app.agent
        .post('/api/v1/exam-packages')
        .set(app.auth(manager))
        .send({ name: 'Pacote Convenio', examIds: [exam.id], discountPercent: 20 })
        .expect(201);
      const packageId = (created.body as ExamPackage).id;

      const response = await app.agent
        .get(`/api/v1/exam-packages?insuranceId=${insurance.id}`)
        .set(app.auth(user))
        .expect(200);

      const body = response.body as ListExamPackagesResponse;
      const found = body.packages.find((p) => p.id === packageId);
      // Sem override cadastrado: cai no particular calculado (100 * 80%).
      expect(found?.effectivePrice).toBe(80);
      expect(found?.priceSource).toBe('private');

      await app.agent
        .put(`/api/v1/exam-packages/${packageId}/prices`)
        .set(app.auth(manager))
        .send({ prices: [{ insuranceId: insurance.id, price: 60 }] })
        .expect(200);

      const afterOverride = await app.agent
        .get(`/api/v1/exam-packages?insuranceId=${insurance.id}`)
        .set(app.auth(user))
        .expect(200);
      const foundAfter = (afterOverride.body as ListExamPackagesResponse).packages.find(
        (p) => p.id === packageId,
      );
      expect(foundAfter?.effectivePrice).toBe(60);
      expect(foundAfter?.priceSource).toBe('insurance');
    });

    it('PUT /exam-packages/:id/prices exige manager/admin', async () => {
      const tenant = await createTenant();
      const attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });
      const admin = await createUser({ tenantId: tenant.id, role: 'admin' });
      const exam = await createExam({ tenantId: tenant.id });
      const created = await app.agent
        .post('/api/v1/exam-packages')
        .set(app.auth(admin))
        .send({ name: 'Pacote FORBIDDEN', examIds: [exam.id], discountPercent: 0 })
        .expect(201);

      const response = await app.agent
        .put(`/api/v1/exam-packages/${(created.body as ExamPackage).id}/prices`)
        .set(app.auth(attendant))
        .send({ prices: [] })
        .expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });
});
