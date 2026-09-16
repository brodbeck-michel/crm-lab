/**
 * Inativacao de paciente (CRMLAB-11, D-132) — API_CONTRACTS.md §2c.
 *
 * O que estes testes provam:
 *   - `POST .../inactivate` e `.../reactivate` exigem motivo (1..500 chars);
 *   - qualquer papel de laboratorio aciona — nao e admin-only como o bloco LGPD;
 *   - paciente inativo some de `GET /patients` por padrao e volta com
 *     `?includeInactive=true`, mas continua acessivel por `GET /patients/:id`
 *     (dado permanece, so passa a referenciar o estado);
 *   - inativar/reativar e idempotente e so grava audit log quando MUDA estado;
 *   - paciente anonimizado nao pode ser inativado/reativado (409, mesmo
 *     principio de PATCH).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { patientModule } from '../../src/controllers/patient.routes.js';
import type { DbClient } from '../../src/db/types.js';
import {
  createConversation,
  createTenant,
  createUser,
  type TenantRecord,
  type UserRecord,
} from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createPatient, linkConversation, readAuditLogs, type PatientRecord } from './helpers.js';

const BASE = '/api/v1/patients';
const REASON = 'Paciente mudou de laboratorio de referencia';

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let admin: UserRecord;
let manager: UserRecord;
let ana: UserRecord;
let patient: PatientRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [patientModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  admin = await createUser({ tenantId: tenantA.id, role: 'admin', name: 'Admin', db });
  manager = await createUser({ tenantId: tenantA.id, role: 'manager', db });
  ana = await createUser({ tenantId: tenantA.id, role: 'attendant', name: 'Ana', db });
  patient = await createPatient({ tenantId: tenantA.id, name: 'Joao Santos', db });
  // Ana so enxerga paciente com ao menos uma conversa dela (D-060) — sem isto
  // toda chamada dela devolveria 404 antes mesmo de chegar na acao testada.
  const conversa = await createConversation({ tenantId: tenantA.id, assignedTo: ana.id, db });
  await linkConversation(conversa.id, patient.id, { db });
});

describe('POST /patients/:id/inactivate', () => {
  it('reason ausente ou vazio e VALIDATION_ERROR', async () => {
    const headers = app.auth(admin);
    await app.agent.post(`${BASE}/${patient.id}/inactivate`).set(headers).send({}).expect(400);
    await app.agent
      .post(`${BASE}/${patient.id}/inactivate`)
      .set(headers)
      .send({ reason: '   ' })
      .expect(400);
    await app.agent
      .post(`${BASE}/${patient.id}/inactivate`)
      .set(headers)
      .send({ reason: 'x'.repeat(501) })
      .expect(400);
  });

  it('qualquer papel de laboratorio inativa — nao e restrito a admin', async () => {
    for (const user of [admin, manager, ana]) {
      const isolado = await createPatient({ tenantId: tenantA.id, db });
      if (user === ana) {
        const conversa = await createConversation({ tenantId: tenantA.id, assignedTo: ana.id, db });
        await linkConversation(conversa.id, isolado.id, { db });
      }
      const res = await app.agent
        .post(`${BASE}/${isolado.id}/inactivate`)
        .set(app.auth(user))
        .send({ reason: REASON })
        .expect(200);
      expect(res.body.inactivatedAt).not.toBeNull();
    }
  });

  it('grava inactivate_patient no audit log so com o motivo', async () => {
    await app.agent
      .post(`${BASE}/${patient.id}/inactivate`)
      .set(app.auth(ana))
      .send({ reason: REASON })
      .expect(200);

    const logs = await readAuditLogs(tenantA.id, 'inactivate_patient', db);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.entityId).toBe(patient.id);
    expect(logs[0]?.newValues).toEqual({ reason: REASON });
  });

  it('e idempotente: segunda chamada devolve o mesmo estado sem novo audit log', async () => {
    const headers = app.auth(admin);
    const primeira = await app.agent
      .post(`${BASE}/${patient.id}/inactivate`)
      .set(headers)
      .send({ reason: REASON })
      .expect(200);
    const segunda = await app.agent
      .post(`${BASE}/${patient.id}/inactivate`)
      .set(headers)
      .send({ reason: 'outro motivo' })
      .expect(200);

    expect(segunda.body).toEqual(primeira.body);
    expect(await readAuditLogs(tenantA.id, 'inactivate_patient', db)).toHaveLength(1);
  });

  it('some de GET /patients por padrao e volta com includeInactive=true', async () => {
    await app.agent
      .post(`${BASE}/${patient.id}/inactivate`)
      .set(app.auth(admin))
      .send({ reason: REASON })
      .expect(200);

    const escondido = await app.agent.get(BASE).set(app.auth(admin)).expect(200);
    expect(escondido.body.patients.map((p: { id: string }) => p.id)).not.toContain(patient.id);

    const visivel = await app.agent
      .get(`${BASE}?includeInactive=true`)
      .set(app.auth(admin))
      .expect(200);
    expect(visivel.body.patients.map((p: { id: string }) => p.id)).toContain(patient.id);
  });

  it('continua acessivel por GET /patients/:id — o dado permanece', async () => {
    await app.agent
      .post(`${BASE}/${patient.id}/inactivate`)
      .set(app.auth(admin))
      .send({ reason: REASON })
      .expect(200);

    const ficha = await app.agent.get(`${BASE}/${patient.id}`).set(app.auth(admin)).expect(200);
    expect(ficha.body.name).toBe('Joao Santos');
    expect(ficha.body.inactivatedAt).not.toBeNull();
    expect(ficha.body.inactivationReason).toBe(REASON);
  });

  it('paciente anonimizado nao pode ser inativado (409, mesmo principio do PATCH)', async () => {
    await app.agent
      .post(`${BASE}/${patient.id}/anonymize`)
      .set(app.auth(admin))
      .send({ reason: 'pedido do titular' })
      .expect(200);

    const res = await app.agent
      .post(`${BASE}/${patient.id}/inactivate`)
      .set(app.auth(admin))
      .send({ reason: REASON })
      .expect(409);
    expect(res.body.error.details.reason).toBe('patient_anonymized');
  });

  it('paciente de outro tenant: 404 e nenhum audit log', async () => {
    const alheio = await createPatient({ tenantId: tenantB.id, db });
    await app.agent
      .post(`${BASE}/${alheio.id}/inactivate`)
      .set(app.auth(admin))
      .send({ reason: REASON })
      .expect(404);
    expect(await readAuditLogs(tenantA.id, 'inactivate_patient', db)).toHaveLength(0);
  });
});

describe('POST /patients/:id/reactivate', () => {
  async function inactivate(): Promise<void> {
    await app.agent
      .post(`${BASE}/${patient.id}/inactivate`)
      .set(app.auth(admin))
      .send({ reason: REASON })
      .expect(200);
  }

  it('reason ausente e VALIDATION_ERROR', async () => {
    await inactivate();
    await app.agent
      .post(`${BASE}/${patient.id}/reactivate`)
      .set(app.auth(admin))
      .send({})
      .expect(400);
  });

  it('reativa, limpa inactivatedAt/inactivationReason e volta a aparecer na listagem', async () => {
    await inactivate();

    const res = await app.agent
      .post(`${BASE}/${patient.id}/reactivate`)
      .set(app.auth(manager))
      .send({ reason: 'Paciente retornou ao laboratorio' })
      .expect(200);
    expect(res.body.inactivatedAt).toBeNull();
    expect(res.body.inactivationReason).toBeNull();

    const listagem = await app.agent.get(BASE).set(app.auth(admin)).expect(200);
    expect(listagem.body.patients.map((p: { id: string }) => p.id)).toContain(patient.id);
  });

  it('grava reactivate_patient no audit log com o motivo', async () => {
    await inactivate();
    await app.agent
      .post(`${BASE}/${patient.id}/reactivate`)
      .set(app.auth(ana))
      .send({ reason: 'Paciente retornou ao laboratorio' })
      .expect(200);

    const logs = await readAuditLogs(tenantA.id, 'reactivate_patient', db);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.newValues).toEqual({ reason: 'Paciente retornou ao laboratorio' });
  });

  it('e idempotente sobre paciente ja ativo: nao grava audit log', async () => {
    await app.agent
      .post(`${BASE}/${patient.id}/reactivate`)
      .set(app.auth(admin))
      .send({ reason: 'nao estava inativo' })
      .expect(200);
    expect(await readAuditLogs(tenantA.id, 'reactivate_patient', db)).toHaveLength(0);
  });
});
