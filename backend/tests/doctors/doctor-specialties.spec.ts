/**
 * `/api/v1/doctors/specialties` — API_CONTRACTS.md §13 (CRMLAB-188, D-328 item 1).
 *
 * Foco: semeadura da lista padrao no primeiro GET, nome unico sem
 * acento/caixa (`DOCTOR_SPECIALTY_ALREADY_EXISTS`), so gestor/admin escrevem,
 * renomear regrava a coluna antiga dos medicos (escrita dupla), inativa some
 * do cadastro novo mas quem ja usa continua, e isolamento multitenant.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DOCTOR_SPECIALTIES,
  type ApiErrorBody,
  type Doctor,
  type DoctorSpecialty,
  type ListDoctorSpecialtiesResponse,
} from '@crm-lab/shared';
import { doctorModule } from '../../src/controllers/doctor.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const BASE = '/api/v1/doctors/specialties';

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let managerA: UserRecord;
let adminA: UserRecord;
let attendantA: UserRecord;
let managerB: UserRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [doctorModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', db });
  adminA = await createUser({ tenantId: tenantA.id, role: 'admin', db });
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
  managerB = await createUser({ tenantId: tenantB.id, role: 'manager', db });
});

function errorOf(response: { body: unknown }) {
  return (response.body as ApiErrorBody).error;
}

async function list(user: UserRecord, query = ''): Promise<DoctorSpecialty[]> {
  const res = await app.agent.get(`${BASE}${query}`).set(app.auth(user)).expect(200);
  return (res.body as ListDoctorSpecialtiesResponse).specialties;
}

async function createSpecialty(user: UserRecord, name: string): Promise<DoctorSpecialty> {
  const res = await app.agent.post(BASE).set(app.auth(user)).send({ name }).expect(201);
  return res.body as DoctorSpecialty;
}

describe('GET /doctors/specialties', () => {
  it('semeia a lista padrão no primeiro acesso, em ordem de nome, e não duplica', async () => {
    const first = await list(attendantA);
    expect(first).toHaveLength(DEFAULT_DOCTOR_SPECIALTIES.length);
    expect(first.map((s) => s.name)).toContain('Cardiologia');
    expect(first.every((s) => s.isActive)).toBe(true);
    expect(first[0]?.name).toBe('Acupuntura');

    const second = await list(attendantA);
    expect(second).toHaveLength(DEFAULT_DOCTOR_SPECIALTIES.length);
  });

  it('não semeia de novo quem já tem especialidade, e filtra por ativa', async () => {
    const own = await createSpecialty(managerA, 'Medicina Funcional');
    await app.agent.patch(`${BASE}/${own.id}`).set(app.auth(managerA)).send({ isActive: false }).expect(200);
    expect(await list(attendantA)).toHaveLength(1);
    expect(await list(attendantA, '?active=true')).toHaveLength(0);
    expect(await list(attendantA, '?active=false')).toHaveLength(1);
  });

  it('lista de um laboratório nunca aparece no outro', async () => {
    await createSpecialty(managerA, 'Só do A');
    const b = await list(managerB);
    expect(b.map((s) => s.name)).not.toContain('Só do A');
  });
});

describe('POST /doctors/specialties', () => {
  it('gestor e admin criam (nome aparado e com espaços colapsados); atendente recebe 403', async () => {
    const created = await createSpecialty(managerA, '  Medicina   Funcional ');
    expect(created).toMatchObject({ name: 'Medicina Funcional', isActive: true });
    await createSpecialty(adminA, 'Fisiatria');

    const denied = await app.agent.post(BASE).set(app.auth(attendantA)).send({ name: 'X' });
    expect(denied.status).toBe(403);
    expect(errorOf(denied).code).toBe('FORBIDDEN');
  });

  it('mesmo nome sem acento/caixa -> 409 com a existente, inclusive inativa', async () => {
    const existing = await createSpecialty(managerA, 'Clínica Médica');
    const dup = await app.agent.post(BASE).set(app.auth(managerA)).send({ name: 'clinica  medica' });
    expect(dup.status).toBe(409);
    expect(errorOf(dup).code).toBe('DOCTOR_SPECIALTY_ALREADY_EXISTS');
    expect(errorOf(dup).details).toMatchObject({ existingSpecialty: { id: existing.id, name: 'Clínica Médica' } });

    await app.agent.patch(`${BASE}/${existing.id}`).set(app.auth(managerA)).send({ isActive: false }).expect(200);
    const dupInactive = await app.agent.post(BASE).set(app.auth(managerA)).send({ name: 'CLÍNICA MÉDICA' });
    expect(dupInactive.status).toBe(409);
  });

  it('o mesmo nome em outro laboratório é permitido; nome vazio -> 400', async () => {
    await createSpecialty(managerA, 'Fisiatria');
    await createSpecialty(managerB, 'Fisiatria');
    await app.agent.post(BASE).set(app.auth(managerA)).send({ name: '   ' }).expect(400);
  });

  it('grava audit create_doctor_specialty', async () => {
    const created = await createSpecialty(managerA, 'Fisiatria');
    const rows = await db.withoutTenant((tx) =>
      tx.query<{ action: string; new_values: Record<string, unknown> }>(
        `SELECT action, new_values FROM audit_logs WHERE entity_type = 'doctor_specialty' AND entity_id = $1`,
        [created.id],
      ),
    );
    expect(rows.rows).toEqual([{ action: 'create_doctor_specialty', new_values: { name: 'Fisiatria' } }]);
  });
});

describe('PATCH /doctors/specialties/:id', () => {
  it('renomear atualiza o nome que os médicos mostram e a coluna antiga (escrita dupla)', async () => {
    const specialty = await createSpecialty(managerA, 'Cardio');
    const doctor = await app.agent
      .post('/api/v1/doctors')
      .set(app.auth(attendantA))
      .send({ name: 'Dr. C', specialtyId: specialty.id })
      .expect(201);
    expect((doctor.body as Doctor).specialty).toBe('Cardio');

    await app.agent.patch(`${BASE}/${specialty.id}`).set(app.auth(managerA)).send({ name: 'Cardiologia' }).expect(200);

    const after = await app.agent.get(`/api/v1/doctors/${(doctor.body as Doctor).id}`).set(app.auth(attendantA)).expect(200);
    expect((after.body as Doctor).specialty).toBe('Cardiologia');
    const legacy = await db.withoutTenant((tx) =>
      tx.query<{ specialty: string }>('SELECT specialty FROM doctors WHERE id = $1', [(doctor.body as Doctor).id]),
    );
    expect(legacy.rows[0]?.specialty).toBe('Cardiologia');
  });

  it('renomear para nome de outra -> 409; trocar só a caixa da própria vale', async () => {
    await createSpecialty(managerA, 'Pediatria');
    const other = await createSpecialty(managerA, 'Neonatologia');
    const res = await app.agent.patch(`${BASE}/${other.id}`).set(app.auth(managerA)).send({ name: 'pediatria' });
    expect(res.status).toBe(409);
    const ok = await app.agent.patch(`${BASE}/${other.id}`).set(app.auth(managerA)).send({ name: 'NEONATOLOGIA' });
    expect(ok.status).toBe(200);
    expect((ok.body as DoctorSpecialty).name).toBe('NEONATOLOGIA');
  });

  it('inativa: não entra em médico novo, mas quem já usa continua editável', async () => {
    const specialty = await createSpecialty(managerA, 'Homeopatia');
    const doctor = (
      await app.agent.post('/api/v1/doctors').set(app.auth(attendantA)).send({ name: 'Dr. H', specialtyId: specialty.id })
    ).body as Doctor;
    await app.agent.patch(`${BASE}/${specialty.id}`).set(app.auth(managerA)).send({ isActive: false }).expect(200);

    const novo = await app.agent
      .post('/api/v1/doctors')
      .set(app.auth(attendantA))
      .send({ name: 'Dr. Novo', specialtyId: specialty.id });
    expect(novo.status).toBe(400);
    expect(errorOf(novo).details).toMatchObject({ fields: { specialtyId: expect.any(String) as unknown } });

    const edit = await app.agent
      .patch(`/api/v1/doctors/${doctor.id}`)
      .set(app.auth(attendantA))
      .send({ specialtyId: specialty.id, clinic: 'Clínica H' })
      .expect(200);
    expect((edit.body as Doctor).specialty).toBe('Homeopatia');
  });

  it('atendente -> 403; outro laboratório ou inexistente -> 404', async () => {
    const specialty = await createSpecialty(managerA, 'Geriatria');
    await app.agent.patch(`${BASE}/${specialty.id}`).set(app.auth(attendantA)).send({ isActive: false }).expect(403);
    const cross = await app.agent.patch(`${BASE}/${specialty.id}`).set(app.auth(managerB)).send({ isActive: false });
    expect(cross.status).toBe(404);
    expect(errorOf(cross).code).toBe('NOT_FOUND');
  });

  it('médico não aceita especialidade de outro laboratório', async () => {
    const specialtyB = await createSpecialty(managerB, 'Do B');
    const res = await app.agent
      .post('/api/v1/doctors')
      .set(app.auth(attendantA))
      .send({ name: 'Dr. X', specialtyId: specialtyB.id });
    expect(res.status).toBe(400);
    expect(errorOf(res).details).toMatchObject({ fields: { specialtyId: expect.any(String) as unknown } });
  });

  it('RLS: contexto de A não vê a lista de B', async () => {
    await createSpecialty(managerB, 'Do B');
    const rows = await db.withTenant(tenantA.id, (tx) =>
      tx.query('SELECT id FROM doctor_specialties WHERE tenant_id = $1', [tenantB.id]),
    );
    expect(rows.rows).toHaveLength(0);
    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query(
          `INSERT INTO doctor_specialties (tenant_id, name, normalized_name) VALUES ($1, 'Invasora', 'invasora')`,
          [tenantB.id],
        ),
      ),
    ).rejects.toThrow();
  });
});
