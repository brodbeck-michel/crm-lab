/**
 * `GET /api/v1/doctors/lookup` — API_CONTRACTS.md §13, D-329 item 12.
 *
 * Busca do formulario de proposta (`DoctorPicker`, CRMLAB-188): todo papel do
 * laboratorio (inclusive a atendente, que nao entra na Visitacao), sem recorte
 * de carteira, so medicos ativos do proprio tenant e so o shape minimo.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, Doctor, DoctorLookupResponse } from '@crm-lab/shared';
import { doctorModule } from '../../src/controllers/doctor.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const BASE = '/api/v1/doctors';
const LOOKUP = `${BASE}/lookup`;

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let managerA: UserRecord;
let attendantA: UserRecord;
let repA: UserRecord;
let repA2: UserRecord;
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
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
  repA = await createUser({ tenantId: tenantA.id, role: 'representative', db });
  repA2 = await createUser({ tenantId: tenantA.id, role: 'representative', db });
  managerB = await createUser({ tenantId: tenantB.id, role: 'manager', db });
});

async function createDoctor(user: UserRecord, body: Record<string, unknown>): Promise<Doctor> {
  const res = await app.agent.post(BASE).set(app.auth(user)).send(body);
  expect(res.status).toBe(201);
  return res.body as Doctor;
}

async function lookup(user: UserRecord, query: Record<string, string>) {
  return app.agent.get(LOOKUP).query(query).set(app.auth(user));
}

describe('GET /doctors/lookup', () => {
  it('atendente busca por nome e recebe só o shape mínimo', async () => {
    const julia = await createDoctor(managerA, {
      name: 'Dra. Júlia Costa',
      crm: '12345',
      crmUf: 'SC',
      phone: '(48) 99999-0000',
      responsibleId: repA.id,
    });

    const res = await lookup(attendantA, { search: 'julia' });
    expect(res.status).toBe(200);
    const body = res.body as DoctorLookupResponse;
    expect(body.doctors).toEqual([
      { id: julia.id, name: 'Dra. Júlia Costa', crm: '12345', crmUf: 'SC', specialty: null },
    ]);
  });

  it('acha pelos dígitos do CRM', async () => {
    await createDoctor(managerA, { name: 'Dr. Pedro', crm: '98765', crmUf: 'SC', responsibleId: repA.id });
    const res = await lookup(attendantA, { search: '98.765' });
    expect((res.body as DoctorLookupResponse).doctors.map((d) => d.name)).toEqual(['Dr. Pedro']);
  });

  it('representante acha médico de outra carteira (sem recorte)', async () => {
    await createDoctor(managerA, { name: 'Dr. Outra Carteira', responsibleId: repA2.id });
    const res = await lookup(repA, { search: 'outra' });
    expect(res.status).toBe(200);
    expect((res.body as DoctorLookupResponse).doctors.map((d) => d.name)).toEqual(['Dr. Outra Carteira']);
  });

  it('só ativos e só do próprio laboratório', async () => {
    const inativo = await createDoctor(managerA, { name: 'Dr. Silva Inativo', responsibleId: repA.id });
    await app.agent.post(`${BASE}/${inativo.id}/inactivate`).set(app.auth(managerA)).expect(200);
    await createDoctor(managerB, { name: 'Dr. Silva do Lab B', responsibleId: managerB.id });
    await createDoctor(managerA, { name: 'Dr. Silva Ativo', responsibleId: repA.id });

    const res = await lookup(attendantA, { search: 'silva' });
    expect((res.body as DoctorLookupResponse).doctors.map((d) => d.name)).toEqual(['Dr. Silva Ativo']);
  });

  it('respeita o limit e ordena por nome', async () => {
    for (const name of ['Dr. Souza C', 'Dr. Souza A', 'Dr. Souza B']) {
      await createDoctor(managerA, { name, responsibleId: repA.id });
    }
    const res = await lookup(attendantA, { search: 'souza', limit: '2' });
    expect((res.body as DoctorLookupResponse).doctors.map((d) => d.name)).toEqual(['Dr. Souza A', 'Dr. Souza B']);
  });

  it('termo curto ou limit fora da faixa: 400 VALIDATION_ERROR', async () => {
    const queries: Array<Record<string, string>> = [{ search: 'a' }, {}, { search: 'souza', limit: '21' }];
    for (const query of queries) {
      const res = await lookup(attendantA, query);
      expect(res.status).toBe(400);
      expect((res.body as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('atendente continua sem a lista de médicos da Visitação (403)', async () => {
    const res = await app.agent.get(BASE).set(app.auth(attendantA));
    expect(res.status).toBe(403);
  });

  it('platform_operator: 403', async () => {
    const plataforma = await createTenant({ name: 'Plataforma', slug: 'plataforma', db });
    const operator = await createUser({ tenantId: plataforma.id, role: 'platform_operator', db });
    const res = await lookup(operator, { search: 'julia' });
    expect(res.status).toBe(403);
  });
});
