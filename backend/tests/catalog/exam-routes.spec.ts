/**
 * GET/POST/PATCH /exams — contrato de API_CONTRACTS.md §4 + API_ERRORS.md.
 *
 * O bloco "isolamento multitenant" e bloqueante de release (TESTING.md).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Exam, ListExamsResponse } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { MemoryCache } from '../../src/lib/cache.js';
import { examModule } from '../../src/controllers/exam.routes.js';
import { createAuditService } from '../../src/services/audit.service.js';
import { createInsuranceService } from '../../src/services/insurance.service.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createExam, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

/**
 * Chaves EXATAS de `Exam` em `@crm-lab/shared` — o contrato do fio. Sem
 * `?insuranceId=` na query, `effectivePrice`/`priceSource` NAO aparecem
 * (sao aditivos — ver EXAM_KEYS_WITH_PRICE abaixo).
 */
const EXAM_KEYS = [
  'id',
  'name',
  'code',
  'description',
  'preparation',
  'turnaroundHours',
  'pricePrivate',
  'priceInsurance',
  'category',
  'isActive',
  'tussCode',
  'ambCode',
  'material',
  'source',
  'synonyms',
  'createdAt',
  'updatedAt',
].sort();

const EXAM_KEYS_WITH_PRICE = [...EXAM_KEYS, 'effectivePrice', 'priceSource'].sort();

describe('/api/v1/exams', () => {
  let db: DbClient;
  let app: TestApp;
  let cache: MemoryCache;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    cache = new MemoryCache();
    app = await createTestApp({ db, cache, modules: [examModule] });
  });

  // -------------------------------------------------------------------------
  // GET /exams — shape
  // -------------------------------------------------------------------------
  describe('GET /exams', () => {
    it('responde no shape exato de ListExamsResponse', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
      await createExam({
        tenantId: tenant.id,
        name: 'Hemograma Completo',
        code: 'HC',
        pricePrivate: 89.9,
        priceInsurance: 75,
      });

      const response = await app.agent
        .get('/api/v1/exams')
        .set(app.auth(user))
        .expect(200);

      const body = response.body as ListExamsResponse;
      expect(Object.keys(body).sort()).toEqual(['exams', 'pagination']);
      expect(body.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });

      const exam = body.exams[0] as Exam;
      expect(Object.keys(exam).sort()).toEqual(EXAM_KEYS);
      expect(exam.name).toBe('Hemograma Completo');
      expect(exam.isActive).toBe(true);
    });

    it('dinheiro vai no fio como numero decimal, nunca string formatada', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
      await createExam({ tenantId: tenant.id, pricePrivate: 179.8, priceInsurance: 120.5 });

      const response = await app.agent.get('/api/v1/exams').set(app.auth(user)).expect(200);
      const exam = (response.body as ListExamsResponse).exams[0] as Exam;

      expect(typeof exam.pricePrivate).toBe('number');
      expect(exam.pricePrivate).toBe(179.8);
      expect(exam.priceInsurance).toBe(120.5);
    });

    it('exige autenticacao', async () => {
      const response = await app.agent.get('/api/v1/exams').expect(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
    });

    it('filtra por ?active=true e por ?category=', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
      await createExam({ tenantId: tenant.id, name: 'Ativo', category: 'Hematologia' });
      await createExam({ tenantId: tenant.id, name: 'Inativo', isActive: false });
      await createExam({ tenantId: tenant.id, name: 'Outra area', category: 'Bioquimica' });

      const active = await app.agent
        .get('/api/v1/exams?active=true')
        .set(app.auth(user))
        .expect(200);
      expect((active.body as ListExamsResponse).exams.map((e) => e.name).sort()).toEqual([
        'Ativo',
        'Outra area',
      ]);

      const byCategory = await app.agent
        .get('/api/v1/exams?category=Hematologia')
        .set(app.auth(user))
        .expect(200);
      expect((byCategory.body as ListExamsResponse).exams).toHaveLength(1);
      expect((byCategory.body as ListExamsResponse).exams[0]?.name).toBe('Ativo');
    });

    it('pagina com page/limit e reporta totalPages', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
      for (let i = 0; i < 5; i += 1) {
        await createExam({ tenantId: tenant.id, name: `Exame ${i}`, code: `P${i}` });
      }

      const response = await app.agent
        .get('/api/v1/exams?page=2&limit=2')
        .set(app.auth(user))
        .expect(200);

      const body = response.body as ListExamsResponse;
      expect(body.exams).toHaveLength(2);
      expect(body.pagination).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
    });
  });

  // -------------------------------------------------------------------------
  // Busca
  // -------------------------------------------------------------------------
  describe('GET /exams?search=', () => {
    it('acha por nome e por codigo, sem sensibilidade a caixa', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
      await createExam({ tenantId: tenant.id, name: 'Glicose de jejum', code: 'GLI' });
      await createExam({ tenantId: tenant.id, name: 'Hemograma', code: 'HC' });

      const byName = await app.agent
        .get('/api/v1/exams?search=GLICOSE')
        .set(app.auth(user))
        .expect(200);
      expect((byName.body as ListExamsResponse).exams.map((e) => e.code)).toEqual(['GLI']);

      const byCode = await app.agent
        .get('/api/v1/exams?search=hc')
        .set(app.auth(user))
        .expect(200);
      expect((byCode.body as ListExamsResponse).exams.map((e) => e.code)).toEqual(['HC']);
    });

    it('ignora acento — o catalogo e em portugues', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
      await createExam({ tenantId: tenant.id, name: 'Ácido Úrico', code: 'AU' });

      const semAcento = await app.agent
        .get('/api/v1/exams?search=acido urico')
        .set(app.auth(user))
        .expect(200);
      expect((semAcento.body as ListExamsResponse).exams).toHaveLength(1);

      const comAcento = await app.agent
        .get('/api/v1/exams?search=ÁCIDO')
        .set(app.auth(user))
        .expect(200);
      expect((comAcento.body as ListExamsResponse).exams).toHaveLength(1);
    });

    it('trata `%` digitado como texto, nao como curinga de LIKE', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
      await createExam({ tenantId: tenant.id, name: 'Hemograma', code: 'HC' });

      const response = await app.agent
        .get('/api/v1/exams?search=%25')
        .set(app.auth(user))
        .expect(200);
      expect((response.body as ListExamsResponse).exams).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // POST /exams
  // -------------------------------------------------------------------------
  describe('POST /exams', () => {
    const payload = {
      name: 'Novo Exame',
      code: 'NE',
      description: 'Descricao',
      preparation: 'Jejum de 8 horas',
      turnaroundHours: 24,
      pricePrivate: 100,
      priceInsurance: 80,
      category: 'hemograma',
    };

    it('gestor cria e recebe 201 com o exame completo', async () => {
      const tenant = await createTenant();
      const manager = await createUser({ tenantId: tenant.id, role: 'manager' });

      const response = await app.agent
        .post('/api/v1/exams')
        .set(app.auth(manager))
        .send(payload)
        .expect(201);

      const exam = response.body as Exam;
      expect(Object.keys(exam).sort()).toEqual(EXAM_KEYS);
      expect(exam.code).toBe('NE');
      expect(exam.pricePrivate).toBe(100);
      expect(exam.isActive).toBe(true);
    });

    it('atendente nao cria: FORBIDDEN com details.requiredRoles', async () => {
      const tenant = await createTenant();
      const attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });

      const response = await app.agent
        .post('/api/v1/exams')
        .set(app.auth(attendant))
        .send(payload)
        .expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
      expect(response.body.error.details.requiredRoles).toEqual(['manager', 'admin']);
    });

    it('code duplicado no mesmo tenant -> CONFLICT (409), nao 500', async () => {
      const tenant = await createTenant();
      const admin = await createUser({ tenantId: tenant.id, role: 'admin' });
      await createExam({ tenantId: tenant.id, code: 'DUP' });

      const response = await app.agent
        .post('/api/v1/exams')
        .set(app.auth(admin))
        .send({ ...payload, code: 'DUP' })
        .expect(409);

      expect(response.body.error.code).toBe('CONFLICT');
      expect(response.body.error.statusCode).toBe(409);
    });

    it('o MESMO code em tenants diferentes e permitido', async () => {
      const tenantA = await createTenant();
      const tenantB = await createTenant();
      const adminA = await createUser({ tenantId: tenantA.id, role: 'admin' });
      const adminB = await createUser({ tenantId: tenantB.id, role: 'admin' });

      await app.agent
        .post('/api/v1/exams')
        .set(app.auth(adminA))
        .send({ ...payload, code: 'HC' })
        .expect(201);

      await app.agent
        .post('/api/v1/exams')
        .set(app.auth(adminB))
        .send({ ...payload, code: 'HC' })
        .expect(201);
    });

    it('DTO invalido -> VALIDATION_ERROR com details.fields', async () => {
      const tenant = await createTenant();
      const admin = await createUser({ tenantId: tenant.id, role: 'admin' });

      const response = await app.agent
        .post('/api/v1/exams')
        .set(app.auth(admin))
        .send({ ...payload, pricePrivate: 'R$ 100,00' })
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details.fields).toHaveProperty('pricePrivate');
    });

    it('aceita tussCode/ambCode/material/synonyms e devolve source manual (Onda 7)', async () => {
      const tenant = await createTenant();
      const manager = await createUser({ tenantId: tenant.id, role: 'manager' });

      const response = await app.agent
        .post('/api/v1/exams')
        .set(app.auth(manager))
        .send({
          ...payload,
          code: 'TUSS1',
          tussCode: '40304361',
          ambCode: null,
          material: 'Sangue — tubo tampa roxa (EDTA)',
          synonyms: ['sinônimo 1', 'sinônimo 2'],
        })
        .expect(201);

      const exam = response.body as Exam;
      expect(Object.keys(exam).sort()).toEqual(EXAM_KEYS);
      expect(exam.tussCode).toBe('40304361');
      expect(exam.ambCode).toBeNull();
      expect(exam.material).toBe('Sangue — tubo tampa roxa (EDTA)');
      expect(exam.source).toBe('manual');
      expect(exam.synonyms.sort()).toEqual(['sinônimo 1', 'sinônimo 2'].sort());
    });

    it('tussCode/ambCode/material/synonyms omitidos -> null/[] (nunca inventado, D-081)', async () => {
      const tenant = await createTenant();
      const manager = await createUser({ tenantId: tenant.id, role: 'manager' });

      const response = await app.agent
        .post('/api/v1/exams')
        .set(app.auth(manager))
        .send({ ...payload, code: 'SEMCOD' })
        .expect(201);

      const exam = response.body as Exam;
      expect(exam.tussCode).toBeNull();
      expect(exam.ambCode).toBeNull();
      expect(exam.material).toBeNull();
      expect(exam.synonyms).toEqual([]);
    });

    it('tussCode/ambCode/material vazio (string) vira null, nunca VALIDATION_ERROR', async () => {
      // Formulario HTML manda '' para campo esvaziado (Task 7 constroi essa
      // tela em cima deste contrato) — '' e "nao informado" sao a mesma coisa.
      const tenant = await createTenant();
      const manager = await createUser({ tenantId: tenant.id, role: 'manager' });

      const response = await app.agent
        .post('/api/v1/exams')
        .set(app.auth(manager))
        .send({ ...payload, code: 'VAZIO1', tussCode: '', ambCode: '', material: '' })
        .expect(201);

      const exam = response.body as Exam;
      expect(exam.tussCode).toBeNull();
      expect(exam.ambCode).toBeNull();
      expect(exam.material).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /exams/:id
  // -------------------------------------------------------------------------
  describe('PATCH /exams/:id', () => {
    it('gestor atualiza preco e recebe o exame novo', async () => {
      const tenant = await createTenant();
      const manager = await createUser({ tenantId: tenant.id, role: 'manager' });
      const exam = await createExam({ tenantId: tenant.id, pricePrivate: 100 });

      const response = await app.agent
        .patch(`/api/v1/exams/${exam.id}`)
        .set(app.auth(manager))
        .send({ pricePrivate: 110, priceInsurance: 90 })
        .expect(200);

      expect((response.body as Exam).pricePrivate).toBe(110);
      expect((response.body as Exam).priceInsurance).toBe(90);
    });

    it('atendente nao edita: FORBIDDEN com details.requiredRoles', async () => {
      const tenant = await createTenant();
      const attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });
      const exam = await createExam({ tenantId: tenant.id });

      const response = await app.agent
        .patch(`/api/v1/exams/${exam.id}`)
        .set(app.auth(attendant))
        .send({ pricePrivate: 1 })
        .expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
      expect(response.body.error.details.requiredRoles).toEqual(['manager', 'admin']);
    });

    it('desativa em vez de deletar — a linha continua no banco', async () => {
      const tenant = await createTenant();
      const admin = await createUser({ tenantId: tenant.id, role: 'admin' });
      const exam = await createExam({ tenantId: tenant.id });

      const response = await app.agent
        .patch(`/api/v1/exams/${exam.id}`)
        .set(app.auth(admin))
        .send({ isActive: false })
        .expect(200);

      expect((response.body as Exam).isActive).toBe(false);

      const rows = await db.withTenant(tenant.id, (tx) =>
        tx.query<{ id: string }>('SELECT id FROM exam_catalog WHERE id = $1', [exam.id]),
      );
      expect(rows.rows).toHaveLength(1);
    });

    it('synonyms no PATCH substitui o conjunto inteiro; omitido preserva', async () => {
      const tenant = await createTenant();
      const manager = await createUser({ tenantId: tenant.id, role: 'manager' });
      const created = await app.agent
        .post('/api/v1/exams')
        .set(app.auth(manager))
        .send({
          name: 'Colesterol HDL',
          code: 'HDL001',
          pricePrivate: 20,
          priceInsurance: 15,
          synonyms: ['hdl', 'bom colesterol'],
        })
        .expect(201);
      const examId = (created.body as Exam).id;

      const patched = await app.agent
        .patch(`/api/v1/exams/${examId}`)
        .set(app.auth(manager))
        .send({ synonyms: ['colesterol bom'] })
        .expect(200);
      expect((patched.body as Exam).synonyms).toEqual(['colesterol bom']);

      const preserved = await app.agent
        .patch(`/api/v1/exams/${examId}`)
        .set(app.auth(manager))
        .send({ pricePrivate: 22 })
        .expect(200);
      expect((preserved.body as Exam).synonyms).toEqual(['colesterol bom']);
    });

    it('PATCH com tussCode vazio grava null e devolve 200 (limpar campo pela tela)', async () => {
      const tenant = await createTenant();
      const manager = await createUser({ tenantId: tenant.id, role: 'manager' });
      const created = await app.agent
        .post('/api/v1/exams')
        .set(app.auth(manager))
        .send({
          name: 'Hemograma',
          code: 'HEMTUSS1',
          pricePrivate: 40,
          priceInsurance: 30,
          tussCode: '40304361',
        })
        .expect(201);
      const examId = (created.body as Exam).id;
      expect((created.body as Exam).tussCode).toBe('40304361');

      const response = await app.agent
        .patch(`/api/v1/exams/${examId}`)
        .set(app.auth(manager))
        .send({ tussCode: '' })
        .expect(200);

      expect((response.body as Exam).tussCode).toBeNull();
    });

    it('nao existe DELETE /exams/:id', async () => {
      const tenant = await createTenant();
      const admin = await createUser({ tenantId: tenant.id, role: 'admin' });
      const exam = await createExam({ tenantId: tenant.id });

      await app.agent.delete(`/api/v1/exams/${exam.id}`).set(app.auth(admin)).expect(404);
    });

    it('id inexistente -> NOT_FOUND', async () => {
      const tenant = await createTenant();
      const admin = await createUser({ tenantId: tenant.id, role: 'admin' });

      const response = await app.agent
        .patch('/api/v1/exams/11111111-1111-4111-8111-111111111111')
        .set(app.auth(admin))
        .send({ pricePrivate: 1 })
        .expect(404);

      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  // Isolamento multitenant — BLOQUEANTE (TESTING.md)
  // -------------------------------------------------------------------------
  describe('isolamento multitenant', () => {
    it('GET /exams do tenant A nao traz exame de B', async () => {
      const tenantA = await createTenant();
      const tenantB = await createTenant();
      const userA = await createUser({ tenantId: tenantA.id, role: 'attendant' });
      await createExam({ tenantId: tenantA.id, name: 'Exame de A', code: 'A1' });
      await createExam({ tenantId: tenantB.id, name: 'Exame de B', code: 'B1' });

      const response = await app.agent.get('/api/v1/exams').set(app.auth(userA)).expect(200);
      const body = response.body as ListExamsResponse;

      expect(body.exams.map((e) => e.name)).toEqual(['Exame de A']);
      expect(body.pagination.total).toBe(1);
    });

    it('PATCH em exame de outro tenant -> 404, NUNCA 403', async () => {
      const tenantA = await createTenant();
      const tenantB = await createTenant();
      const adminA = await createUser({ tenantId: tenantA.id, role: 'admin' });
      const examB = await createExam({ tenantId: tenantB.id, pricePrivate: 100 });

      const response = await app.agent
        .patch(`/api/v1/exams/${examB.id}`)
        .set(app.auth(adminA))
        .send({ pricePrivate: 1 })
        .expect(404);

      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(response.body.error.code).not.toBe('FORBIDDEN');

      // E o exame de B continua intacto.
      const rows = await db.withTenant(tenantB.id, (tx) =>
        tx.query<{ price_private: number }>(
          'SELECT price_private FROM exam_catalog WHERE id = $1',
          [examB.id],
        ),
      );
      expect(Number(rows.rows[0]?.price_private)).toBe(100);
    });

    it('cache do tenant A nao serve requisicao do tenant B', async () => {
      const tenantA = await createTenant();
      const tenantB = await createTenant();
      const userA = await createUser({ tenantId: tenantA.id, role: 'attendant' });
      const userB = await createUser({ tenantId: tenantB.id, role: 'attendant' });
      await createExam({ tenantId: tenantA.id, name: 'Exame de A', code: 'A1' });
      await createExam({ tenantId: tenantB.id, name: 'Exame de B', code: 'B1' });

      // A primeiro: popula o cache com a MESMA combinacao de filtros.
      const first = await app.agent.get('/api/v1/exams').set(app.auth(userA)).expect(200);
      expect((first.body as ListExamsResponse).exams.map((e) => e.name)).toEqual(['Exame de A']);

      const second = await app.agent.get('/api/v1/exams').set(app.auth(userB)).expect(200);
      expect((second.body as ListExamsResponse).exams.map((e) => e.name)).toEqual(['Exame de B']);
    });

    it('invalidar o cache de A nao derruba o cache de B', async () => {
      const tenantA = await createTenant();
      const tenantB = await createTenant();
      const adminA = await createUser({ tenantId: tenantA.id, role: 'admin' });
      const userB = await createUser({ tenantId: tenantB.id, role: 'attendant' });
      await createExam({ tenantId: tenantA.id, name: 'Exame de A', code: 'A1' });
      const examB = await createExam({ tenantId: tenantB.id, name: 'Exame de B', code: 'B1' });

      // Ambos populam a propria entrada de cache.
      await app.agent.get('/api/v1/exams').set(app.auth(adminA)).expect(200);
      await app.agent.get('/api/v1/exams').set(app.auth(userB)).expect(200);

      // Escrita crua no banco de B, SEM passar pelo service: se a entrada de B
      // sobreviver, a leitura seguinte ainda mostra o nome antigo.
      await db.withTenant(tenantB.id, (tx) =>
        tx.query('UPDATE exam_catalog SET name = $1 WHERE id = $2', ['Renomeado', examB.id]),
      );

      // A escreve -> invalida SOMENTE o prefixo de A.
      await app.agent
        .post('/api/v1/exams')
        .set(app.auth(adminA))
        .send({ name: 'Outro', code: 'A2', pricePrivate: 10, priceInsurance: 5 })
        .expect(201);

      const afterB = await app.agent.get('/api/v1/exams').set(app.auth(userB)).expect(200);
      expect((afterB.body as ListExamsResponse).exams.map((e) => e.name)).toEqual(['Exame de B']);

      // E a de A realmente caiu: o exame recem-criado aparece.
      const afterA = await app.agent.get('/api/v1/exams').set(app.auth(adminA)).expect(200);
      expect((afterA.body as ListExamsResponse).exams.map((e) => e.name).sort()).toEqual([
        'Exame de A',
        'Outro',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Cache: o bug classico
  // -------------------------------------------------------------------------
  describe('cache de listagem', () => {
    it('update de preco invalida o cache — a leitura seguinte traz o valor novo', async () => {
      const tenant = await createTenant();
      const admin = await createUser({ tenantId: tenant.id, role: 'admin' });
      const exam = await createExam({ tenantId: tenant.id, pricePrivate: 100 });

      const before = await app.agent.get('/api/v1/exams').set(app.auth(admin)).expect(200);
      expect((before.body as ListExamsResponse).exams[0]?.pricePrivate).toBe(100);

      await app.agent
        .patch(`/api/v1/exams/${exam.id}`)
        .set(app.auth(admin))
        .send({ pricePrivate: 210.55 })
        .expect(200);

      const after = await app.agent.get('/api/v1/exams').set(app.auth(admin)).expect(200);
      expect((after.body as ListExamsResponse).exams[0]?.pricePrivate).toBe(210.55);
    });

    it('create invalida o cache — o exame novo aparece na listagem seguinte', async () => {
      const tenant = await createTenant();
      const admin = await createUser({ tenantId: tenant.id, role: 'admin' });

      const before = await app.agent.get('/api/v1/exams').set(app.auth(admin)).expect(200);
      expect((before.body as ListExamsResponse).exams).toHaveLength(0);

      await app.agent
        .post('/api/v1/exams')
        .set(app.auth(admin))
        .send({ name: 'Recem criado', code: 'RC', pricePrivate: 10, priceInsurance: 5 })
        .expect(201);

      const after = await app.agent.get('/api/v1/exams').set(app.auth(admin)).expect(200);
      expect((after.body as ListExamsResponse).exams.map((e) => e.name)).toEqual(['Recem criado']);
    });
  });

  // -------------------------------------------------------------------------
  // Preco por convenio — GET/PUT /exams/:id/prices (Onda 7)
  // -------------------------------------------------------------------------
  describe('GET /exams?insuranceId= e /exams/:id/prices', () => {
    async function createInsurance(tenantId: string, name: string): Promise<{ id: string }> {
      const audit = createAuditService(db);
      const service = createInsuranceService({ db, audit });
      return service.create(
        { userId: (await createUser({ tenantId, role: 'admin' })).id, tenantId, role: 'admin', discountLimit: 100, ip: '127.0.0.1', userAgent: 'vitest' },
        { name, type: 'cooperativa' },
      );
    }

    it('?insuranceId= acrescenta effectivePrice/priceSource a cada exame', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
      const manager = await createUser({ tenantId: tenant.id, role: 'manager' });
      const exam = await createExam({ tenantId: tenant.id, name: 'Hemograma', pricePrivate: 40 });
      const insurance = await createInsurance(tenant.id, 'Unimed Tubarão');

      await app.agent
        .put(`/api/v1/exams/${exam.id}/prices`)
        .set(app.auth(manager))
        .send({ prices: [{ insuranceId: insurance.id, price: 28 }] })
        .expect(200);

      const response = await app.agent
        .get(`/api/v1/exams?insuranceId=${insurance.id}`)
        .set(app.auth(user))
        .expect(200);

      const body = response.body as ListExamsResponse;
      expect(Object.keys(body.exams[0] as Exam).sort()).toEqual(EXAM_KEYS_WITH_PRICE);
      const found = body.exams.find((e) => e.id === exam.id);
      expect(found?.effectivePrice).toBe(28);
      expect(found?.priceSource).toBe('insurance');
    });

    it('GET /exams/:id/prices devolve so os convenios com preco cadastrado', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
      const manager = await createUser({ tenantId: tenant.id, role: 'manager' });
      const exam = await createExam({ tenantId: tenant.id });
      const insurance = await createInsurance(tenant.id, 'Bradesco Saúde');

      await app.agent
        .put(`/api/v1/exams/${exam.id}/prices`)
        .set(app.auth(manager))
        .send({ prices: [{ insuranceId: insurance.id, price: 33.5 }] })
        .expect(200);

      const response = await app.agent
        .get(`/api/v1/exams/${exam.id}/prices`)
        .set(app.auth(user))
        .expect(200);

      expect(response.body).toEqual({ prices: [{ insuranceId: insurance.id, price: 33.5 }] });
    });

    it('PUT /exams/:id/prices exige manager/admin — atendente recebe FORBIDDEN', async () => {
      const tenant = await createTenant();
      const attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });
      const exam = await createExam({ tenantId: tenant.id });

      const response = await app.agent
        .put(`/api/v1/exams/${exam.id}/prices`)
        .set(app.auth(attendant))
        .send({ prices: [] })
        .expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('PUT /exams/:id/prices de exame de outro tenant -> NOT_FOUND', async () => {
      const tenantA = await createTenant();
      const tenantB = await createTenant();
      const managerA = await createUser({ tenantId: tenantA.id, role: 'manager' });
      const examB = await createExam({ tenantId: tenantB.id });
      const insuranceA = await createInsurance(tenantA.id, 'Amil');

      const response = await app.agent
        .put(`/api/v1/exams/${examB.id}/prices`)
        .set(app.auth(managerA))
        .send({ prices: [{ insuranceId: insuranceA.id, price: 10 }] })
        .expect(404);

      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('PUT /exams/:id/prices com insuranceId inexistente -> VALIDATION_ERROR', async () => {
      const tenant = await createTenant();
      const manager = await createUser({ tenantId: tenant.id, role: 'manager' });
      const exam = await createExam({ tenantId: tenant.id });

      const response = await app.agent
        .put(`/api/v1/exams/${exam.id}/prices`)
        .set(app.auth(manager))
        .send({ prices: [{ insuranceId: '11111111-1111-4111-8111-111111111111', price: 10 }] })
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(Object.keys(response.body.error.details.fields)[0]).toMatch(/^prices\./);
    });

    it('PUT substitui o conjunto — a linha ausente do corpo some do GET seguinte', async () => {
      const tenant = await createTenant();
      const manager = await createUser({ tenantId: tenant.id, role: 'manager' });
      const exam = await createExam({ tenantId: tenant.id });
      const insA = await createInsurance(tenant.id, 'Amil');
      const insB = await createInsurance(tenant.id, 'SulAmérica');

      await app.agent
        .put(`/api/v1/exams/${exam.id}/prices`)
        .set(app.auth(manager))
        .send({
          prices: [
            { insuranceId: insA.id, price: 10 },
            { insuranceId: insB.id, price: 20 },
          ],
        })
        .expect(200);

      const response = await app.agent
        .put(`/api/v1/exams/${exam.id}/prices`)
        .set(app.auth(manager))
        .send({ prices: [{ insuranceId: insA.id, price: 10 }] })
        .expect(200);

      expect(response.body).toEqual({ prices: [{ insuranceId: insA.id, price: 10 }] });
    });
  });
});
