/**
 * CRMLAB-124 (D-292/D-293): o nome do cadastro chega a conversa.
 *
 * Caso real de prod (28/10/2026): a Nova conversa criou paciente e conversa
 * SEM nome no mesmo segundo; o nome foi gravado no paciente 21 s depois e a
 * conversa ficou com `patient_name` vazio — a copia denormalizada nao era
 * atualizada. Estes testes provam:
 *   - PATCH do nome reflete em TODAS as conversas do paciente (e so nelas);
 *   - conversa que ja existia, depois cadastrou o contato -> nome do cadastro;
 *   - o perfil do WhatsApp continua sem sobrescrever o nome cadastrado (D-072);
 *   - apagar o nome do cadastro nao apaga o nome da conversa;
 *   - POST /patients para numero que ja existe SEM nome completa o cadastro
 *     (201, mesmo id) em vez de perder o nome num 409 (D-293).
 */
import type { PatientDetail } from '@crm-lab/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { patientModule } from '../../src/controllers/patient.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { ConversationRepository } from '../../src/repositories/conversation.repository.js';
import {
  createConversation,
  createTenant,
  createUser,
  type TenantRecord,
  type UserRecord,
} from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createPatient, linkConversation } from './helpers.js';

const BASE = '/api/v1/patients';

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
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
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', name: 'Ana', db });
  otherAttendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', name: 'Bia', db });
});

async function conversationName(id: string): Promise<string | null> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ patient_name: string | null }>(
      'SELECT patient_name FROM conversations WHERE id = $1',
      [id],
    ),
  );
  return result.rows[0]?.patient_name ?? null;
}

/** Nova conversa para numero desconhecido: paciente e conversa nascem sem nome. */
async function startNameless(phone: string, assignedTo: string | null) {
  return new ConversationRepository(db).findOrCreateByPhone(tenantA.id, {
    patientPhone: phone,
    patientName: null,
    channel: 'whatsapp',
    assignedTo,
  });
}

describe('nome do cadastro nas conversas (D-292)', () => {
  it('caso de prod: conversa nasce sem nome, PATCH do nome reflete na conversa', async () => {
    const { conversation } = await startNameless('+5548999991234', attendantA.id);
    expect(conversation.patientName).toBeNull();
    const patientId = conversation.patientId as string;

    await app.agent
      .patch(`${BASE}/${patientId}`)
      .set(app.auth(attendantA))
      .send({ name: 'Maria Souza' })
      .expect(200);

    const reread = await new ConversationRepository(db).findById(tenantA.id, conversation.id);
    expect(reread?.patientName).toBe('Maria Souza');
  });

  it('editar o nome atualiza TODAS as conversas do paciente e nenhuma outra', async () => {
    const patient = await createPatient({ tenantId: tenantA.id, name: 'Antigo', db });
    const first = await createConversation({
      tenantId: tenantA.id,
      patientPhone: patient.phone,
      patientName: 'Jhow 🔥',
      assignedTo: attendantA.id,
      status: 'closed',
      db,
    });
    const second = await createConversation({
      tenantId: tenantA.id,
      patientPhone: patient.phone,
      patientName: 'Antigo',
      assignedTo: attendantA.id,
      db,
    });
    await linkConversation(first.id, patient.id, { db });
    await linkConversation(second.id, patient.id, { db });
    const unrelated = await createConversation({
      tenantId: tenantA.id,
      patientName: 'Outra Pessoa',
      db,
    });
    const otherTenant = await createConversation({
      tenantId: tenantB.id,
      patientPhone: patient.phone,
      patientName: 'Antigo',
      db,
    });

    await app.agent
      .patch(`${BASE}/${patient.id}`)
      .set(app.auth(attendantA))
      .send({ name: 'João da Silva' })
      .expect(200);

    expect(await conversationName(first.id)).toBe('João da Silva');
    expect(await conversationName(second.id)).toBe('João da Silva');
    expect(await conversationName(unrelated.id)).toBe('Outra Pessoa');
    expect(await conversationName(otherTenant.id)).toBe('Antigo');
  });

  it('apagar o nome do cadastro nao apaga o nome da conversa', async () => {
    const patient = await createPatient({ tenantId: tenantA.id, name: 'Maria', db });
    const conversation = await createConversation({
      tenantId: tenantA.id,
      patientPhone: patient.phone,
      patientName: 'Maria',
      assignedTo: attendantA.id,
      db,
    });
    await linkConversation(conversation.id, patient.id, { db });

    await app.agent
      .patch(`${BASE}/${patient.id}`)
      .set(app.auth(attendantA))
      .send({ name: null })
      .expect(200);

    expect(await conversationName(conversation.id)).toBe('Maria');
  });

  it('conversa que ja existia com o apelido do perfil passa ao nome cadastrado e o perfil nao volta (D-072)', async () => {
    const conversation = await createConversation({
      tenantId: tenantA.id,
      patientPhone: '+5548999991234',
      patientName: 'Jhow 🔥',
      assignedTo: attendantA.id,
      db,
    });
    const patient = await createPatient({
      tenantId: tenantA.id,
      phone: '+5548999991234',
      name: 'Jonathan Pereira',
      db,
    });
    await linkConversation(conversation.id, patient.id, { db });

    // Proxima mensagem do contato, ainda com o apelido do perfil.
    const repo = new ConversationRepository(db);
    const { conversation: inbound } = await repo.findOrCreateByPhone(tenantA.id, {
      patientPhone: '+5548999991234',
      patientName: 'Jhow 🔥',
      channel: 'whatsapp',
    });
    expect(inbound.id).toBe(conversation.id);
    expect(inbound.patientName).toBe('Jonathan Pereira');

    const again = await repo.findOrCreateByPhone(tenantA.id, {
      patientPhone: '+5548999991234',
      patientName: 'Outro Apelido',
      channel: 'whatsapp',
    });
    expect(again.conversation.patientName).toBe('Jonathan Pereira');
  });
});

describe('POST /patients para numero que ja existe sem nome (D-293)', () => {
  it('completa o cadastro sem nome: 201, mesmo id, nome na conversa ja existente', async () => {
    const { conversation } = await startNameless('+5548999991234', attendantA.id);

    const response = await app.agent
      .post(BASE)
      .set(app.auth(attendantA))
      .send({ name: 'Carla Mendes', phone: '(48) 99999-1234', email: 'carla@example.com' })
      .expect(201);

    const body = response.body as PatientDetail;
    expect(body.id).toBe(conversation.patientId);
    expect(body).toMatchObject({ name: 'Carla Mendes', email: 'carla@example.com' });
    expect(await conversationName(conversation.id)).toBe('Carla Mendes');
  });

  it('cadastro sem nome que a atendente nao pode editar continua 409', async () => {
    const { conversation } = await startNameless('+5548999991234', otherAttendantA.id);

    await app.agent
      .post(BASE)
      .set(app.auth(attendantA))
      .send({ name: 'Carla Mendes', phone: '(48) 99999-1234' })
      .expect(409);
    expect(await conversationName(conversation.id)).toBeNull();
  });

  it('cadastro com nome continua 409 e nao troca o nome', async () => {
    const patient = await createPatient({
      tenantId: tenantA.id,
      phone: '+5548999991234',
      name: 'Maria',
      db,
    });
    await app.agent
      .post(BASE)
      .set(app.auth(attendantA))
      .send({ name: 'Outra', phone: '(48) 99999-1234' })
      .expect(409);
    const ficha = await app.agent.get(`${BASE}/${patient.id}`).set(app.auth(attendantA));
    expect((ficha.body as PatientDetail).name).toBe('Maria');
  });
});
