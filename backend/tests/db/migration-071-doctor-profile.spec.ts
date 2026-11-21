/**
 * Migracao 071 — dados do cadastro ampliado do medico (CRMLAB-188, D-328).
 * Roda o proprio arquivo sobre dados que reproduzem o antes e confere:
 * lista padrao semeada, texto de especialidade casado sem acento/caixa ou
 * virando especialidade nova, secretaria copiada, proposta ligada so pelo
 * nome exato sem homonimo, isolamento por tenant e idempotencia.
 */
import { readFile } from 'node:fs/promises';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DOCTOR_SPECIALTIES } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { createProposal, createTenant, type TenantRecord } from '../helpers/factories.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const SQL_URL = new URL('../../migrations/071_doctor_profile_backfill.sql', import.meta.url);

let db: DbClient;
let tenantA: TenantRecord;
let tenantB: TenantRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
});

async function runMigration(): Promise<void> {
  const sql = await readFile(SQL_URL, 'utf8');
  await db.withoutTenant((tx) => tx.exec(sql));
}

async function doctor(
  tenantId: string,
  name: string,
  extra: { specialty?: string | null; contactName?: string | null; isActive?: boolean } = {},
): Promise<string> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO doctors (tenant_id, name, specialty, contact_name, is_active)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenantId, name, extra.specialty ?? null, extra.contactName ?? null, extra.isActive ?? true],
    ),
  );
  return result.rows[0]?.id as string;
}

async function proposal(tenantId: string, requestingDoctor: string | null): Promise<string> {
  const created = await createProposal({ tenantId, db });
  await db.withoutTenant((tx) =>
    tx.query('UPDATE proposals SET requesting_doctor = $2 WHERE id = $1', [created.id, requestingDoctor]),
  );
  return created.id;
}

async function doctorRow(id: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ specialty_id: string | null; specialty_name: string | null; secretary_name: string | null }>(
      `SELECT d.specialty_id, s.name AS specialty_name, d.secretary_name
         FROM doctors d LEFT JOIN doctor_specialties s ON s.id = d.specialty_id
        WHERE d.id = $1`,
      [id],
    ),
  );
  return result.rows[0];
}

async function proposalDoctor(id: string): Promise<string | null> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ doctor_id: string | null }>('SELECT doctor_id FROM proposals WHERE id = $1', [id]),
  );
  return result.rows[0]?.doctor_id ?? null;
}

async function specialtyNames(tenantId: string): Promise<string[]> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ name: string }>('SELECT name FROM doctor_specialties WHERE tenant_id = $1 ORDER BY name', [tenantId]),
  );
  return result.rows.map((r) => r.name);
}

describe('migração 071', () => {
  it('especialidades: semeia, casa sem acento/caixa e cria o que não casou', async () => {
    const matched = await doctor(tenantA.id, 'Dr. 1', { specialty: '  CARDIOLOGIA ' });
    const accent = await doctor(tenantA.id, 'Dr. 2', { specialty: 'clinica medica' });
    const custom1 = await doctor(tenantA.id, 'Dr. 3', { specialty: 'Ginecologia' });
    const custom2 = await doctor(tenantA.id, 'Dr. 4', { specialty: 'ginecologia' });
    const empty = await doctor(tenantA.id, 'Dr. 5', { specialty: '  ' });

    await runMigration();

    expect((await doctorRow(matched))?.specialty_name).toBe('Cardiologia');
    expect((await doctorRow(accent))?.specialty_name).toBe('Clínica Médica');
    // as duas grafias de "ginecologia" viram UMA especialidade nova
    const gin1 = await doctorRow(custom1);
    const gin2 = await doctorRow(custom2);
    expect(gin1?.specialty_id).not.toBeNull();
    expect(gin1?.specialty_id).toBe(gin2?.specialty_id);
    expect(gin1?.specialty_name).toBe('Ginecologia');
    expect((await doctorRow(empty))?.specialty_id).toBeNull();

    const namesA = await specialtyNames(tenantA.id);
    expect(namesA).toHaveLength(DEFAULT_DOCTOR_SPECIALTIES.length + 1);
    // o outro laboratório recebe só a lista padrão
    expect(await specialtyNames(tenantB.id)).toHaveLength(DEFAULT_DOCTOR_SPECIALTIES.length);
  });

  it('secretária: o contato antigo vira o nome', async () => {
    const withContact = await doctor(tenantA.id, 'Dr. S', { contactName: ' Marta ' });
    const without = await doctor(tenantA.id, 'Dr. T');
    await runMigration();
    expect((await doctorRow(withContact))?.secretary_name).toBe('Marta');
    expect((await doctorRow(without))?.secretary_name).toBeNull();
  });

  it('proposta: liga pelo nome exato normalizado; homônimo, outro tenant e texto diferente não', async () => {
    const ana = await doctor(tenantA.id, 'Dra. Ana Souza');
    await doctor(tenantA.id, 'Dr. João');
    // Pontuação conta: "dr joao" não é homônimo de "Dr. João".
    await doctor(tenantA.id, 'dr joao', { isActive: false });
    await doctor(tenantA.id, 'Dr. Pedro');
    await doctor(tenantA.id, 'DR. PEDRO', { isActive: false }); // homônimo (inativo conta)
    await doctor(tenantB.id, 'Dr. Beta');

    const exact = await proposal(tenantA.id, '  dra. ana   SOUZA ');
    const joao = await proposal(tenantA.id, 'Dr. Joao');
    const ambiguous = await proposal(tenantA.id, 'Dr. Pedro');
    const partial = await proposal(tenantA.id, 'Ana Souza');
    const crossTenant = await proposal(tenantA.id, 'Dr. Beta');
    const empty = await proposal(tenantA.id, null);

    await runMigration();

    expect(await proposalDoctor(exact)).toBe(ana);
    expect(await proposalDoctor(joao)).not.toBeNull();
    expect(await proposalDoctor(ambiguous)).toBeNull();
    expect(await proposalDoctor(partial)).toBeNull();
    expect(await proposalDoctor(crossTenant)).toBeNull();
    expect(await proposalDoctor(empty)).toBeNull();
  });

  it('é idempotente: rodar de novo não muda nada nem duplica', async () => {
    const d = await doctor(tenantA.id, 'Dr. I', { specialty: 'Nova Especialidade', contactName: 'Bia' });
    const p = await proposal(tenantA.id, 'Dr. I');
    await runMigration();
    const first = { row: await doctorRow(d), proposal: await proposalDoctor(p), names: await specialtyNames(tenantA.id) };
    await runMigration();
    expect({ row: await doctorRow(d), proposal: await proposalDoctor(p), names: await specialtyNames(tenantA.id) }).toEqual(
      first,
    );
  });
});
