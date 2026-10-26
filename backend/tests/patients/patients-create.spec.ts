/**
 * `POST /api/v1/patients` e o reconhecimento do contato cadastrado a mao
 * (CRMLAB-121, D-287).
 *
 * O que estes testes provam:
 *   - qualquer papel de laboratorio cadastra; o telefone sai em E.164;
 *   - telefone ja cadastrado (inclusive sem/com o nono digito) -> 409, nunca
 *     dois cadastros, e `patientId` so para quem enxerga o existente;
 *   - contato sem conversa e visivel para a atendente (busca da Nova conversa);
 *   - quando o contato escreve (webhook -> `findOrCreateByPhone`), a conversa
 *     se liga ao cadastro e nasce com o nome cadastrado — com o numero vindo
 *     com OU sem o nono digito.
 */
import type { ListPatientsResponse, PatientDetail } from '@crm-lab/shared';
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
import { createPatient, linkConversation, readAuditLogs } from './helpers.js';

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

async function countPatients(tenantId: string): Promise<number> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ total: number }>('SELECT COUNT(*)::int AS total FROM patients WHERE tenant_id = $1', [
      tenantId,
    ]),
  );
  return result.rows[0]?.total ?? 0;
}

describe('POST /patients', () => {
  it('atendente cadastra contato com nome e telefone; telefone sai em E.164 e audita', async () => {
    const response = await app.agent
      .post(BASE)
      .set(app.auth(attendantA))
      .send({ name: '  Maria Souza ', phone: '(48) 99999-1234' })
      .expect(201);

    const body = response.body as PatientDetail;
    expect(body).toMatchObject({
      name: 'Maria Souza',
      phone: '+5548999991234',
      email: null,
      document: null,
      conversationCount: 0,
      canEdit: true,
    });
    const logs = await readAuditLogs(tenantA.id, 'create_patient', db);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.entityId).toBe(body.id);
  });

  it('aceita CPF e e-mail opcionais; recusa CPF invalido, telefone invalido e sem nome', async () => {
    const ok = await app.agent
      .post(BASE)
      .set(app.auth(attendantA))
      .send({
        name: 'Joao',
        phone: '48 3622-1234',
        email: 'joao@exemplo.com',
        document: '529.982.247-25',
      })
      .expect(201);
    expect(ok.body).toMatchObject({ phone: '+554836221234', document: '52998224725' });

    const headers = app.auth(attendantA);
    await app.agent.post(BASE).set(headers).send({ name: 'X', phone: '123' }).expect(400);
    await app.agent.post(BASE).set(headers).send({ name: '', phone: '48999991234' }).expect(400);
    await app.agent
      .post(BASE)
      .set(headers)
      .send({ name: 'X', phone: '48999991235', document: '111.111.111-11' })
      .expect(400);
    await app.agent
      .post(BASE)
      .set(headers)
      .send({ name: 'X', phone: '48999991236', tenantId: tenantB.id })
      .expect(400);
  });

  it('telefone ja cadastrado (com ou sem o nono digito) -> 409, sem segundo cadastro', async () => {
    const existing = await createPatient({ tenantId: tenantA.id, phone: '+554899991234', db });

    const sameFormat = await app.agent
      .post(BASE)
      .set(app.auth(attendantA))
      .send({ name: 'Outro', phone: '(48) 9999-1234' })
      .expect(409);
    expect(sameFormat.body.error.details).toEqual({
      reason: 'phone_already_in_use',
      patientId: existing.id,
    });

    const withNine = await app.agent
      .post(BASE)
      .set(app.auth(attendantA))
      .send({ name: 'Outro', phone: '(48) 99999-1234' })
      .expect(409);
    expect(withNine.body.error.details.patientId).toBe(existing.id);
    expect(await countPatients(tenantA.id)).toBe(1);
  });

  it('409 nao revela a ficha que a atendente nao enxerga', async () => {
    const conversation = await createConversation({
      tenantId: tenantA.id,
      patientPhone: '+5548999991234',
      assignedTo: otherAttendantA.id,
      db,
    });
    const existing = await createPatient({ tenantId: tenantA.id, phone: '+5548999991234', db });
    await linkConversation(conversation.id, existing.id, { db });

    const response = await app.agent
      .post(BASE)
      .set(app.auth(attendantA))
      .send({ name: 'Outro', phone: '48999991234' })
      .expect(409);
    expect(response.body.error.details).toEqual({ reason: 'phone_already_in_use' });
  });

  it('mesmo telefone em outro laboratorio nao conflita', async () => {
    await createPatient({ tenantId: tenantB.id, phone: '+5548999991234', db });
    await app.agent
      .post(BASE)
      .set(app.auth(attendantA))
      .send({ name: 'Maria', phone: '48999991234' })
      .expect(201);
    expect(await countPatients(tenantA.id)).toBe(1);
  });
});

describe('contato sem conversa (D-287)', () => {
  it('toda atendente acha na busca e abre a ficha; depois de ter conversa de outra, some', async () => {
    const created = await app.agent
      .post(BASE)
      .set(app.auth(attendantA))
      .send({ name: 'Carla Mendes', phone: '48988887777' })
      .expect(201);
    const id = (created.body as PatientDetail).id;

    const found = await app.agent
      .get(BASE)
      .query({ search: 'Carla' })
      .set(app.auth(otherAttendantA))
      .expect(200);
    expect((found.body as ListPatientsResponse).patients.map((p) => p.id)).toEqual([id]);
    await app.agent.get(`${BASE}/${id}`).set(app.auth(otherAttendantA)).expect(200);

    const conversation = await createConversation({
      tenantId: tenantA.id,
      patientPhone: '+5548988887777',
      assignedTo: attendantA.id,
      db,
    });
    await linkConversation(conversation.id, id, { db });

    const hidden = await app.agent
      .get(BASE)
      .query({ search: 'Carla' })
      .set(app.auth(otherAttendantA))
      .expect(200);
    expect((hidden.body as ListPatientsResponse).patients).toHaveLength(0);
  });
});

describe('reconhecimento quando o contato escreve', () => {
  it.each([
    ['com o nono digito', '+5548999991234'],
    ['sem o nono digito (JID antigo)', '+554899991234'],
  ])('mensagem %s liga ao cadastro e usa o nome cadastrado', async (_label, inboundPhone) => {
    const created = await app.agent
      .post(BASE)
      .set(app.auth(attendantA))
      .send({ name: 'Maria Souza', phone: '(48) 99999-1234' })
      .expect(201);
    const patientId = (created.body as PatientDetail).id;

    const { conversation, created: isNew } = await new ConversationRepository(
      db,
    ).findOrCreateByPhone(tenantA.id, {
      patientPhone: inboundPhone,
      patientName: 'Mari 🌸',
      channel: 'whatsapp',
    });

    expect(isNew).toBe(true);
    expect(conversation.patientId).toBe(patientId);
    expect(conversation.patientName).toBe('Maria Souza');
    expect(conversation.patientPhone).toBe(inboundPhone);
    expect(await countPatients(tenantA.id)).toBe(1);

    const ficha = await app.agent
      .get(`${BASE}/${patientId}`)
      .set(app.auth(attendantA))
      .expect(200);
    expect(ficha.body).toMatchObject({ name: 'Maria Souza', phone: '+5548999991234' });
  });

  it('cadastro sem nome ganha o nome do perfil, como antes (D-072)', async () => {
    const existing = await createPatient({
      tenantId: tenantA.id,
      phone: '+5548999991234',
      name: null,
      db,
    });
    const { conversation } = await new ConversationRepository(db).findOrCreateByPhone(
      tenantA.id,
      { patientPhone: '+554899991234', patientName: 'Mari', channel: 'whatsapp' },
    );
    expect(conversation.patientId).toBe(existing.id);
    expect(conversation.patientName).toBe('Mari');
    expect(await countPatients(tenantA.id)).toBe(1);
  });
});
