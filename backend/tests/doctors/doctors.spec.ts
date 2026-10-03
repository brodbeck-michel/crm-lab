/**
 * `/api/v1/doctors` — API_CONTRACTS.md §13 (CRMLAB-86, D-255).
 *
 * Foco: validacao e normalizacao de CRM/UF, unicidade (tenant, CRM, UF) com o
 * codigo proprio `DOCTOR_CRM_ALREADY_EXISTS`, responsavel do MESMO laboratorio,
 * isolamento multitenant (medico de outro tenant -> 404, nunca 403), todos os
 * papeis escrevem e o audit log de criar/editar/inativar/reativar.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, Doctor, DoctorCrmConflictDetails, ListDoctorsResponse } from '@crm-lab/shared';
import { doctorModule } from '../../src/controllers/doctor.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const BASE = '/api/v1/doctors';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000001';

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let adminA: UserRecord;
let managerA: UserRecord;
let attendantA: UserRecord;
let attendantB: UserRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [doctorModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  adminA = await createUser({ tenantId: tenantA.id, role: 'admin', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', name: 'Gestora Ana', db });
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
  attendantB = await createUser({ tenantId: tenantB.id, role: 'attendant', db });
});

async function create(user: UserRecord, body: Record<string, unknown>) {
  return app.agent.post(BASE).set(app.auth(user)).send(body);
}

async function createOk(user: UserRecord, body: Record<string, unknown>): Promise<Doctor> {
  const response = await create(user, body);
  expect(response.status).toBe(201);
  return response.body as Doctor;
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
       WHERE entity_type = 'doctor' AND entity_id = $1 ORDER BY timestamp, action`,
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
    await app.agent.get(BASE).expect(401);
    await app.agent.post(BASE).send({ name: 'X' }).expect(401);
  });

  it('platform_operator recebe 403 FORBIDDEN em todas as rotas', async () => {
    const plataforma = await createTenant({ name: 'Plataforma', slug: 'plataforma', db });
    const operator = await createUser({ tenantId: plataforma.id, role: 'platform_operator', db });
    const headers = app.auth(operator);
    const responses = [
      await app.agent.get(BASE).set(headers),
      await app.agent.get(`${BASE}/${UNKNOWN_ID}`).set(headers),
      await app.agent.post(BASE).set(headers).send({ name: 'X' }),
      await app.agent.patch(`${BASE}/${UNKNOWN_ID}`).set(headers).send({ name: 'Y' }),
      await app.agent.post(`${BASE}/${UNKNOWN_ID}/inactivate`).set(headers),
      await app.agent.post(`${BASE}/${UNKNOWN_ID}/reactivate`).set(headers),
    ];
    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(errorOf(res).code).toBe('FORBIDDEN');
    }
  });

  it('atendente, gestor e admin cadastram, editam e inativam (sem perfil novo)', async () => {
    for (const user of [attendantA, managerA, adminA]) {
      const doctor = await createOk(user, { name: `Dr. ${user.role}` });
      await app.agent.patch(`${BASE}/${doctor.id}`).set(app.auth(user)).send({ specialty: 'Clínica' }).expect(200);
      await app.agent.post(`${BASE}/${doctor.id}/inactivate`).set(app.auth(user)).expect(200);
      await app.agent.post(`${BASE}/${doctor.id}/reactivate`).set(app.auth(user)).expect(200);
    }
  });
});

describe('POST /doctors — validação e normalização', () => {
  it('201 com o objeto cru; CRM só dígitos, UF maiúscula, vazio vira null', async () => {
    const doctor = await createOk(attendantA, {
      name: '  Dra. Júlia Costa ',
      crm: 'CRM 12.345',
      crmUf: ' sc',
      specialty: 'Ginecologia',
      clinic: 'Clínica Vida',
      phone: '(48) 99999-0000',
      email: 'julia@clinica.com.br',
      contactName: 'Marta (secretária)',
      visitPreference: 'Terças à tarde',
      notes: '   ',
      address: '',
    });
    expect(doctor).toMatchObject({
      name: 'Dra. Júlia Costa',
      crm: '12345',
      crmUf: 'SC',
      specialty: 'Ginecologia',
      clinic: 'Clínica Vida',
      phone: '(48) 99999-0000',
      email: 'julia@clinica.com.br',
      contactName: 'Marta (secretária)',
      visitPreference: 'Terças à tarde',
      notes: null,
      address: null,
      responsible: null,
      isActive: true,
    });
    expect(doctor).not.toHaveProperty('doctors');
  });

  it('só o nome é obrigatório', async () => {
    const doctor = await createOk(attendantA, { name: 'Dr. Sem CRM' });
    expect(doctor.crm).toBeNull();
    expect(doctor.crmUf).toBeNull();

    const semNome = await create(attendantA, { name: '   ' });
    expect(semNome.status).toBe(400);
    expect(errorOf(semNome).code).toBe('VALIDATION_ERROR');
  });

  it('CRM sem UF -> 400 em crmUf', async () => {
    const response = await create(attendantA, { name: 'Dr. X', crm: '123' });
    expect(response.status).toBe(400);
    expect(errorOf(response).details).toMatchObject({ fields: { crmUf: 'Informe a UF do CRM' } });
  });

  it('UF fora das 27 -> 400 em crmUf', async () => {
    const response = await create(attendantA, { name: 'Dr. X', crm: '123', crmUf: 'XX' });
    expect(response.status).toBe(400);
    expect(errorOf(response).details).toMatchObject({ fields: { crmUf: 'UF inválida' } });
  });

  it('CRM com mais de 10 dígitos -> 400 em crm', async () => {
    const response = await create(attendantA, { name: 'Dr. X', crm: '12345678901', crmUf: 'SC' });
    expect(response.status).toBe(400);
    expect(errorOf(response).details).toMatchObject({ fields: { crm: expect.any(String) } });
  });

  it('e-mail inválido -> 400; e-mail vazio é aceito como "sem e-mail"', async () => {
    const ruim = await create(attendantA, { name: 'Dr. X', email: 'nao-e-email' });
    expect(ruim.status).toBe(400);
    expect(errorOf(ruim).code).toBe('VALIDATION_ERROR');

    const vazio = await createOk(attendantA, { name: 'Dr. Y', email: '' });
    expect(vazio.email).toBeNull();
  });

  it('campo desconhecido (ex.: isActive) -> 400', async () => {
    const response = await create(attendantA, { name: 'Dr. X', isActive: false });
    expect(response.status).toBe(400);
  });
});

describe('unicidade de (tenant, CRM, UF)', () => {
  it('mesmo CRM e UF -> 409 DOCTOR_CRM_ALREADY_EXISTS com o médico existente', async () => {
    const first = await createOk(attendantA, { name: 'Dr. Primeiro', crm: '12345', crmUf: 'SC' });
    const response = await create(managerA, { name: 'Dr. Segundo', crm: '12.345', crmUf: 'sc' });

    expect(response.status).toBe(409);
    const error = errorOf(response);
    expect(error.code).toBe('DOCTOR_CRM_ALREADY_EXISTS');
    expect(error.details as unknown as DoctorCrmConflictDetails).toEqual({
      crm: '12345',
      crmUf: 'SC',
      existingDoctor: { id: first.id, name: 'Dr. Primeiro', isActive: true },
    });
  });

  it('duplicidade vale contra médico INATIVO (o caminho é reativar)', async () => {
    const first = await createOk(attendantA, { name: 'Dr. Inativo', crm: '777', crmUf: 'PR' });
    await app.agent.post(`${BASE}/${first.id}/inactivate`).set(app.auth(attendantA)).expect(200);

    const response = await create(attendantA, { name: 'Dr. Novo', crm: '777', crmUf: 'PR' });
    expect(response.status).toBe(409);
    expect((errorOf(response).details as unknown as DoctorCrmConflictDetails).existingDoctor.isActive).toBe(false);
  });

  it('mesmo CRM em outra UF, outro tenant ou vários sem CRM: tudo permitido', async () => {
    await createOk(attendantA, { name: 'Dr. SC', crm: '555', crmUf: 'SC' });
    await createOk(attendantA, { name: 'Dr. RS', crm: '555', crmUf: 'RS' });
    await createOk(attendantB, { name: 'Dr. SC do Lab B', crm: '555', crmUf: 'SC' });
    await createOk(attendantA, { name: 'Dr. Sem CRM 1' });
    await createOk(attendantA, { name: 'Dr. Sem CRM 2' });
  });

  it('PATCH para um CRM já usado -> 409; manter o próprio CRM não conflita', async () => {
    await createOk(attendantA, { name: 'Dr. Dono', crm: '100', crmUf: 'SC' });
    const other = await createOk(attendantA, { name: 'Dr. Outro', crm: '200', crmUf: 'SC' });

    const clash = await app.agent.patch(`${BASE}/${other.id}`).set(app.auth(attendantA)).send({ crm: '100' });
    expect(clash.status).toBe(409);
    expect(errorOf(clash).code).toBe('DOCTOR_CRM_ALREADY_EXISTS');

    await app.agent
      .patch(`${BASE}/${other.id}`)
      .set(app.auth(attendantA))
      .send({ crm: '200', crmUf: 'SC', name: 'Dr. Outro Renomeado' })
      .expect(200);
  });

  it('o índice único parcial segura a corrida mesmo sem passar pelo service', async () => {
    await createOk(attendantA, { name: 'Dr. A', crm: '900', crmUf: 'SC' });
    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query(`INSERT INTO doctors (tenant_id, name, crm, crm_uf) VALUES ($1, 'Dr. B', '900', 'SC')`, [
          tenantA.id,
        ]),
      ),
    ).rejects.toThrow();
  });
});

describe('PATCH /doctors/:id', () => {
  it('parcial: CRM com a UF que já existe; null limpa campo; CRM null limpa o par', async () => {
    const doctor = await createOk(attendantA, { name: 'Dr. P', crm: '1', crmUf: 'SC', specialty: 'Cardio' });

    const novoCrm = await app.agent.patch(`${BASE}/${doctor.id}`).set(app.auth(attendantA)).send({ crm: '2' });
    expect((novoCrm.body as Doctor).crmUf).toBe('SC');

    const limpo = await app.agent
      .patch(`${BASE}/${doctor.id}`)
      .set(app.auth(attendantA))
      .send({ specialty: null, crm: null, crmUf: null })
      .expect(200);
    expect(limpo.body as Doctor).toMatchObject({ specialty: null, crm: null, crmUf: null });
  });

  it('isActive no PATCH -> 400 (inativar tem rota própria)', async () => {
    const doctor = await createOk(attendantA, { name: 'Dr. P' });
    await app.agent.patch(`${BASE}/${doctor.id}`).set(app.auth(attendantA)).send({ isActive: false }).expect(400);
  });
});

describe('responsável pela carteira', () => {
  it('usuário ativo do laboratório: aceito e devolvido com o nome', async () => {
    const doctor = await createOk(attendantA, { name: 'Dr. R', responsibleId: managerA.id });
    expect(doctor.responsible).toEqual({ id: managerA.id, name: 'Gestora Ana' });
  });

  it('usuário de OUTRO laboratório -> 400 em responsibleId (nunca grava)', async () => {
    const response = await create(attendantA, { name: 'Dr. R', responsibleId: attendantB.id });
    expect(response.status).toBe(400);
    expect(errorOf(response).details).toMatchObject({ fields: { responsibleId: expect.any(String) } });
  });

  it('usuário inativo -> 400; mas o médico já ligado a ele segue editável', async () => {
    const doctor = await createOk(attendantA, { name: 'Dr. R', responsibleId: attendantA.id });
    const inativa = await createUser({ tenantId: tenantA.id, role: 'attendant', isActive: false, db });

    const response = await create(attendantA, { name: 'Dr. S', responsibleId: inativa.id });
    expect(response.status).toBe(400);

    await db.withoutTenant((tx) => tx.query('UPDATE users SET is_active = FALSE WHERE id = $1', [attendantA.id]));
    await app.agent
      .patch(`${BASE}/${doctor.id}`)
      .set(app.auth(managerA))
      .send({ name: 'Dr. R2', responsibleId: attendantA.id })
      .expect(200);
  });
});

describe('GET /doctors — busca, filtros e paginação', () => {
  beforeEach(async () => {
    await createOk(attendantA, { name: 'Dra. Júlia Costa', crm: '12345', crmUf: 'SC', responsibleId: managerA.id });
    await createOk(attendantA, { name: 'Dr. Marcos Lima', crm: '67890', crmUf: 'SC' });
    const inativo = await createOk(attendantA, { name: 'Dr. Antônio Inativo', responsibleId: managerA.id });
    await app.agent.post(`${BASE}/${inativo.id}/inactivate`).set(app.auth(attendantA)).expect(200);
  });

  async function list(query: Record<string, string | number | boolean>) {
    const response = await app.agent.get(BASE).query(query).set(app.auth(attendantA)).expect(200);
    return response.body as ListDoctorsResponse;
  }

  it('sem filtro: ativos e inativos, ordem por nome, envelope paginado', async () => {
    const body = await list({});
    expect(body.doctors.map((d) => d.name)).toEqual(['Dr. Antônio Inativo', 'Dr. Marcos Lima', 'Dra. Júlia Costa']);
    expect(body.pagination).toMatchObject({ page: 1, limit: 20, total: 3, totalPages: 1 });
  });

  it('busca por nome sem acento nem caixa, e por CRM com pontuação', async () => {
    expect((await list({ search: 'julia' })).doctors.map((d) => d.name)).toEqual(['Dra. Júlia Costa']);
    expect((await list({ search: 'antonio' })).doctors).toHaveLength(1);
    expect((await list({ search: '12.345' })).doctors.map((d) => d.name)).toEqual(['Dra. Júlia Costa']);
    expect((await list({ search: '678' })).doctors.map((d) => d.name)).toEqual(['Dr. Marcos Lima']);
  });

  it('filtros active e responsibleId', async () => {
    expect((await list({ active: true })).doctors).toHaveLength(2);
    expect((await list({ active: false })).doctors.map((d) => d.name)).toEqual(['Dr. Antônio Inativo']);
    expect((await list({ responsibleId: managerA.id, active: true })).doctors.map((d) => d.name)).toEqual([
      'Dra. Júlia Costa',
    ]);
  });

  it('paginação respeita limit', async () => {
    const body = await list({ limit: 2, page: 2 });
    expect(body.doctors).toHaveLength(1);
    expect(body.pagination).toMatchObject({ page: 2, limit: 2, total: 3, totalPages: 2 });
  });
});

describe('isolamento multitenant', () => {
  it('médico do tenant B: GET, PATCH, inativar e reativar -> 404 NOT_FOUND', async () => {
    const doctorB = await createOk(attendantB, { name: 'Dr. Confidencial B', crm: '1', crmUf: 'SC' });
    const headers = app.auth(attendantA);
    const responses = [
      await app.agent.get(`${BASE}/${doctorB.id}`).set(headers),
      await app.agent.patch(`${BASE}/${doctorB.id}`).set(headers).send({ name: 'Hack' }),
      await app.agent.post(`${BASE}/${doctorB.id}/inactivate`).set(headers),
      await app.agent.post(`${BASE}/${doctorB.id}/reactivate`).set(headers),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('NOT_FOUND');
      expect(JSON.stringify(res.body)).not.toContain('Confidencial');
    }

    const intact = await app.agent.get(`${BASE}/${doctorB.id}`).set(app.auth(attendantB)).expect(200);
    expect(intact.body as Doctor).toMatchObject({ name: 'Dr. Confidencial B', isActive: true });
  });

  it('listagem nunca cruza tenant, nem filtrando pelo responsável do outro', async () => {
    await createOk(attendantB, { name: 'Dr. Confidencial B', responsibleId: attendantB.id });
    await createOk(attendantA, { name: 'Dr. do A' });

    const all = await app.agent.get(BASE).set(app.auth(attendantA)).expect(200);
    expect((all.body as ListDoctorsResponse).doctors.map((d) => d.name)).toEqual(['Dr. do A']);

    const cross = await app.agent
      .get(BASE)
      .query({ responsibleId: attendantB.id })
      .set(app.auth(attendantA))
      .expect(200);
    expect((cross.body as ListDoctorsResponse).doctors).toHaveLength(0);
  });

  it('RLS: contexto de A não vê nem altera linha de B', async () => {
    const doctorB = await createOk(attendantB, { name: 'Dr. B' });
    const visible = await db.withTenant(tenantA.id, (tx) => tx.query('SELECT id FROM doctors'));
    expect(visible.rows).toHaveLength(0);

    await db.withTenant(tenantA.id, (tx) => tx.query(`UPDATE doctors SET name = 'hackeado'`));
    const b = await db.withoutTenant((tx) =>
      tx.query<{ name: string }>('SELECT name FROM doctors WHERE id = $1', [doctorB.id]),
    );
    expect(b.rows[0]?.name).toBe('Dr. B');

    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query(`INSERT INTO doctors (tenant_id, name) VALUES ($1, 'intruso')`, [tenantB.id]),
      ),
    ).rejects.toThrow();
  });

  it('id inexistente -> 404; id não-uuid -> 400', async () => {
    await app.agent.get(`${BASE}/${UNKNOWN_ID}`).set(app.auth(attendantA)).expect(404);
    await app.agent.get(`${BASE}/nao-e-uuid`).set(app.auth(attendantA)).expect(400);
  });
});

describe('inativar / reativar', () => {
  it('idempotente: segunda chamada devolve 200 sem novo audit', async () => {
    const doctor = await createOk(attendantA, { name: 'Dr. I' });
    const first = await app.agent.post(`${BASE}/${doctor.id}/inactivate`).set(app.auth(attendantA)).expect(200);
    expect((first.body as Doctor).isActive).toBe(false);
    await app.agent.post(`${BASE}/${doctor.id}/inactivate`).set(app.auth(attendantA)).expect(200);
    await app.agent.post(`${BASE}/${doctor.id}/reactivate`).set(app.auth(attendantA)).expect(200);
    await app.agent.post(`${BASE}/${doctor.id}/reactivate`).set(app.auth(attendantA)).expect(200);

    const actions = (await auditOf(doctor.id)).map((row) => row.action);
    expect(actions.filter((a) => a === 'inactivate_doctor')).toHaveLength(1);
    expect(actions.filter((a) => a === 'reactivate_doctor')).toHaveLength(1);
  });
});

describe('audit log', () => {
  it('create_doctor, update_doctor (só o que mudou), inactivate_doctor e reactivate_doctor', async () => {
    const doctor = await createOk(attendantA, { name: 'Dr. Audit', crm: '42', crmUf: 'SC' });
    await app.agent
      .patch(`${BASE}/${doctor.id}`)
      .set(app.auth(managerA))
      .send({ name: 'Dr. Audit', specialty: 'Pediatria', responsibleId: managerA.id })
      .expect(200);
    // PATCH sem mudança real não gera audit.
    await app.agent.patch(`${BASE}/${doctor.id}`).set(app.auth(managerA)).send({ specialty: 'Pediatria' }).expect(200);
    await app.agent.post(`${BASE}/${doctor.id}/inactivate`).set(app.auth(adminA)).expect(200);
    await app.agent.post(`${BASE}/${doctor.id}/reactivate`).set(app.auth(adminA)).expect(200);

    const rows = await auditOf(doctor.id);
    expect(rows.map((r) => r.action).sort()).toEqual(
      ['create_doctor', 'inactivate_doctor', 'reactivate_doctor', 'update_doctor'].sort(),
    );
    for (const row of rows) expect(row.tenant_id).toBe(tenantA.id);

    const created = rows.find((r) => r.action === 'create_doctor');
    expect(created?.user_id).toBe(attendantA.id);
    expect(created?.new_values).toMatchObject({ name: 'Dr. Audit', crm: '42', crmUf: 'SC' });

    const updated = rows.find((r) => r.action === 'update_doctor');
    expect(updated?.user_id).toBe(managerA.id);
    expect(updated?.old_values).toEqual({ specialty: null, responsibleId: null });
    expect(updated?.new_values).toEqual({ specialty: 'Pediatria', responsibleId: managerA.id });

    expect(rows.find((r) => r.action === 'inactivate_doctor')?.new_values).toEqual({ isActive: false });
  });
});
