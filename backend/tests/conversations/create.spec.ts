/**
 * POST /conversations — atendimento manual (API_CONTRACTS.md §2).
 *
 * A porta de entrada de quem NAO veio pelo WhatsApp: ligacao, balcao, site.
 * O que os testes fixam e o que a tela depende — o dedupe por telefone (nao
 * pode nascer um segundo paciente para o mesmo numero) e o 409 que impede o
 * atendente de ser mandado para uma conversa que ele nao consegue abrir.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { conversationModule } from '../../src/controllers/conversation.routes.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/test-db.js';

const body = {
  patientPhone: '(48) 99999-1234',
  patientName: 'Maria Balcao',
  channel: 'direct' as const,
};

describe('POST /conversations', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ modules: [conversationModule] });
  });

  beforeEach(async () => {
    await resetDatabase();
    app.wsHub.clear();
  });

  it('cria a conversa ja atribuida a quem cadastrou, ligada ao cadastro do paciente', async () => {
    const tenant = await createTenant();
    const attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });

    const response = await app.agent
      .post('/api/v1/conversations')
      .set(app.auth(attendant))
      .send(body)
      .expect(201);

    expect(response.body).toMatchObject({
      patientName: 'Maria Balcao',
      channel: 'direct',
      status: 'active',
      assignedTo: attendant.id,
      unreadCount: 0,
    });
    expect(response.body.patientId).not.toBeNull();
  });

  it('recusa channel whatsapp — essa conversa so nasce pelo webhook', async () => {
    const tenant = await createTenant();
    const attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });

    const response = await app.agent
      .post('/api/v1/conversations')
      .set(app.auth(attendant))
      .send({ ...body, channel: 'whatsapp' })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('recusa telefone com digitos de menos', async () => {
    const tenant = await createTenant();
    const attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });

    const response = await app.agent
      .post('/api/v1/conversations')
      .set(app.auth(attendant))
      .send({ ...body, patientPhone: '99999' })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('telefone que ja e do proprio atendente devolve a conversa existente, sem duplicar paciente', async () => {
    const tenant = await createTenant();
    const attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const existing = await createConversation({
      tenantId: tenant.id,
      assignedTo: attendant.id,
      patientPhone: '+5548999991234',
    });

    const response = await app.agent
      .post('/api/v1/conversations')
      .set(app.auth(attendant))
      .send(body)
      .expect(201);

    expect(response.body.id).toBe(existing.id);

    const patients = await app.db.withoutTenant((tx) =>
      tx.query<{ count: string }>('SELECT COUNT(*) AS count FROM patients WHERE tenant_id = $1', [
        tenant.id,
      ]),
    );
    expect(Number(patients.rows[0]?.count)).toBe(1);
  });

  it('telefone de OUTRO atendente devolve 409 com o dono, em vez de 404', async () => {
    const tenant = await createTenant();
    const owner = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    const other = await createUser({ tenantId: tenant.id, role: 'attendant' });
    await createConversation({
      tenantId: tenant.id,
      assignedTo: owner.id,
      patientPhone: '+5548999991234',
    });

    const response = await app.agent
      .post('/api/v1/conversations')
      .set(app.auth(other))
      .send(body)
      .expect(409);

    expect(response.body.error.code).toBe('CONVERSATION_ALREADY_ASSIGNED');
    expect(response.body.error.details).toMatchObject({ assignedTo: owner.id });
  });

  it('conversa de OUTRO tenant nao e reaproveitada — cada laboratorio tem a sua', async () => {
    const other = await createTenant();
    const otherAttendant = await createUser({ tenantId: other.id, role: 'attendant' });
    await createConversation({
      tenantId: other.id,
      assignedTo: otherAttendant.id,
      patientPhone: '+5548999991234',
    });

    const tenant = await createTenant();
    const attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });

    const response = await app.agent
      .post('/api/v1/conversations')
      .set(app.auth(attendant))
      .send(body)
      .expect(201);

    expect(response.body.assignedTo).toBe(attendant.id);
  });

  it('D-174: telefone com conversa ENCERRADA de outra atendente reabre para quem cadastrou', async () => {
    const tenant = await createTenant();
    const owner = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const attendant = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Bia' });
    const closed = await createConversation({
      tenantId: tenant.id,
      assignedTo: owner.id,
      patientPhone: '+5548999991234',
      status: 'closed',
    });

    const response = await app.agent
      .post('/api/v1/conversations')
      .set(app.auth(attendant))
      .send(body)
      .expect(201);

    expect(response.body.id).toBe(closed.id);
    expect(response.body.status).toBe('active');
    expect(response.body.assignedTo).toBe(attendant.id);

    const detalhe = await app.agent
      .get(`/api/v1/conversations/${closed.id}`)
      .set(app.auth(attendant))
      .expect(200);
    expect(detalhe.body.messages.at(-1).content).toBe('Atendimento reaberto por Bia');
  });
});
