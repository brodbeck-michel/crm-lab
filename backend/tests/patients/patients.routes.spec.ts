/**
 * `/api/v1/patients` — listagem, ficha e PATCH (API_CONTRACTS.md §2c).
 *
 * O que estes testes provam, e por que cada um existe:
 *   - isolamento entre laboratorios em TODAS as rotas (paciente do tenant B
 *     responde 404 em GET, PATCH, export e anonymize);
 *   - o recorte por papel de D-060: o atendente so enxerga paciente com ao
 *     menos uma conversa dele ou na fila, e os CONTADORES da ficha usam o mesmo
 *     recorte — gestor e atendente veem numeros diferentes do mesmo paciente;
 *   - `phone` recusado no PATCH (D-061) e cadastro anonimizado -> 409.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { patientModule } from '../../src/controllers/patient.routes.js';
import type { DbClient } from '../../src/db/types.js';
import {
  createConversation,
  createExam,
  createProposal,
  createTenant,
  createUser,
  type TenantRecord,
  type UserRecord,
} from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createPatient, linkConversation, readAuditLogs } from './helpers.js';

const BASE = '/api/v1/patients';

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let adminA: UserRecord;
let managerA: UserRecord;
let attendantA: UserRecord;
let otherAttendantA: UserRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [patientModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  adminA = await createUser({ tenantId: tenantA.id, role: 'admin', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', db });
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', name: 'Ana', db });
  otherAttendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', name: 'Bia', db });
});

describe('guardas de acesso', () => {
  it('sem token: 401 em todas as rotas', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    await app.agent.get(BASE).expect(401);
    await app.agent.get(`${BASE}/${id}`).expect(401);
    await app.agent.patch(`${BASE}/${id}`).send({ name: 'X' }).expect(401);
    await app.agent.get(`${BASE}/${id}/timeline`).expect(401);
    await app.agent.get(`${BASE}/${id}/export`).expect(401);
    await app.agent.post(`${BASE}/${id}/anonymize`).send({ reason: 'x' }).expect(401);
  });

  /**
   * PAGES.md §11: o console da plataforma nao tem caminho para dado de
   * paciente. A assercao olha `details.requiredRoles` — os papeis de
   * LABORATORIO provam que quem recusou foi `denyPlatformOperator()`, nao uma
   * checagem de papel que alguem pode afrouxar amanha.
   */
  it('platform_operator recebe 403 em todas as rotas', async () => {
    const plataforma = await createTenant({ name: 'Plataforma', slug: 'plataforma', db });
    const operator = await createUser({
      tenantId: plataforma.id,
      role: 'platform_operator',
      db,
    });
    const headers = app.auth(operator);
    const patient = await createPatient({ tenantId: tenantA.id, db });

    const responses = [
      await app.agent.get(BASE).set(headers),
      await app.agent.get(`${BASE}/${patient.id}`).set(headers),
      await app.agent.patch(`${BASE}/${patient.id}`).set(headers).send({ name: 'X' }),
      await app.agent.get(`${BASE}/${patient.id}/timeline`).set(headers),
      await app.agent.get(`${BASE}/${patient.id}/export`).set(headers),
      await app.agent
        .post(`${BASE}/${patient.id}/anonymize`)
        .set(headers)
        .send({ reason: 'pedido do titular' }),
    ];

    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.details.requiredRoles).toEqual(['attendant', 'manager', 'admin']);
    }
  });
});

describe('isolamento multitenant', () => {
  it('paciente do tenant B nao aparece na listagem do tenant A', async () => {
    await createPatient({ tenantId: tenantB.id, name: 'Paciente do B', db });
    await createPatient({ tenantId: tenantA.id, name: 'Paciente do A', db });

    const res = await app.agent.get(BASE).set(app.auth(adminA)).expect(200);
    expect(res.body.patients).toHaveLength(1);
    expect(res.body.patients[0].name).toBe('Paciente do A');
    expect(res.body.pagination.total).toBe(1);
  });

  it('paciente de outro tenant responde 404 (nunca 403) em TODAS as rotas', async () => {
    const alheio = await createPatient({ tenantId: tenantB.id, db });
    const headers = app.auth(adminA);

    const responses = [
      await app.agent.get(`${BASE}/${alheio.id}`).set(headers),
      await app.agent.patch(`${BASE}/${alheio.id}`).set(headers).send({ name: 'Invasao' }),
      await app.agent.get(`${BASE}/${alheio.id}/timeline`).set(headers),
      await app.agent.get(`${BASE}/${alheio.id}/export`).set(headers),
      await app.agent
        .post(`${BASE}/${alheio.id}/anonymize`)
        .set(headers)
        .send({ reason: 'pedido do titular' }),
    ];

    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
  });

  it('PATCH cross-tenant nao escreve na linha do outro laboratorio', async () => {
    const alheio = await createPatient({ tenantId: tenantB.id, name: 'Intocado', db });
    await app.agent
      .patch(`${BASE}/${alheio.id}`)
      .set(app.auth(adminA))
      .send({ name: 'Sobrescrito' })
      .expect(404);

    const row = await db.withTenant(tenantB.id, (tx) =>
      tx.query<{ name: string }>('SELECT name FROM patients WHERE id = $1', [alheio.id]),
    );
    expect(row.rows[0]?.name).toBe('Intocado');
  });
});

describe('recorte por papel na listagem e na ficha (D-060)', () => {
  it('atendente so ve paciente com conversa dele ou na fila; gestor ve todos', async () => {
    const meu = await createPatient({ tenantId: tenantA.id, name: 'Meu', db });
    const naFila = await createPatient({ tenantId: tenantA.id, name: 'Na fila', db });
    const doOutro = await createPatient({ tenantId: tenantA.id, name: 'Do outro', db });
    const semConversa = await createPatient({ tenantId: tenantA.id, name: 'Sem conversa', db });

    const c1 = await createConversation({ tenantId: tenantA.id, assignedTo: attendantA.id, db });
    const c2 = await createConversation({ tenantId: tenantA.id, assignedTo: null, db });
    const c3 = await createConversation({
      tenantId: tenantA.id,
      assignedTo: otherAttendantA.id,
      db,
    });
    await linkConversation(c1.id, meu.id, { db });
    await linkConversation(c2.id, naFila.id, { db });
    await linkConversation(c3.id, doOutro.id, { db });

    const doAtendente = await app.agent.get(BASE).set(app.auth(attendantA)).expect(200);
    const nomes = doAtendente.body.patients.map((p: { name: string }) => p.name).sort();
    expect(nomes).toEqual(['Meu', 'Na fila']);
    expect(doAtendente.body.pagination.total).toBe(2);

    const doGestor = await app.agent.get(BASE).set(app.auth(managerA)).expect(200);
    expect(doGestor.body.pagination.total).toBe(4);

    // Fora da visibilidade -> 404, nunca 403 (CLAUDE.md regra 8).
    const negado = await app.agent
      .get(`${BASE}/${doOutro.id}`)
      .set(app.auth(attendantA))
      .expect(404);
    expect(negado.body.error.code).toBe('NOT_FOUND');
    await app.agent.get(`${BASE}/${semConversa.id}`).set(app.auth(attendantA)).expect(404);
    await app.agent.get(`${BASE}/${doOutro.id}`).set(app.auth(managerA)).expect(200);
  });

  /**
   * O coracao de D-060: os contadores da ficha usam o MESMO recorte da
   * listagem. Se um dia alguem trocar o `LATERAL` por um `COUNT(*)` do
   * laboratorio inteiro, este teste cai — e e ele que impede a ficha de virar
   * caminho lateral para o atendente saber da conversa do colega.
   */
  it('contadores da ficha refletem o recorte de quem pergunta', async () => {
    const exam = await createExam({ tenantId: tenantA.id, db });
    const patient = await createPatient({ tenantId: tenantA.id, name: 'Compartilhado', db });

    const minha = await createConversation({
      tenantId: tenantA.id,
      assignedTo: attendantA.id,
      db,
    });
    const doColega = await createConversation({
      tenantId: tenantA.id,
      assignedTo: otherAttendantA.id,
      db,
    });
    await linkConversation(minha.id, patient.id, { lastMessageAt: '2026-08-20T10:00:00', db });
    await linkConversation(doColega.id, patient.id, {
      lastMessageAt: '2026-08-23T14:30:00',
      db,
    });

    await createProposal({
      tenantId: tenantA.id,
      conversationId: minha.id,
      createdBy: attendantA.id,
      items: [{ examId: exam.id, examName: exam.name, unitPrice: 89.9 }],
      db,
    });
    await createProposal({
      tenantId: tenantA.id,
      conversationId: doColega.id,
      createdBy: otherAttendantA.id,
      items: [{ examId: exam.id, examName: exam.name, unitPrice: 50 }],
      db,
    });

    const daAna = await app.agent
      .get(`${BASE}/${patient.id}`)
      .set(app.auth(attendantA))
      .expect(200);
    expect(daAna.body.conversationCount).toBe(1);
    expect(daAna.body.proposalCount).toBe(1);
    expect(daAna.body.lastInteractionAt).toBe('2026-08-20T10:00:00.000Z');

    const doGestor = await app.agent
      .get(`${BASE}/${patient.id}`)
      .set(app.auth(managerA))
      .expect(200);
    expect(doGestor.body.conversationCount).toBe(2);
    expect(doGestor.body.proposalCount).toBe(2);
    expect(doGestor.body.lastInteractionAt).toBe('2026-08-23T14:30:00.000Z');
  });
});

describe('GET /patients', () => {
  it('devolve o shape do contrato, com data ISO UTC e sem coluna crua', async () => {
    const patient = await createPatient({
      tenantId: tenantA.id,
      name: 'Joao Santos',
      email: 'joao@email.com',
      birthDate: '1984-03-12',
      document: '12345678909',
      notes: 'Prefere coleta pela manha.',
      tags: ['convenio', 'recorrente'],
      customFields: { convenio: 'Unimed' },
      db,
    });
    const conversa = await createConversation({ tenantId: tenantA.id, db });
    await linkConversation(conversa.id, patient.id, {
      lastMessageAt: '2026-08-23T14:30:00',
      db,
    });

    const res = await app.agent.get(BASE).set(app.auth(adminA)).expect(200);
    expect(res.body.patients[0]).toMatchObject({
      id: patient.id,
      name: 'Joao Santos',
      email: 'joao@email.com',
      birthDate: '1984-03-12',
      document: '12345678909',
      notes: 'Prefere coleta pela manha.',
      tags: ['convenio', 'recorrente'],
      customFields: { convenio: 'Unimed' },
      anonymizedAt: null,
      lastInteractionAt: '2026-08-23T14:30:00.000Z',
    });
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 20, total: 1, totalPages: 1 });
  });

  it('busca casa nome, telefone e documento', async () => {
    await createPatient({ tenantId: tenantA.id, name: 'Joao Santos', phone: '+5511911112222', db });
    await createPatient({ tenantId: tenantA.id, name: 'Maria Silva', phone: '+5511933334444', db });
    await createPatient({
      tenantId: tenantA.id,
      name: 'Sem nome util',
      phone: '+5511955556666',
      document: '98765432100',
      db,
    });
    const headers = app.auth(adminA);

    const porNome = await app.agent.get(`${BASE}?search=santos`).set(headers).expect(200);
    expect(porNome.body.patients.map((p: { name: string }) => p.name)).toEqual(['Joao Santos']);

    const porTelefone = await app.agent.get(`${BASE}?search=3333`).set(headers).expect(200);
    expect(porTelefone.body.patients.map((p: { name: string }) => p.name)).toEqual([
      'Maria Silva',
    ]);

    const porDocumento = await app.agent.get(`${BASE}?search=987654`).set(headers).expect(200);
    expect(porDocumento.body.patients.map((p: { name: string }) => p.name)).toEqual([
      'Sem nome util',
    ]);

    // Termo de 2 digitos NAO entra como telefone (mesma regra de /conversations).
    const curto = await app.agent.get(`${BASE}?search=33`).set(headers).expect(200);
    expect(curto.body.patients).toHaveLength(0);
  });

  it('ordena por nome e pagina', async () => {
    await createPatient({ tenantId: tenantA.id, name: 'Carlos', db });
    await createPatient({ tenantId: tenantA.id, name: 'Ana', db });
    await createPatient({ tenantId: tenantA.id, name: 'Bruno', db });
    const headers = app.auth(adminA);

    const p1 = await app.agent
      .get(`${BASE}?sortBy=name&order=asc&limit=2&page=1`)
      .set(headers)
      .expect(200);
    expect(p1.body.patients.map((p: { name: string }) => p.name)).toEqual(['Ana', 'Bruno']);
    expect(p1.body.pagination).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });

    const p2 = await app.agent
      .get(`${BASE}?sortBy=name&order=asc&limit=2&page=2`)
      .set(headers)
      .expect(200);
    expect(p2.body.patients.map((p: { name: string }) => p.name)).toEqual(['Carlos']);
  });

  it('sortBy fora do enum e limit acima de 100 sao VALIDATION_ERROR', async () => {
    const headers = app.auth(adminA);
    const sort = await app.agent.get(`${BASE}?sortBy=telefone`).set(headers).expect(400);
    expect(sort.body.error.code).toBe('VALIDATION_ERROR');
    await app.agent.get(`${BASE}?limit=101`).set(headers).expect(400);
  });
});

describe('GET /patients/:id', () => {
  it('id nao-uuid e VALIDATION_ERROR; inexistente e NOT_FOUND', async () => {
    const headers = app.auth(adminA);
    const invalido = await app.agent.get(`${BASE}/nao-e-uuid`).set(headers).expect(400);
    expect(invalido.body.error.code).toBe('VALIDATION_ERROR');
    await app.agent
      .get(`${BASE}/00000000-0000-4000-8000-000000000009`)
      .set(headers)
      .expect(404);
  });
});

describe('PATCH /patients/:id', () => {
  it('campo ausente preserva, null apaga, e gera audit log so do que mudou', async () => {
    const patient = await createPatient({
      tenantId: tenantA.id,
      name: 'Joao',
      email: 'joao@email.com',
      notes: 'nota antiga',
      db,
    });

    const res = await app.agent
      .patch(`${BASE}/${patient.id}`)
      .set(app.auth(adminA))
      .send({ name: 'Joao Santos', notes: null })
      .expect(200);

    expect(res.body.name).toBe('Joao Santos');
    expect(res.body.notes).toBeNull();
    // `email` nao foi enviado: permanece.
    expect(res.body.email).toBe('joao@email.com');
    expect(res.body).toHaveProperty('conversationCount');

    const logs = await readAuditLogs(tenantA.id, 'update_patient', db);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.entityId).toBe(patient.id);
    expect(logs[0]?.newValues).toEqual({ name: 'Joao Santos', notes: null });
    expect(logs[0]?.oldValues).toEqual({ name: 'Joao', notes: 'nota antiga' });
  });

  it('normaliza o CPF para 11 digitos e recusa DV invalido', async () => {
    const patient = await createPatient({ tenantId: tenantA.id, db });
    const headers = app.auth(adminA);

    const ok = await app.agent
      .patch(`${BASE}/${patient.id}`)
      .set(headers)
      .send({ document: '123.456.789-09' })
      .expect(200);
    expect(ok.body.document).toBe('12345678909');

    const ruim = await app.agent
      .patch(`${BASE}/${patient.id}`)
      .set(headers)
      .send({ document: '123.456.789-00' })
      .expect(400);
    expect(ruim.body.error.code).toBe('VALIDATION_ERROR');
    expect(ruim.body.error.details.fields).toHaveProperty('document');
  });

  it('recusa phone (D-061), campo desconhecido, corpo vazio e data futura', async () => {
    const patient = await createPatient({ tenantId: tenantA.id, db });
    const headers = app.auth(adminA);

    const comPhone = await app.agent
      .patch(`${BASE}/${patient.id}`)
      .set(headers)
      .send({ phone: '+5511999999999' })
      .expect(400);
    expect(comPhone.body.error.code).toBe('VALIDATION_ERROR');

    await app.agent.patch(`${BASE}/${patient.id}`).set(headers).send({ xpto: 1 }).expect(400);
    await app.agent.patch(`${BASE}/${patient.id}`).set(headers).send({}).expect(400);

    const futura = await app.agent
      .patch(`${BASE}/${patient.id}`)
      .set(headers)
      .send({ birthDate: '2999-01-01' })
      .expect(400);
    expect(futura.body.error.details.fields).toHaveProperty('birthDate');

    await app.agent
      .patch(`${BASE}/${patient.id}`)
      .set(headers)
      .send({ birthDate: '1984-02-31' })
      .expect(400);
  });

  it('atendente edita o paciente que enxerga e nao o do colega', async () => {
    const meu = await createPatient({ tenantId: tenantA.id, db });
    const doColega = await createPatient({ tenantId: tenantA.id, db });
    const c1 = await createConversation({ tenantId: tenantA.id, assignedTo: attendantA.id, db });
    const c2 = await createConversation({
      tenantId: tenantA.id,
      assignedTo: otherAttendantA.id,
      db,
    });
    await linkConversation(c1.id, meu.id, { db });
    await linkConversation(c2.id, doColega.id, { db });
    const headers = app.auth(attendantA);

    await app.agent.patch(`${BASE}/${meu.id}`).set(headers).send({ name: 'Editado' }).expect(200);
    await app.agent
      .patch(`${BASE}/${doColega.id}`)
      .set(headers)
      .send({ name: 'Invasao' })
      .expect(404);
  });

  it('nao toca nas colunas denormalizadas de conversations (D-059)', async () => {
    const patient = await createPatient({ tenantId: tenantA.id, name: 'Joao', db });
    const conversa = await createConversation({
      tenantId: tenantA.id,
      patientName: 'Joao (do canal)',
      db,
    });
    await linkConversation(conversa.id, patient.id, { db });

    await app.agent
      .patch(`${BASE}/${patient.id}`)
      .set(app.auth(adminA))
      .send({ name: 'Joao Santos' })
      .expect(200);

    const row = await db.withTenant(tenantA.id, (tx) =>
      tx.query<{ patient_name: string }>(
        'SELECT patient_name FROM conversations WHERE id = $1',
        [conversa.id],
      ),
    );
    expect(row.rows[0]?.patient_name).toBe('Joao (do canal)');
  });
});
