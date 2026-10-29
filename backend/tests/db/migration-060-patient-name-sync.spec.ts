/**
 * Migração 060 — `conversations.patient_name` acompanha `patients.name`
 * (CRMLAB-124, D-292). Roda o próprio arquivo da migração sobre dados que
 * reproduzem prod e confere: nome do cadastro vence, cadastro sem nome não
 * apaga, anonimizado e conversa sem vínculo ficam, e a segunda execução não
 * muda nada (idempotente).
 */
import { readFile } from 'node:fs/promises';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { createConversation, createTenant, type TenantRecord } from '../helpers/factories.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createPatient, linkConversation } from '../patients/helpers.js';

const SQL_URL = new URL('../../migrations/060_conversations_patient_name_sync.sql', import.meta.url);

let db: DbClient;
let tenant: TenantRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  tenant = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
});

async function runMigration(): Promise<number> {
  const sql = await readFile(SQL_URL, 'utf8');
  const result = await db.withoutTenant((tx) => tx.query(sql));
  return result.rowCount ?? 0;
}

async function nameOf(id: string): Promise<string | null> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ patient_name: string | null }>(
      'SELECT patient_name FROM conversations WHERE id = $1',
      [id],
    ),
  );
  return result.rows[0]?.patient_name ?? null;
}

async function linked(patientName: string | null, conversationName: string | null) {
  const patient = await createPatient({ tenantId: tenant.id, name: patientName, db });
  const conversation = await createConversation({
    tenantId: tenant.id,
    patientPhone: patient.phone,
    db,
  });
  await db.withoutTenant((tx) =>
    tx.query('UPDATE conversations SET patient_name = $2 WHERE id = $1', [
      conversation.id,
      conversationName,
    ]),
  );
  await linkConversation(conversation.id, patient.id, { db });
  return { patient, conversation };
}

describe('migração 060', () => {
  it('copia o nome do cadastro só onde deve, e é idempotente', async () => {
    const empty = await linked('Maria Souza', null);
    const nickname = await linked('Jonathan Pereira', 'Jhow 🔥');
    const same = await linked('Ana', 'Ana');
    const nameless = await linked(null, 'Apelido');
    const anonymized = await linked('Anonimo', null);
    await db.withoutTenant((tx) =>
      tx.query('UPDATE patients SET anonymized_at = NOW() WHERE id = $1', [
        anonymized.patient.id,
      ]),
    );
    const unlinked = await createConversation({ tenantId: tenant.id, patientName: 'Solta', db });

    expect(await runMigration()).toBe(2);

    expect(await nameOf(empty.conversation.id)).toBe('Maria Souza');
    expect(await nameOf(nickname.conversation.id)).toBe('Jonathan Pereira');
    expect(await nameOf(same.conversation.id)).toBe('Ana');
    expect(await nameOf(nameless.conversation.id)).toBe('Apelido');
    expect(await nameOf(anonymized.conversation.id)).toBeNull();
    expect(await nameOf(unlinked.id)).toBe('Solta');

    expect(await runMigration()).toBe(0);
  });
});
