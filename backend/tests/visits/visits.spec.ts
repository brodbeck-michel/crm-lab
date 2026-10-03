/**
 * `/api/v1/visits` — API_CONTRACTS.md §14 (CRMLAB-87, D-256).
 *
 * Foco: criar com medico/responsavel do MESMO laboratorio, listar por periodo
 * com filtros, editar so visita `agendada`, reagendar gravando o historico,
 * cancelar / "nao recebeu" com motivo obrigatorio, isolamento multitenant
 * (visita de outro tenant -> 404, nunca 403), todos os papeis escrevem e o
 * audit log de cada escrita.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, ListVisitsResponse, VisitDetail } from '@crm-lab/shared';
import { visitModule } from '../../src/controllers/visit.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const BASE = '/api/v1/visits';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000001';
const WEEK = { from: '2026-10-05T03:00:00.000Z', to: '2026-10-12T03:00:00.000Z' };

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let adminA: UserRecord;
let managerA: UserRecord;
let attendantA: UserRecord;
let attendantB: UserRecord;
let doctorA: string;
let doctorA2: string;
let doctorB: string;

beforeAll(async () => {
  db = await getTestDb();
});

async function insertDoctor(tenantId: string, name: string, isActive = true): Promise<string> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      'INSERT INTO doctors (tenant_id, name, is_active) VALUES ($1, $2, $3) RETURNING id',
      [tenantId, name, isActive],
    ),
  );
  return result.rows[0]?.id as string;
}

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [visitModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  adminA = await createUser({ tenantId: tenantA.id, role: 'admin', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', name: 'Gestora Ana', db });
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', name: 'Atendente Bia', db });
  attendantB = await createUser({ tenantId: tenantB.id, role: 'attendant', db });
  doctorA = await insertDoctor(tenantA.id, 'Dra. Júlia Costa');
  doctorA2 = await insertDoctor(tenantA.id, 'Dr. Paulo Lima');
  doctorB = await insertDoctor(tenantB.id, 'Dr. Confidencial Beta');
});

function visitBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    doctorId: doctorA,
    responsibleId: attendantA.id,
    scheduledAt: '2026-10-06T13:00:00.000Z',
    type: 'presencial',
    agenda: 'Apresentar o painel de check-up',
    ...overrides,
  };
}

async function createOk(user: UserRecord, overrides: Record<string, unknown> = {}): Promise<VisitDetail> {
  const response = await app.agent.post(BASE).set(app.auth(user)).send(visitBody(overrides));
  expect(response.status).toBe(201);
  return response.body as VisitDetail;
}

async function list(user: UserRecord, query: Record<string, string> = {}) {
  return app.agent.get(BASE).set(app.auth(user)).query({ ...WEEK, ...query });
}

async function auditOf(entityId: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{
      action: string;
      tenant_id: string;
      user_id: string;
      old_values: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
    }>(
      `SELECT action, tenant_id, user_id, old_values, new_values FROM audit_logs
       WHERE entity_type = 'visit' AND entity_id = $1 ORDER BY timestamp, action`,
      [entityId],
    ),
  );
  return result.rows;
}

function errorOf(response: { body: unknown }) {
  return (response.body as ApiErrorBody).error;
}

describe('guardas de acesso', () => {
  it('sem token: 401', async () => {
    await app.agent.get(BASE).query(WEEK).expect(401);
    await app.agent.post(BASE).send(visitBody()).expect(401);
  });

  it('platform_operator recebe 403 FORBIDDEN em todas as rotas', async () => {
    const plataforma = await createTenant({ name: 'Plataforma', slug: 'plataforma', db });
    const operator = await createUser({ tenantId: plataforma.id, role: 'platform_operator', db });
    const headers = app.auth(operator);
    const responses = [
      await app.agent.get(BASE).set(headers).query(WEEK),
      await app.agent.get(`${BASE}/${UNKNOWN_ID}`).set(headers),
      await app.agent.post(BASE).set(headers).send(visitBody()),
      await app.agent.patch(`${BASE}/${UNKNOWN_ID}`).set(headers).send({ type: 'online' }),
      await app.agent.post(`${BASE}/${UNKNOWN_ID}/reschedule`).set(headers).send({ scheduledAt: WEEK.from }),
      await app.agent.post(`${BASE}/${UNKNOWN_ID}/cancel`).set(headers).send({ reason: 'x' }),
      await app.agent.post(`${BASE}/${UNKNOWN_ID}/not-received`).set(headers).send({ reason: 'x' }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(errorOf(res).code).toBe('FORBIDDEN');
    }
  });

  it('atendente, gestor e admin agendam, editam, reagendam e cancelam visitas de qualquer responsável', async () => {
    for (const user of [attendantA, managerA, adminA]) {
      // Responsável é outra pessoa: todo mundo mexe em todas as visitas (resposta 2A).
      const visit = await createOk(user, { responsibleId: managerA.id });
      const h = app.auth(user);
      await app.agent.patch(`${BASE}/${visit.id}`).set(h).send({ type: 'online' }).expect(200);
      await app.agent
        .post(`${BASE}/${visit.id}/reschedule`)
        .set(h)
        .send({ scheduledAt: '2026-10-07T13:00:00.000Z' })
        .expect(200);
      await app.agent.post(`${BASE}/${visit.id}/cancel`).set(h).send({ reason: 'Agenda do médico' }).expect(200);
    }
  });
});

describe('POST /visits', () => {
  it('201 com a visita agendada, médico, responsável e quem criou', async () => {
    const visit = await createOk(attendantA, { agenda: '  Apresentar o painel  ' });
    expect(visit).toMatchObject({
      doctor: { id: doctorA, name: 'Dra. Júlia Costa', isActive: true },
      responsible: { id: attendantA.id, name: 'Atendente Bia' },
      scheduledAt: '2026-10-06T13:00:00.000Z',
      type: 'presencial',
      agenda: 'Apresentar o painel',
      status: 'agendada',
      statusReason: null,
      statusChangedAt: null,
      statusChangedBy: null,
      rescheduleCount: 0,
      createdBy: { id: attendantA.id },
      reschedules: [],
    });
  });

  it('horário com fuso é gravado em UTC; sem fuso -> 400', async () => {
    const visit = await createOk(attendantA, { scheduledAt: '2026-10-06T10:00:00-03:00' });
    expect(visit.scheduledAt).toBe('2026-10-06T13:00:00.000Z');
    const res = await app.agent
      .post(BASE)
      .set(app.auth(attendantA))
      .send(visitBody({ scheduledAt: '2026-10-06T10:00:00' }));
    expect(res.status).toBe(400);
  });

  it('data no passado é aceita (lançar visita depois)', async () => {
    const visit = await createOk(attendantA, { scheduledAt: '2020-01-02T12:00:00.000Z' });
    expect(visit.status).toBe('agendada');
  });

  it('campos obrigatórios, tipo fora da lista e campo desconhecido -> 400', async () => {
    const h = app.auth(attendantA);
    for (const field of ['doctorId', 'responsibleId', 'scheduledAt', 'type']) {
      const body = visitBody();
      delete body[field];
      await app.agent.post(BASE).set(h).send(body).expect(400);
    }
    await app.agent.post(BASE).set(h).send(visitBody({ type: 'visita' })).expect(400);
    await app.agent.post(BASE).set(h).send(visitBody({ status: 'realizada' })).expect(400);
  });

  it('médico inativo, de outro laboratório ou inexistente -> 400 em doctorId', async () => {
    const inactive = await insertDoctor(tenantA.id, 'Dr. Inativo', false);
    for (const doctorId of [inactive, doctorB, UNKNOWN_ID]) {
      const res = await app.agent.post(BASE).set(app.auth(attendantA)).send(visitBody({ doctorId }));
      expect(res.status).toBe(400);
      expect(errorOf(res).details).toMatchObject({ fields: { doctorId: expect.any(String) } });
    }
  });

  it('responsável inativo ou de outro laboratório -> 400 em responsibleId', async () => {
    const inactive = await createUser({ tenantId: tenantA.id, role: 'attendant', isActive: false, db });
    for (const responsibleId of [inactive.id, attendantB.id]) {
      const res = await app.agent.post(BASE).set(app.auth(attendantA)).send(visitBody({ responsibleId }));
      expect(res.status).toBe(400);
      expect(errorOf(res).details).toMatchObject({ fields: { responsibleId: expect.any(String) } });
    }
  });
});

describe('GET /visits — período e filtros', () => {
  it('só o período [from, to), em ordem de data; filtros por médico, responsável e status', async () => {
    const late = await createOk(attendantA, { scheduledAt: '2026-10-09T18:00:00.000Z' });
    const early = await createOk(attendantA, { scheduledAt: '2026-10-05T12:00:00.000Z', doctorId: doctorA2 });
    const other = await createOk(managerA, { scheduledAt: '2026-10-07T12:00:00.000Z', responsibleId: managerA.id });
    await createOk(attendantA, { scheduledAt: '2026-10-12T03:00:00.000Z' }); // == to: fora
    await createOk(attendantA, { scheduledAt: '2026-10-05T02:59:59.000Z' }); // antes de from: fora
    await app.agent.post(`${BASE}/${other.id}/cancel`).set(app.auth(managerA)).send({ reason: 'Férias' }).expect(200);

    const all = await list(attendantA);
    expect(all.status).toBe(200);
    const body = all.body as ListVisitsResponse;
    expect(body.truncated).toBe(false);
    expect(body.visits.map((v) => v.id)).toEqual([early.id, other.id, late.id]);

    const byDoctor = (await list(attendantA, { doctorId: doctorA2 })).body as ListVisitsResponse;
    expect(byDoctor.visits.map((v) => v.id)).toEqual([early.id]);
    const byResponsible = (await list(attendantA, { responsibleId: managerA.id })).body as ListVisitsResponse;
    expect(byResponsible.visits.map((v) => v.id)).toEqual([other.id]);
    const byStatus = (await list(attendantA, { status: 'cancelada' })).body as ListVisitsResponse;
    expect(byStatus.visits.map((v) => v.id)).toEqual([other.id]);
  });

  it('período obrigatório, fim depois do início e no máximo 62 dias', async () => {
    const h = app.auth(attendantA);
    await app.agent.get(BASE).set(h).expect(400);
    await app.agent.get(BASE).set(h).query({ from: WEEK.from }).expect(400);
    const inverted = await app.agent.get(BASE).set(h).query({ from: WEEK.to, to: WEEK.from });
    expect(inverted.status).toBe(400);
    expect(errorOf(inverted).details).toMatchObject({ fields: { to: expect.any(String) } });
    await app.agent
      .get(BASE)
      .set(h)
      .query({ from: '2026-10-01T00:00:00.000Z', to: '2026-12-03T00:00:00.000Z' })
      .expect(400);
    await app.agent
      .get(BASE)
      .set(h)
      .query({ from: '2026-10-01T00:00:00.000Z', to: '2026-12-02T00:00:00.000Z' })
      .expect(200);
    await app.agent.get(BASE).set(h).query({ ...WEEK, status: 'reagendada' }).expect(400);
  });
});

describe('PATCH /visits/:id', () => {
  it('parcial: troca médico, responsável, tipo e limpa a pauta; data não muda por aqui', async () => {
    const visit = await createOk(attendantA);
    const res = await app.agent
      .patch(`${BASE}/${visit.id}`)
      .set(app.auth(attendantA))
      .send({ doctorId: doctorA2, responsibleId: managerA.id, type: 'telefone', agenda: null });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      doctor: { id: doctorA2 },
      responsible: { id: managerA.id, name: 'Gestora Ana' },
      type: 'telefone',
      agenda: null,
      scheduledAt: visit.scheduledAt,
    });
    await app.agent
      .patch(`${BASE}/${visit.id}`)
      .set(app.auth(attendantA))
      .send({ scheduledAt: '2026-10-08T13:00:00.000Z' })
      .expect(400);
  });

  it('médico inativado depois: a visita continua editável sem trocar o médico', async () => {
    const visit = await createOk(attendantA);
    await db.withoutTenant((tx) => tx.query('UPDATE doctors SET is_active = FALSE WHERE id = $1', [doctorA]));
    await app.agent.patch(`${BASE}/${visit.id}`).set(app.auth(attendantA)).send({ agenda: 'Nova pauta' }).expect(200);
    const res = await app.agent.patch(`${BASE}/${visit.id}`).set(app.auth(attendantA)).send({ doctorId: doctorB });
    expect(res.status).toBe(400);
  });
});

describe('reagendar', () => {
  it('muda a data da MESMA visita e grava o histórico (data antiga, nova, motivo, quem)', async () => {
    const visit = await createOk(attendantA);
    const first = await app.agent
      .post(`${BASE}/${visit.id}/reschedule`)
      .set(app.auth(managerA))
      .send({ scheduledAt: '2026-10-08T14:30:00.000Z', reason: 'Médico pediu outro dia' });
    expect(first.status).toBe(200);
    const second = await app.agent
      .post(`${BASE}/${visit.id}/reschedule`)
      .set(app.auth(attendantA))
      .send({ scheduledAt: '2026-10-09T12:00:00-03:00' });
    const body = second.body as VisitDetail;
    expect(body.id).toBe(visit.id);
    expect(body.status).toBe('agendada');
    expect(body.scheduledAt).toBe('2026-10-09T15:00:00.000Z');
    expect(body.rescheduleCount).toBe(2);
    expect(body.reschedules).toMatchObject([
      {
        previousScheduledAt: '2026-10-06T13:00:00.000Z',
        newScheduledAt: '2026-10-08T14:30:00.000Z',
        reason: 'Médico pediu outro dia',
        changedBy: { id: managerA.id, name: 'Gestora Ana' },
      },
      {
        previousScheduledAt: '2026-10-08T14:30:00.000Z',
        newScheduledAt: '2026-10-09T15:00:00.000Z',
        reason: null,
        changedBy: { id: attendantA.id },
      },
    ]);

    const fetched = await app.agent.get(`${BASE}/${visit.id}`).set(app.auth(adminA));
    expect((fetched.body as VisitDetail).reschedules).toHaveLength(2);
  });

  it('mesma data/hora: 200 sem histórico nem audit', async () => {
    const visit = await createOk(attendantA);
    const res = await app.agent
      .post(`${BASE}/${visit.id}/reschedule`)
      .set(app.auth(attendantA))
      .send({ scheduledAt: '2026-10-06T10:00:00-03:00' });
    expect(res.status).toBe(200);
    expect((res.body as VisitDetail).reschedules).toEqual([]);
    expect((await auditOf(visit.id)).map((a) => a.action)).toEqual(['create_visit']);
  });
});

describe('cancelar / médico não recebeu', () => {
  it('motivo obrigatório (ausente, vazio ou só espaço -> 400)', async () => {
    const visit = await createOk(attendantA);
    const h = app.auth(attendantA);
    for (const route of ['cancel', 'not-received']) {
      await app.agent.post(`${BASE}/${visit.id}/${route}`).set(h).send({}).expect(400);
      await app.agent.post(`${BASE}/${visit.id}/${route}`).set(h).send({ reason: '   ' }).expect(400);
    }
    const fetched = await app.agent.get(`${BASE}/${visit.id}`).set(h);
    expect((fetched.body as VisitDetail).status).toBe('agendada');
  });

  it('cancelar grava status, motivo, quando e quem', async () => {
    const visit = await createOk(attendantA);
    const res = await app.agent
      .post(`${BASE}/${visit.id}/cancel`)
      .set(app.auth(managerA))
      .send({ reason: '  Médico de férias  ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'cancelada',
      statusReason: 'Médico de férias',
      statusChangedBy: { id: managerA.id },
    });
    expect((res.body as VisitDetail).statusChangedAt).toEqual(expect.any(String));
  });

  it('"não recebeu" vira nao_recebeu; repetir é idempotente; o outro encerramento -> 409', async () => {
    const visit = await createOk(attendantA);
    const h = app.auth(attendantA);
    const first = await app.agent.post(`${BASE}/${visit.id}/not-received`).set(h).send({ reason: 'Consultório fechado' });
    expect(first.status).toBe(200);
    expect((first.body as VisitDetail).status).toBe('nao_recebeu');

    await app.agent.post(`${BASE}/${visit.id}/not-received`).set(h).send({ reason: 'De novo' }).expect(200);
    const again = await app.agent.get(`${BASE}/${visit.id}`).set(h);
    expect((again.body as VisitDetail).statusReason).toBe('Consultório fechado');

    const cancel = await app.agent.post(`${BASE}/${visit.id}/cancel`).set(h).send({ reason: 'x' });
    expect(cancel.status).toBe(409);
    expect(errorOf(cancel)).toMatchObject({ code: 'VISIT_ALREADY_CLOSED', details: { status: 'nao_recebeu' } });
  });

  it('visita encerrada não edita nem reagenda -> 409 VISIT_ALREADY_CLOSED', async () => {
    const visit = await createOk(attendantA);
    const h = app.auth(attendantA);
    await app.agent.post(`${BASE}/${visit.id}/cancel`).set(h).send({ reason: 'Cancelada' }).expect(200);

    const patch = await app.agent.patch(`${BASE}/${visit.id}`).set(h).send({ type: 'online' });
    expect(patch.status).toBe(409);
    expect(errorOf(patch).code).toBe('VISIT_ALREADY_CLOSED');
    const reschedule = await app.agent
      .post(`${BASE}/${visit.id}/reschedule`)
      .set(h)
      .send({ scheduledAt: '2026-10-10T13:00:00.000Z' });
    expect(reschedule.status).toBe(409);
  });

  it('o banco recusa encerrar sem motivo mesmo fora do service', async () => {
    const visit = await createOk(attendantA);
    await expect(
      db.withoutTenant((tx) =>
        tx.query(`UPDATE doctor_visits SET status = 'cancelada', status_reason = '  ' WHERE id = $1`, [visit.id]),
      ),
    ).rejects.toThrow();
  });
});

describe('isolamento multitenant', () => {
  it('visita do tenant B: GET, PATCH, reagendar, cancelar e não recebeu -> 404 NOT_FOUND', async () => {
    const response = await app.agent
      .post(BASE)
      .set(app.auth(attendantB))
      .send(visitBody({ doctorId: doctorB, responsibleId: attendantB.id }));
    expect(response.status).toBe(201);
    const visitB = response.body as VisitDetail;

    const h = app.auth(attendantA);
    const responses = [
      await app.agent.get(`${BASE}/${visitB.id}`).set(h),
      await app.agent.patch(`${BASE}/${visitB.id}`).set(h).send({ type: 'online' }),
      await app.agent.post(`${BASE}/${visitB.id}/reschedule`).set(h).send({ scheduledAt: WEEK.from }),
      await app.agent.post(`${BASE}/${visitB.id}/cancel`).set(h).send({ reason: 'x' }),
      await app.agent.post(`${BASE}/${visitB.id}/not-received`).set(h).send({ reason: 'x' }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('NOT_FOUND');
    }
    const untouched = await app.agent.get(`${BASE}/${visitB.id}`).set(app.auth(attendantB));
    expect(untouched.body).toMatchObject({ status: 'agendada', type: 'presencial', reschedules: [] });
  });

  it('listagem nunca cruza tenant, nem filtrando pelo médico/responsável do outro', async () => {
    await app.agent
      .post(BASE)
      .set(app.auth(attendantB))
      .send(visitBody({ doctorId: doctorB, responsibleId: attendantB.id }))
      .expect(201);
    await createOk(attendantA);
    const queries: Array<Record<string, string>> = [{}, { doctorId: doctorB }, { responsibleId: attendantB.id }];
    for (const query of queries) {
      const res = await list(attendantA, query);
      expect(JSON.stringify(res.body)).not.toContain('Dr. Confidencial Beta');
    }
  });

  it('as 2 tabelas novas nascem sob RLS: contexto de A não vê linha de B', async () => {
    const tables = await db.withoutTenant((tx) =>
      tx.query<{ tablename: string; rowsecurity: boolean }>(
        `SELECT tablename, rowsecurity FROM pg_tables
          WHERE schemaname = 'public' AND tablename IN ('doctor_visits', 'doctor_visit_reschedules')`,
      ),
    );
    expect(tables.rows).toHaveLength(2);
    for (const row of tables.rows) expect(row.rowsecurity).toBe(true);

    const res = await app.agent
      .post(BASE)
      .set(app.auth(attendantB))
      .send(visitBody({ doctorId: doctorB, responsibleId: attendantB.id }));
    const visitB = res.body as VisitDetail;
    await app.agent
      .post(`${BASE}/${visitB.id}/reschedule`)
      .set(app.auth(attendantB))
      .send({ scheduledAt: WEEK.from })
      .expect(200);

    const seen = await db.withTenant(tenantA.id, async (tx) => {
      const visits = await tx.query('SELECT id FROM doctor_visits');
      const history = await tx.query('SELECT id FROM doctor_visit_reschedules');
      return visits.rows.length + history.rows.length;
    });
    expect(seen).toBe(0);
  });

  it('id inexistente -> 404; id não-uuid -> 400', async () => {
    await app.agent.get(`${BASE}/${UNKNOWN_ID}`).set(app.auth(attendantA)).expect(404);
    await app.agent.get(`${BASE}/nao-e-uuid`).set(app.auth(attendantA)).expect(400);
  });
});

describe('audit log', () => {
  it('create_visit, update_visit (só o que mudou), reschedule_visit, cancel_visit e visit_not_received', async () => {
    const visit = await createOk(attendantA);
    const h = app.auth(attendantA);
    await app.agent.patch(`${BASE}/${visit.id}`).set(h).send({ type: 'online', agenda: visit.agenda }).expect(200);
    // PATCH sem mudança real não grava audit.
    await app.agent.patch(`${BASE}/${visit.id}`).set(h).send({ type: 'online' }).expect(200);
    await app.agent
      .post(`${BASE}/${visit.id}/reschedule`)
      .set(h)
      .send({ scheduledAt: '2026-10-08T13:00:00.000Z', reason: 'Pedido do médico' })
      .expect(200);
    await app.agent.post(`${BASE}/${visit.id}/cancel`).set(h).send({ reason: 'Viagem' }).expect(200);

    const other = await createOk(managerA);
    await app.agent.post(`${BASE}/${other.id}/not-received`).set(app.auth(managerA)).send({ reason: 'Fechado' }).expect(200);

    const logs = await auditOf(visit.id);
    expect(logs.map((l) => l.action)).toEqual(['create_visit', 'update_visit', 'reschedule_visit', 'cancel_visit']);
    for (const log of logs) {
      expect(log.tenant_id).toBe(tenantA.id);
      expect(log.user_id).toBe(attendantA.id);
    }
    expect(logs[0]?.new_values).toMatchObject({ doctorId: doctorA, responsibleId: attendantA.id, status: 'agendada' });
    expect(logs[1]?.old_values).toEqual({ type: 'presencial' });
    expect(logs[1]?.new_values).toEqual({ type: 'online' });
    expect(logs[2]?.old_values).toEqual({ scheduledAt: '2026-10-06T13:00:00.000Z' });
    expect(logs[2]?.new_values).toEqual({ scheduledAt: '2026-10-08T13:00:00.000Z', reason: 'Pedido do médico' });
    expect(logs[3]?.new_values).toEqual({ status: 'cancelada', reason: 'Viagem' });

    expect((await auditOf(other.id)).map((l) => l.action)).toEqual(['create_visit', 'visit_not_received']);
  });
});
