/**
 * Cadastro ampliado do medico — API_CONTRACTS.md §13 "Cadastro ampliado"
 * (CRMLAB-188, D-328). Campos novos, validacoes entre campos (sobre o estado
 * DEPOIS do merge), escrita dupla nas colunas antigas, filtros novos e o
 * trigger de `updated_at` que ignora a curva ABC.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, Doctor, DoctorSpecialty, ListDoctorsResponse } from '@crm-lab/shared';
import { doctorModule } from '../../src/controllers/doctor.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const BASE = '/api/v1/doctors';

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let repA: UserRecord;
let managerA: UserRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [doctorModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  repA = await createUser({ tenantId: tenantA.id, role: 'representative', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', db });
});

function fieldsOf(response: { body: unknown }): Record<string, string> {
  const details = (response.body as ApiErrorBody).error.details as { fields?: Record<string, string> } | undefined;
  return details?.fields ?? {};
}

async function create(body: Record<string, unknown>) {
  return app.agent.post(BASE).set(app.auth(repA)).send(body);
}

async function createOk(body: Record<string, unknown>): Promise<Doctor> {
  const res = await create(body);
  expect(res.status).toBe(201);
  return res.body as Doctor;
}

async function patch(id: string, body: Record<string, unknown>) {
  return app.agent.patch(`${BASE}/${id}`).set(app.auth(repA)).send(body);
}

async function specialty(name: string): Promise<DoctorSpecialty> {
  const res = await app.agent.post(`${BASE}/specialties`).set(app.auth(managerA)).send({ name }).expect(201);
  return res.body as DoctorSpecialty;
}

describe('campos novos', () => {
  it('grava e devolve todos os campos do cadastro ampliado, normalizados', async () => {
    const cardio = await specialty('Cardiologia');
    const doctor = await createOk({
      name: 'Dra. Ana',
      specialtyId: cardio.id,
      birthDay: 14,
      birthMonth: 3,
      acceptsPrivate: true,
      monthlyConsultations: 300,
      monthlyPrivateConsultations: 120,
      consultationFee: 350.5,
      visitHours: [{ weekdays: [4, 2, 2], start: '13:30', end: '15:00' }],
      visitPreference: 'Evitar segunda',
      isPartner: true,
      partnerSince: '2025-03-01',
      partnershipNotes: 'Indica check-up',
      addressZip: '88701-100',
      addressStreet: 'Rua Lauro Müller',
      addressNumber: '100',
      addressComplement: '',
      addressDistrict: 'Centro',
      addressCity: 'Tubarão',
      addressState: 'sc',
      secretaryName: ' Marta ',
      secretaryBirthDay: 29,
      secretaryBirthMonth: 2,
      secretaryPhone: '(48) 98888-0000',
      secretaryNotes: 'Prefere WhatsApp',
    });
    expect(doctor).toMatchObject({
      specialtyId: cardio.id,
      specialty: 'Cardiologia',
      birthDay: 14,
      birthMonth: 3,
      birthYear: null,
      acceptsPrivate: true,
      monthlyConsultations: 300,
      monthlyPrivateConsultations: 120,
      consultationFee: 350.5,
      visitHours: [{ weekdays: [2, 4], start: '13:30', end: '15:00' }],
      isPartner: true,
      partnerSince: '2025-03-01',
      addressZip: '88701100',
      addressComplement: null,
      addressState: 'SC',
      secretaryName: 'Marta',
      secretaryBirthDay: 29,
      secretaryBirthMonth: 2,
      contactName: 'Marta',
      abcClass: null,
      abcBaseValue: null,
      abcCalculatedAt: null,
    });
    expect(typeof doctor.consultationFee).toBe('number');

    // Escrita dupla: as colunas antigas acompanham.
    const legacy = await db.withoutTenant((tx) =>
      tx.query<{ specialty: string; contact_name: string }>(
        'SELECT specialty, contact_name FROM doctors WHERE id = $1',
        [doctor.id],
      ),
    );
    expect(legacy.rows[0]).toEqual({ specialty: 'Cardiologia', contact_name: 'Marta' });
  });

  it('padrões de um cadastro só com nome', async () => {
    const doctor = await createOk({ name: 'Dr. Mínimo' });
    expect(doctor).toMatchObject({
      specialtyId: null,
      acceptsPrivate: null,
      visitHours: [],
      isPartner: false,
      addressZip: null,
      secretaryName: null,
    });
  });

  it('specialty (texto) e contactName não entram mais; abc* nem pensar', async () => {
    expect((await create({ name: 'X', specialty: 'Cardio' })).status).toBe(400);
    expect((await create({ name: 'X', contactName: 'Marta' })).status).toBe(400);
    expect((await create({ name: 'X', abcClass: 'A' })).status).toBe(400);
  });

  it('especialidade vazia (null) limpa as duas colunas', async () => {
    const cardio = await specialty('Cardiologia');
    const doctor = await createOk({ name: 'Dr. C', specialtyId: cardio.id });
    const res = await patch(doctor.id, { specialtyId: null });
    expect(res.status).toBe(200);
    expect(res.body as Doctor).toMatchObject({ specialtyId: null, specialty: null });
  });
});

describe('validações', () => {
  it('aniversário: dia sem mês, data impossível, ano sem dia, ano futuro', async () => {
    expect(fieldsOf(await create({ name: 'X', birthDay: 10 }))).toHaveProperty('birthDay');
    expect(fieldsOf(await create({ name: 'X', birthDay: 31, birthMonth: 4 }))).toHaveProperty('birthDay');
    expect(fieldsOf(await create({ name: 'X', birthDay: 29, birthMonth: 2, birthYear: 2023 }))).toHaveProperty('birthDay');
    expect(fieldsOf(await create({ name: 'X', birthYear: 1980 }))).toHaveProperty('birthYear');
    expect(fieldsOf(await create({ name: 'X', birthDay: 1, birthMonth: 1, birthYear: 3000 }))).toHaveProperty('birthYear');
    expect(fieldsOf(await create({ name: 'X', secretaryBirthMonth: 5 }))).toHaveProperty('secretaryBirthDay');
    // 29/02 sem ano e 29/02 em ano bissexto valem.
    await createOk({ name: 'Y', birthDay: 29, birthMonth: 2 });
    await createOk({ name: 'Z', birthDay: 29, birthMonth: 2, birthYear: 1984 });
  });

  it('PATCH valida o par com o que já está gravado', async () => {
    const doctor = await createOk({ name: 'Dr. P', birthDay: 10, birthMonth: 5 });
    // só o mês, mantendo o dia gravado: vale
    expect((await patch(doctor.id, { birthMonth: 6 })).status).toBe(200);
    // limpar só o dia quebra o par
    expect(fieldsOf(await patch(doctor.id, { birthDay: null }))).toHaveProperty('birthDay');
    // limpar os dois vale
    expect((await patch(doctor.id, { birthDay: null, birthMonth: null })).status).toBe(200);
  });

  it('consultas: particulares ≤ total; não atende particular -> particulares 0/vazio', async () => {
    expect(
      fieldsOf(await create({ name: 'X', monthlyConsultations: 10, monthlyPrivateConsultations: 11 })),
    ).toHaveProperty('monthlyPrivateConsultations');
    expect(
      fieldsOf(await create({ name: 'X', acceptsPrivate: false, monthlyPrivateConsultations: 3 })),
    ).toHaveProperty('monthlyPrivateConsultations');
    await createOk({ name: 'Y', acceptsPrivate: false, monthlyPrivateConsultations: 0 });

    const doctor = await createOk({ name: 'Z', monthlyConsultations: 100, monthlyPrivateConsultations: 50 });
    expect(fieldsOf(await patch(doctor.id, { monthlyConsultations: 40 }))).toHaveProperty('monthlyPrivateConsultations');
    expect((await create({ name: 'N', monthlyConsultations: -1 })).status).toBe(400);
    expect((await create({ name: 'N', monthlyConsultations: 1.5 })).status).toBe(400);
  });

  it('valor da consulta: ≥ 0 e até 2 casas', async () => {
    expect(fieldsOf(await create({ name: 'X', consultationFee: -1 }))).toHaveProperty('consultationFee');
    expect(fieldsOf(await create({ name: 'X', consultationFee: 10.123 }))).toHaveProperty('consultationFee');
    expect((await createOk({ name: 'Y', consultationFee: 179.8 })).consultationFee).toBe(179.8);
  });

  it('horário: início antes do fim, ao menos um dia, HH:MM, até 14 faixas', async () => {
    expect(
      fieldsOf(await create({ name: 'X', visitHours: [{ weekdays: [1], start: '10:00', end: '09:00' }] })),
    ).toHaveProperty('visitHours');
    expect(
      fieldsOf(await create({ name: 'X', visitHours: [{ weekdays: [], start: '08:00', end: '09:00' }] })),
    ).toHaveProperty('visitHours');
    expect((await create({ name: 'X', visitHours: [{ weekdays: [7], start: '08:00', end: '09:00' }] })).status).toBe(400);
    expect((await create({ name: 'X', visitHours: [{ weekdays: [1], start: '8h', end: '09:00' }] })).status).toBe(400);
    const many = Array.from({ length: 15 }, () => ({ weekdays: [1], start: '08:00', end: '09:00' }));
    expect((await create({ name: 'X', visitHours: many })).status).toBe(400);

    const doctor = await createOk({ name: 'Y', visitHours: [{ weekdays: [1], start: '08:00', end: '09:00' }] });
    const cleared = await patch(doctor.id, { visitHours: null });
    expect((cleared.body as Doctor).visitHours).toEqual([]);
  });

  it('parceria desde: não futura; CEP com 8 dígitos; UF do endereço válida', async () => {
    expect(fieldsOf(await create({ name: 'X', partnerSince: '2999-01-01' }))).toHaveProperty('partnerSince');
    expect((await create({ name: 'X', partnerSince: '01/02/2025' })).status).toBe(400);
    expect(fieldsOf(await create({ name: 'X', addressZip: '8870' }))).toHaveProperty('addressZip');
    expect(fieldsOf(await create({ name: 'X', addressState: 'XX' }))).toHaveProperty('addressState');
  });
});

describe('audit e updated_at', () => {
  it('update_doctor leva os campos novos e não os espelhos antigos', async () => {
    const cardio = await specialty('Cardiologia');
    const doctor = await createOk({ name: 'Dr. A' });
    await patch(doctor.id, { specialtyId: cardio.id, secretaryName: 'Marta', visitHours: [{ weekdays: [1], start: '08:00', end: '09:00' }] }).then(
      (res) => expect(res.status).toBe(200),
    );
    const rows = await db.withoutTenant((tx) =>
      tx.query<{ old_values: Record<string, unknown>; new_values: Record<string, unknown> }>(
        `SELECT old_values, new_values FROM audit_logs WHERE action = 'update_doctor' AND entity_id = $1`,
        [doctor.id],
      ),
    );
    expect(rows.rows[0]?.new_values).toEqual({
      specialtyId: cardio.id,
      secretaryName: 'Marta',
      visitHours: [{ weekdays: [1], start: '08:00', end: '09:00' }],
    });
    expect(rows.rows[0]?.old_values).toEqual({ specialtyId: null, secretaryName: null, visitHours: [] });
  });

  it('gravar só a curva ABC não mexe em updated_at; editar mexe', async () => {
    const doctor = await createOk({ name: 'Dr. T' });
    await db.withoutTenant((tx) =>
      tx.query(`UPDATE doctors SET updated_at = '2026-01-01T00:00:00Z' WHERE id = $1`, [doctor.id]),
    );
    await db.withoutTenant((tx) =>
      tx.query(
        `UPDATE doctors SET abc_class = 'A', abc_base_value = 10, abc_calculated_at = now() WHERE id = $1`,
        [doctor.id],
      ),
    );
    const afterAbc = await app.agent.get(`${BASE}/${doctor.id}`).set(app.auth(repA)).expect(200);
    expect((afterAbc.body as Doctor).updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect((afterAbc.body as Doctor).abcClass).toBe('A');

    const edited = await patch(doctor.id, { clinic: 'Nova' });
    expect((edited.body as Doctor).updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('filtros novos da lista', () => {
  it('?specialtyId e ?abcClass', async () => {
    const cardio = await specialty('Cardiologia');
    const a = await createOk({ name: 'Dr. A', specialtyId: cardio.id });
    const b = await createOk({ name: 'Dr. B' });
    await db.withoutTenant((tx) => tx.query(`UPDATE doctors SET abc_class = 'B' WHERE id = $1`, [b.id]));

    const bySpecialty = await app.agent.get(`${BASE}?specialtyId=${cardio.id}`).set(app.auth(repA)).expect(200);
    expect((bySpecialty.body as ListDoctorsResponse).doctors.map((d) => d.id)).toEqual([a.id]);

    const byAbc = await app.agent.get(`${BASE}?abcClass=B`).set(app.auth(repA)).expect(200);
    expect((byAbc.body as ListDoctorsResponse).doctors.map((d) => d.id)).toEqual([b.id]);

    await app.agent.get(`${BASE}?abcClass=D`).set(app.auth(repA)).expect(400);
  });
});
