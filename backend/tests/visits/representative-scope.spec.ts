/**
 * Perfil representante e escopo por carteira na Visitação — CRMLAB-189, D-329
 * (SECURITY.md "Visitação Médica — escopo por carteira").
 *
 * Foco: atendente → 403 por perfil em todas as rotas; representante vê só a
 * carteira (médicos dele) e as visitas dos médicos dele OU em que ele é o
 * responsável (cobertura); fora disso → 404 (nunca 403); gestor/admin tudo;
 * responsável obrigatório e elegível; carteiras e transferência em lote com
 * audit; isolamento entre tenants.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiErrorBody,
  Doctor,
  ListDoctorPortfoliosResponse,
  ListDoctorsResponse,
  ListVisitsResponse,
  TransferDoctorsResponse,
  VisitDetail,
} from '@crm-lab/shared';
import { doctorModule } from '../../src/controllers/doctor.routes.js';
import { visitModule } from '../../src/controllers/visit.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, visitPurposeId, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const DOCTORS = '/api/v1/doctors';
const VISITS = '/api/v1/visits';
/** Janela que cobre todas as visitas do cenário. */
const RANGE = '?from=2026-01-01T00:00:00.000Z&to=2026-03-01T00:00:00.000Z';

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let purposeA: string; // finalidade "Visita" (CRMLAB-190)
let admin: UserRecord;
let manager: UserRecord;
let attendant: UserRecord;
let carla: UserRecord; // representante
let diego: UserRecord; // representante
let repB: UserRecord; // representante de outro laboratório

// Médicos de A
let drCarla: string;
let drDiego: string;
let drOrphan: string; // sem responsável
let drAttendant: string; // responsável atendente (inelegível desde D-329)
let drB: string; // médico do tenant B

// Visitas de A
let vCarla: string; // médico da Carla, responsável Carla
let vDiego: string; // médico do Diego, responsável Diego
let vCoverage: string; // médico do Diego, responsável Carla (cobertura)
let vDiegoFuture: string; // médico do Diego, responsável Diego, no futuro distante
let attachmentDiego: string; // anexo de vDiego

async function insertDoctor(tenantId: string, name: string, responsibleId: string | null): Promise<string> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      'INSERT INTO doctors (tenant_id, name, responsible_user_id) VALUES ($1, $2, $3) RETURNING id',
      [tenantId, name, responsibleId],
    ),
  );
  return result.rows[0]?.id as string;
}

async function insertVisit(
  tenantId: string,
  doctorId: string,
  responsibleId: string,
  scheduledAt: string,
): Promise<string> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO doctor_visits (tenant_id, doctor_id, responsible_user_id, scheduled_at, type, purpose_id)
       VALUES ($1, $2, $3, $4::timestamptz, 'presencial',
               (SELECT id FROM visit_purposes WHERE tenant_id = $1 AND name = 'Visita')) RETURNING id`,
      [tenantId, doctorId, responsibleId, scheduledAt],
    ),
  );
  return result.rows[0]?.id as string;
}

function errorOf(response: { body: unknown }) {
  return (response.body as ApiErrorBody).error;
}

async function auditOf(entityType: string, entityId: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ action: string; old_values: Record<string, unknown> | null; new_values: Record<string, unknown> | null }>(
      `SELECT action, old_values, new_values FROM audit_logs
       WHERE entity_type = $1 AND entity_id = $2 ORDER BY timestamp, action`,
      [entityType, entityId],
    ),
  );
  return result.rows;
}

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [doctorModule, visitModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  purposeA = await visitPurposeId(tenantA.id, 'Visita', db);
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  admin = await createUser({ tenantId: tenantA.id, role: 'admin', name: 'Admin A', db });
  manager = await createUser({ tenantId: tenantA.id, role: 'manager', name: 'Gestora A', db });
  attendant = await createUser({ tenantId: tenantA.id, role: 'attendant', name: 'Atendente A', db });
  carla = await createUser({ tenantId: tenantA.id, role: 'representative', name: 'Carla Rep', db });
  diego = await createUser({ tenantId: tenantA.id, role: 'representative', name: 'Diego Rep', db });
  repB = await createUser({ tenantId: tenantB.id, role: 'representative', name: 'Rep B', db });

  drCarla = await insertDoctor(tenantA.id, 'Dra. Carteira Carla', carla.id);
  drDiego = await insertDoctor(tenantA.id, 'Dr. Carteira Diego', diego.id);
  drOrphan = await insertDoctor(tenantA.id, 'Dr. Sem Responsável', null);
  drAttendant = await insertDoctor(tenantA.id, 'Dr. Da Atendente', attendant.id);
  drB = await insertDoctor(tenantB.id, 'Dr. Outro Lab', repB.id);

  vCarla = await insertVisit(tenantA.id, drCarla, carla.id, '2026-01-10T13:00:00.000Z');
  vDiego = await insertVisit(tenantA.id, drDiego, diego.id, '2026-01-11T13:00:00.000Z');
  vCoverage = await insertVisit(tenantA.id, drDiego, carla.id, '2026-01-12T13:00:00.000Z');
  vDiegoFuture = await insertVisit(tenantA.id, drDiego, diego.id, '2099-01-12T13:00:00.000Z');

  const attachment = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO doctor_visit_attachments (tenant_id, visit_id, mime_type, file_name, byte_size, uploaded_by)
       VALUES ($1, $2, 'application/pdf', 'relato.pdf', 10, $3) RETURNING id`,
      [tenantA.id, vDiego, diego.id],
    ),
  );
  attachmentDiego = attachment.rows[0]?.id as string;
});

describe('atendente fica fora da Visitação (403 por perfil)', () => {
  it('todas as rotas de médicos, visitas, linha do tempo e carteiras respondem 403', async () => {
    const headers = app.auth(attendant);
    const calls = [
      app.agent.get(DOCTORS).set(headers),
      app.agent.get(`${DOCTORS}/${drCarla}`).set(headers),
      app.agent.post(DOCTORS).set(headers).send({ name: 'Dr. X', responsibleId: manager.id }),
      app.agent.patch(`${DOCTORS}/${drCarla}`).set(headers).send({ clinic: 'X' }),
      app.agent.post(`${DOCTORS}/${drCarla}/inactivate`).set(headers),
      app.agent.get(`${DOCTORS}/${drCarla}/timeline`).set(headers),
      app.agent
        .post(`${DOCTORS}/${drCarla}/interactions`)
        .set(headers)
        .send({ type: 'ligacao', occurredAt: '2026-01-01T12:00:00.000Z', description: 'x' }),
      app.agent.get(`${DOCTORS}/portfolios`).set(headers),
      app.agent.post(`${DOCTORS}/transfer`).set(headers).send({ doctorIds: [drCarla], toUserId: diego.id }),
      app.agent.get(`${VISITS}${RANGE}`).set(headers),
      app.agent.get(`${VISITS}/${vCarla}`).set(headers),
      app.agent
        .post(VISITS)
        .set(headers)
        .send({ doctorId: drCarla, responsibleId: carla.id, scheduledAt: '2026-01-20T13:00:00.000Z', type: 'presencial' }),
      app.agent.post(`${VISITS}/${vCarla}/check-in`).set(headers).send({}),
      app.agent.get(`${VISITS}/${vDiego}/attachments/${attachmentDiego}`).set(headers),
    ];
    for (const response of await Promise.all(calls)) {
      expect(response.status).toBe(403);
      expect(errorOf(response).code).toBe('FORBIDDEN');
    }
  });

  it('o 403 informa os perfis que acessam a Visitação', async () => {
    const response = await app.agent.get(DOCTORS).set(app.auth(attendant)).expect(403);
    expect(errorOf(response).details).toMatchObject({ requiredRoles: ['representative', 'manager', 'admin'] });
  });
});

describe('representante: médicos só da própria carteira', () => {
  it('a lista vem recortada; filtros por outro responsável ou "sem responsável" voltam vazios', async () => {
    const own = (await app.agent.get(DOCTORS).set(app.auth(carla)).expect(200)).body as ListDoctorsResponse;
    expect(own.doctors.map((d) => d.id)).toEqual([drCarla]);
    expect(own.pagination.total).toBe(1);

    const other = (await app.agent.get(`${DOCTORS}?responsibleId=${diego.id}`).set(app.auth(carla)).expect(200))
      .body as ListDoctorsResponse;
    expect(other.doctors).toEqual([]);

    const unassigned = (await app.agent.get(`${DOCTORS}?unassigned=true`).set(app.auth(carla)).expect(200))
      .body as ListDoctorsResponse;
    expect(unassigned.doctors).toEqual([]);
  });

  it('médico de outra carteira → 404 em detalhe, edição, inativar, linha do tempo e registros', async () => {
    const headers = app.auth(carla);
    const responses = await Promise.all([
      app.agent.get(`${DOCTORS}/${drDiego}`).set(headers),
      app.agent.patch(`${DOCTORS}/${drDiego}`).set(headers).send({ clinic: 'X' }),
      app.agent.post(`${DOCTORS}/${drDiego}/inactivate`).set(headers),
      app.agent.post(`${DOCTORS}/${drDiego}/reactivate`).set(headers),
      app.agent.get(`${DOCTORS}/${drDiego}/timeline`).set(headers),
      app.agent
        .post(`${DOCTORS}/${drDiego}/interactions`)
        .set(headers)
        .send({ type: 'ligacao', occurredAt: '2026-01-01T12:00:00.000Z', description: 'x' }),
      app.agent.get(`${DOCTORS}/${drOrphan}`).set(headers),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(errorOf(response).code).toBe('NOT_FOUND');
    }
  });

  it('não edita nem apaga registro manual de médico de outra carteira', async () => {
    const created = await app.agent
      .post(`${DOCTORS}/${drDiego}/interactions`)
      .set(app.auth(diego))
      .send({ type: 'ligacao', occurredAt: '2026-01-01T12:00:00.000Z', description: 'Do Diego' })
      .expect(201);
    const id = (created.body as { id: string }).id;
    await app.agent
      .patch(`${DOCTORS}/${drDiego}/interactions/${id}`)
      .set(app.auth(carla))
      .send({ description: 'Mexi' })
      .expect(404);
    await app.agent.delete(`${DOCTORS}/${drDiego}/interactions/${id}`).set(app.auth(carla)).expect(404);
  });

  it('na própria carteira: detalhe, edição e linha do tempo funcionam', async () => {
    const headers = app.auth(carla);
    await app.agent.get(`${DOCTORS}/${drCarla}`).set(headers).expect(200);
    const patched = await app.agent.patch(`${DOCTORS}/${drCarla}`).set(headers).send({ clinic: 'Pediatria' }).expect(200);
    expect((patched.body as Doctor).clinic).toBe('Pediatria');
    await app.agent.get(`${DOCTORS}/${drCarla}/timeline`).set(headers).expect(200);
  });

  it('cadastra sempre na própria carteira; outro responsável → VALIDATION_ERROR', async () => {
    const created = await app.agent.post(DOCTORS).set(app.auth(carla)).send({ name: 'Dr. Novo' }).expect(201);
    expect((created.body as Doctor).responsible?.id).toBe(carla.id);

    const other = await app.agent
      .post(DOCTORS)
      .set(app.auth(carla))
      .send({ name: 'Dr. Alheio', responsibleId: diego.id })
      .expect(400);
    expect(errorOf(other).details).toMatchObject({ fields: { responsibleId: expect.any(String) } });
  });

  it('não passa o próprio médico para outra pessoa (transferir é do gestor)', async () => {
    const response = await app.agent
      .patch(`${DOCTORS}/${drCarla}`)
      .set(app.auth(carla))
      .send({ responsibleId: diego.id })
      .expect(400);
    expect(errorOf(response).details).toMatchObject({ fields: { responsibleId: expect.any(String) } });
  });

  it('carteiras e transferência são só de gestor/admin → 403', async () => {
    await app.agent.get(`${DOCTORS}/portfolios`).set(app.auth(carla)).expect(403);
    await app.agent
      .post(`${DOCTORS}/transfer`)
      .set(app.auth(carla))
      .send({ doctorIds: [drDiego], toUserId: carla.id })
      .expect(403);
  });
});

describe('representante: visitas da carteira e de cobertura', () => {
  it('a agenda traz as visitas dos médicos dele e as em que ele é o responsável', async () => {
    const body = (await app.agent.get(`${VISITS}${RANGE}`).set(app.auth(carla)).expect(200)).body as ListVisitsResponse;
    expect(body.visits.map((v) => v.id).sort()).toEqual([vCarla, vCoverage].sort());

    const diegoBody = (await app.agent.get(`${VISITS}${RANGE}`).set(app.auth(diego)).expect(200))
      .body as ListVisitsResponse;
    // Diego vê as visitas do médico dele — inclusive a de cobertura feita pela Carla.
    expect(diegoBody.visits.map((v) => v.id).sort()).toEqual([vDiego, vCoverage].sort());
  });

  it('visita de cobertura (médico de outra carteira) abre e recebe check-in', async () => {
    const detail = await app.agent.get(`${VISITS}/${vCoverage}`).set(app.auth(carla)).expect(200);
    expect((detail.body as VisitDetail).id).toBe(vCoverage);
    const checked = await app.agent.post(`${VISITS}/${vCoverage}/check-in`).set(app.auth(carla)).send({}).expect(200);
    expect((checked.body as VisitDetail).checkInAt).not.toBeNull();
    // Mas a ficha do médico continua fora da carteira dele.
    await app.agent.get(`${DOCTORS}/${drDiego}`).set(app.auth(carla)).expect(404);
  });

  it('visita fora do escopo → 404 em todas as rotas, inclusive o download do anexo', async () => {
    const headers = app.auth(carla);
    const reason = { reason: 'Motivo' };
    const responses = await Promise.all([
      app.agent.get(`${VISITS}/${vDiego}`).set(headers),
      app.agent.patch(`${VISITS}/${vDiego}`).set(headers).send({ agenda: 'x' }),
      app.agent.post(`${VISITS}/${vDiego}/reschedule`).set(headers).send({ scheduledAt: '2026-01-20T13:00:00.000Z' }),
      app.agent.post(`${VISITS}/${vDiego}/cancel`).set(headers).send(reason),
      app.agent.post(`${VISITS}/${vDiego}/not-received`).set(headers).send(reason),
      app.agent.post(`${VISITS}/${vDiego}/check-in`).set(headers).send({}),
      app.agent.post(`${VISITS}/${vDiego}/check-out`).set(headers).send({}),
      app.agent.patch(`${VISITS}/${vDiego}/report`).set(headers).send({ presented: 'x' }),
      app.agent
        .post(`${VISITS}/${vDiego}/attachments`)
        .set(headers)
        .send({ fileName: 'a.pdf', mimeType: 'application/pdf', contentBase64: 'JVBERi0xLjQK' }),
      app.agent.get(`${VISITS}/${vDiego}/attachments/${attachmentDiego}`).set(headers),
      app.agent.delete(`${VISITS}/${vDiego}/attachments/${attachmentDiego}`).set(headers),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(errorOf(response).code).toBe('NOT_FOUND');
    }
  });

  it('agenda só para médico da própria carteira e com ele como responsável', async () => {
    const headers = app.auth(carla);
    const base = { scheduledAt: '2026-01-20T13:00:00.000Z', type: 'presencial', purposeId: purposeA };

    const otherDoctor = await app.agent
      .post(VISITS)
      .set(headers)
      .send({ ...base, doctorId: drDiego, responsibleId: carla.id })
      .expect(400);
    expect(errorOf(otherDoctor).details).toMatchObject({ fields: { doctorId: expect.any(String) } });

    const otherResponsible = await app.agent
      .post(VISITS)
      .set(headers)
      .send({ ...base, doctorId: drCarla, responsibleId: diego.id })
      .expect(400);
    expect(errorOf(otherResponsible).details).toMatchObject({ fields: { responsibleId: expect.any(String) } });

    const ok = await app.agent
      .post(VISITS)
      .set(headers)
      .send({ ...base, doctorId: drCarla, responsibleId: carla.id })
      .expect(201);
    expect((ok.body as VisitDetail).responsible?.id).toBe(carla.id);
  });

  it('na edição não troca para médico de outra carteira nem para outro responsável', async () => {
    const headers = app.auth(carla);
    await app.agent.patch(`${VISITS}/${vCarla}`).set(headers).send({ doctorId: drDiego }).expect(400);
    await app.agent.patch(`${VISITS}/${vCarla}`).set(headers).send({ responsibleId: diego.id }).expect(400);
    await app.agent.patch(`${VISITS}/${vCarla}`).set(headers).send({ agenda: 'Nova pauta' }).expect(200);
  });
});

describe('gestor e admin veem e alteram tudo', () => {
  it('listam todos os médicos e todas as visitas', async () => {
    for (const user of [manager, admin]) {
      const doctors = (await app.agent.get(DOCTORS).set(app.auth(user)).expect(200)).body as ListDoctorsResponse;
      expect(doctors.doctors.map((d) => d.id).sort()).toEqual([drCarla, drDiego, drOrphan, drAttendant].sort());
      const visits = (await app.agent.get(`${VISITS}${RANGE}`).set(app.auth(user)).expect(200))
        .body as ListVisitsResponse;
      expect(visits.visits.map((v) => v.id).sort()).toEqual([vCarla, vDiego, vCoverage].sort());
      await app.agent.get(`${VISITS}/${vDiego}`).set(app.auth(user)).expect(200);
      await app.agent.get(`${DOCTORS}/${drDiego}/timeline`).set(app.auth(user)).expect(200);
    }
  });

  it('"sem responsável / inelegível" traz o órfão, o da atendente e o de responsável inativo', async () => {
    await db.withoutTenant((tx) => tx.query('UPDATE users SET is_active = FALSE WHERE id = $1', [diego.id]));
    const body = (await app.agent.get(`${DOCTORS}?unassigned=true`).set(app.auth(manager)).expect(200))
      .body as ListDoctorsResponse;
    expect(body.doctors.map((d) => d.id).sort()).toEqual([drOrphan, drAttendant, drDiego].sort());
    expect(body.pagination.total).toBe(3);
  });

  it('responsável obrigatório e elegível no cadastro', async () => {
    const missing = await app.agent.post(DOCTORS).set(app.auth(manager)).send({ name: 'Dr. Sem' }).expect(400);
    expect(errorOf(missing).details).toMatchObject({ fields: { responsibleId: expect.any(String) } });

    const ineligible = await app.agent
      .post(DOCTORS)
      .set(app.auth(manager))
      .send({ name: 'Dr. Att', responsibleId: attendant.id })
      .expect(400);
    expect(errorOf(ineligible).details).toMatchObject({ fields: { responsibleId: expect.any(String) } });

    for (const responsible of [carla, manager, admin]) {
      const ok = await app.agent
        .post(DOCTORS)
        .set(app.auth(manager))
        .send({ name: `Dr. De ${responsible.name}`, responsibleId: responsible.id })
        .expect(201);
      expect((ok.body as Doctor).responsible?.id).toBe(responsible.id);
    }
  });

  it('editar médico sem responsável (ou com atendente) exige atribuir na mesma edição', async () => {
    for (const id of [drOrphan, drAttendant]) {
      const blocked = await app.agent.patch(`${DOCTORS}/${id}`).set(app.auth(manager)).send({ clinic: 'X' }).expect(400);
      expect(errorOf(blocked).details).toMatchObject({ fields: { responsibleId: expect.any(String) } });
      const fixed = await app.agent
        .patch(`${DOCTORS}/${id}`)
        .set(app.auth(manager))
        .send({ clinic: 'X', responsibleId: carla.id })
        .expect(200);
      expect((fixed.body as Doctor).responsible?.id).toBe(carla.id);
    }
  });

  it('responsável inativo e inalterado continua tolerado (D-255 item 9)', async () => {
    await db.withoutTenant((tx) => tx.query('UPDATE users SET is_active = FALSE WHERE id = $1', [diego.id]));
    await app.agent.patch(`${DOCTORS}/${drDiego}`).set(app.auth(manager)).send({ clinic: 'Y' }).expect(200);
  });

  it('atendente não pode ser responsável por visita', async () => {
    const response = await app.agent
      .post(VISITS)
      .set(app.auth(manager))
      .send({ doctorId: drCarla, responsibleId: attendant.id, scheduledAt: '2026-01-20T13:00:00.000Z', type: 'presencial', purposeId: purposeA })
      .expect(400);
    expect(errorOf(response).details).toMatchObject({ fields: { responsibleId: expect.any(String) } });
  });
});

describe('carteiras (GET /doctors/portfolios)', () => {
  it('uma linha por representante/elegível com médicos; o resto em "unassigned"', async () => {
    // Representante ativo sem médico também aparece (zerado).
    const empty = await createUser({ tenantId: tenantA.id, role: 'representative', name: 'Zeca Rep', db });
    const body = (await app.agent.get(`${DOCTORS}/portfolios`).set(app.auth(manager)).expect(200))
      .body as ListDoctorPortfoliosResponse;
    expect(body.portfolios).toEqual([
      { responsible: { id: carla.id, name: 'Carla Rep', role: 'representative' }, doctorCount: 1, activeDoctorCount: 1 },
      { responsible: { id: diego.id, name: 'Diego Rep', role: 'representative' }, doctorCount: 1, activeDoctorCount: 1 },
      { responsible: { id: empty.id, name: 'Zeca Rep', role: 'representative' }, doctorCount: 0, activeDoctorCount: 0 },
    ]);
    // Órfão + atendente; a chave `abc` só vem com o CRMLAB-188.
    expect(body.unassigned).toEqual({ doctorCount: 2, activeDoctorCount: 2 });
  });

  it('não conta médico de outro tenant', async () => {
    const body = (await app.agent.get(`${DOCTORS}/portfolios`).set(app.auth(admin)).expect(200))
      .body as ListDoctorPortfoliosResponse;
    expect(JSON.stringify(body)).not.toContain(repB.id);
  });
});

describe('transferência em lote (POST /doctors/transfer)', () => {
  it('move os médicos e, com includeFutureVisits, as visitas futuras do dono anterior', async () => {
    const response = await app.agent
      .post(`${DOCTORS}/transfer`)
      .set(app.auth(manager))
      .send({ doctorIds: [drDiego], toUserId: carla.id, includeFutureVisits: true })
      .expect(200);
    expect(response.body as TransferDoctorsResponse).toEqual({ transferredDoctors: 1, movedVisits: 1 });

    const doctor = (await app.agent.get(`${DOCTORS}/${drDiego}`).set(app.auth(carla)).expect(200)).body as Doctor;
    expect(doctor.responsible?.id).toBe(carla.id);

    const future = (await app.agent.get(`${VISITS}/${vDiegoFuture}`).set(app.auth(manager)).expect(200))
      .body as VisitDetail;
    expect(future.responsible?.id).toBe(carla.id);
    // A passada fica com quem fez.
    const past = (await app.agent.get(`${VISITS}/${vDiego}`).set(app.auth(manager)).expect(200)).body as VisitDetail;
    expect(past.responsible?.id).toBe(diego.id);

    const doctorAudit = await auditOf('doctor', drDiego);
    expect(doctorAudit).toEqual([
      {
        action: 'transfer_doctor',
        old_values: { responsibleId: diego.id },
        new_values: { responsibleId: carla.id, movedVisitIds: [vDiegoFuture] },
      },
    ]);
    const visitAudit = await auditOf('visit', vDiegoFuture);
    expect(visitAudit).toMatchObject([
      { action: 'transfer_visit', old_values: { responsibleId: diego.id }, new_values: { responsibleId: carla.id } },
    ]);
  });

  it('sem includeFutureVisits as visitas ficam; médico que já é do destino é ignorado', async () => {
    const response = await app.agent
      .post(`${DOCTORS}/transfer`)
      .set(app.auth(admin))
      .send({ doctorIds: [drDiego, drCarla], toUserId: carla.id })
      .expect(200);
    expect(response.body as TransferDoctorsResponse).toEqual({ transferredDoctors: 1, movedVisits: 0 });
    const future = (await app.agent.get(`${VISITS}/${vDiegoFuture}`).set(app.auth(manager)).expect(200))
      .body as VisitDetail;
    expect(future.responsible?.id).toBe(diego.id);
    expect(await auditOf('doctor', drCarla)).toEqual([]);
  });

  it('atribui os médicos sem responsável', async () => {
    await app.agent
      .post(`${DOCTORS}/transfer`)
      .set(app.auth(manager))
      .send({ doctorIds: [drOrphan, drAttendant], toUserId: diego.id, includeFutureVisits: true })
      .expect(200);
    const body = (await app.agent.get(`${DOCTORS}?unassigned=true`).set(app.auth(manager)).expect(200))
      .body as ListDoctorsResponse;
    expect(body.doctors).toEqual([]);
  });

  it('médico de outro tenant → 404 e nada muda (tudo ou nada)', async () => {
    const response = await app.agent
      .post(`${DOCTORS}/transfer`)
      .set(app.auth(manager))
      .send({ doctorIds: [drDiego, drB], toUserId: carla.id })
      .expect(404);
    expect(errorOf(response).code).toBe('NOT_FOUND');
    const doctor = (await app.agent.get(`${DOCTORS}/${drDiego}`).set(app.auth(manager)).expect(200)).body as Doctor;
    expect(doctor.responsible?.id).toBe(diego.id);
  });

  it('destino inelegível, inativo ou de outro tenant → VALIDATION_ERROR em toUserId', async () => {
    const inactive = await createUser({ tenantId: tenantA.id, role: 'representative', isActive: false, db });
    for (const toUserId of [attendant.id, inactive.id, repB.id]) {
      const response = await app.agent
        .post(`${DOCTORS}/transfer`)
        .set(app.auth(manager))
        .send({ doctorIds: [drDiego], toUserId })
        .expect(400);
      expect(errorOf(response).details).toMatchObject({ fields: { toUserId: expect.any(String) } });
    }
  });

  it('id repetido ou lista vazia → VALIDATION_ERROR', async () => {
    await app.agent
      .post(`${DOCTORS}/transfer`)
      .set(app.auth(manager))
      .send({ doctorIds: [drDiego, drDiego], toUserId: carla.id })
      .expect(400);
    await app.agent.post(`${DOCTORS}/transfer`).set(app.auth(manager)).send({ doctorIds: [], toUserId: carla.id }).expect(400);
  });
});

describe('isolamento entre laboratórios', () => {
  it('representante de outro tenant não alcança médico nem visita de A (404)', async () => {
    await app.agent.get(`${DOCTORS}/${drCarla}`).set(app.auth(repB)).expect(404);
    await app.agent.get(`${VISITS}/${vCarla}`).set(app.auth(repB)).expect(404);
    const list = (await app.agent.get(DOCTORS).set(app.auth(repB)).expect(200)).body as ListDoctorsResponse;
    expect(list.doctors.map((d) => d.id)).toEqual([drB]);
  });

  it('representante de A não alcança o médico de B nem com o próprio id de usuário', async () => {
    await app.agent.get(`${DOCTORS}/${drB}`).set(app.auth(carla)).expect(404);
  });
});
