/**
 * POST /conversations/:id/messages — API_CONTRACTS.md §2 — e o contrato de
 * `MessageService` consumido por outros dominios (`createSystemEvent`).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { conversationModule } from '../../src/controllers/conversation.routes.js';
import { MessageService } from '../../src/services/message.service.js';
import { ConversationRepository } from '../../src/repositories/conversation.repository.js';
import { MessageRepository } from '../../src/repositories/message.repository.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { FakeWsHub } from '../helpers/fake-ws.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { countMessages, readConversationRow } from '../conversations/helpers.js';

describe('POST /conversations/:id/messages', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ modules: [conversationModule] });
  });

  beforeEach(async () => {
    await resetDatabase();
    app.wsHub.clear();
  });

  it('devolve 201 com o shape do contrato', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });

    const response = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'Otimo! Vou criar um orcamento para voce.', messageType: 'text' })
      .expect(201);

    expect(Object.keys(response.body).sort()).toEqual([
      'attachmentUrl',
      'content',
      'conversationId',
      'createdAt',
      'id',
      'messageType',
      'readAt',
      'senderId',
      'senderName',
      'senderType',
      'status',
    ]);
    expect(response.body.conversationId).toBe(conversation.id);
    expect(response.body.senderType).toBe('agent');
    expect(response.body.senderId).toBe(ana.id);
    expect(response.body.status).toBe('sent');
    expect(response.body.messageType).toBe('text');
    expect(response.body.createdAt).toMatch(/Z$/);
  });

  it('emite conversation.new_message SO na room do tenant certo', async () => {
    const alfa = await createTenant();
    const beta = await createTenant();
    const ana = await createUser({ tenantId: alfa.id, role: 'attendant' });
    await createUser({ tenantId: beta.id, role: 'attendant' });
    const conversation = await createConversation({ tenantId: alfa.id, assignedTo: ana.id });

    const response = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'Ola' })
      .expect(201);

    const eventos = app.wsHub.eventsFor(alfa.id, 'conversation.new_message');
    expect(eventos).toHaveLength(1);
    // Payload so com ids: o evento e notificacao, nao transporte de dados.
    expect(eventos[0]?.data).toEqual({
      conversationId: conversation.id,
      messageId: response.body.id,
    });
    // Room = tenantId (do token), e o vizinho nao recebe nada.
    expect(eventos[0]?.userId).toBeNull();
    expect(app.wsHub.eventsFor(beta.id)).toHaveLength(0);
  });

  it('conversa arquivada -> CONVERSATION_ARCHIVED (409) e nada e gravado', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const conversation = await createConversation({
      tenantId: tenant.id,
      assignedTo: ana.id,
      status: 'archived',
    });

    const response = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'Ainda da tempo?' })
      .expect(409);

    expect(response.body.error.code).toBe('CONVERSATION_ARCHIVED');
    expect(response.body.error.statusCode).toBe(409);
    expect(await countMessages(tenant.id)).toBe(0);
    expect(app.wsHub.eventsFor(tenant.id)).toHaveLength(0);
  });

  it('conteudo vazio -> VALIDATION_ERROR', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });

    const response = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(ana))
      .send({ content: '   ' })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('platform_operator recebe FORBIDDEN', async () => {
    const tenant = await createTenant();
    const operador = await createUser({ tenantId: tenant.id, role: 'platform_operator' });
    const conversation = await createConversation({ tenantId: tenant.id });

    const response = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(operador))
      .send({ content: 'Ola' })
      .expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });
});

describe('POST /conversations/:id/messages — isolamento (bloqueante)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ modules: [conversationModule] });
  });

  beforeEach(async () => {
    await resetDatabase();
    app.wsHub.clear();
  });

  it('mensagem em conversa de outro tenant -> 404 e nada e gravado', async () => {
    const alfa = await createTenant();
    const beta = await createTenant();
    const anaAlfa = await createUser({ tenantId: alfa.id, role: 'admin' });
    const daBeta = await createConversation({ tenantId: beta.id });

    const response = await app.agent
      .post(`/api/v1/conversations/${daBeta.id}/messages`)
      .set(app.auth(anaAlfa))
      .send({ content: 'invasao' })
      .expect(404);

    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(await countMessages(beta.id)).toBe(0);
    expect(await countMessages(alfa.id)).toBe(0);
    expect(app.wsHub.emitted).toHaveLength(0);
  });

  it('mensagem em conversa de outro ATENDENTE do mesmo tenant -> 404', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const bruno = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const doBruno = await createConversation({ tenantId: tenant.id, assignedTo: bruno.id });

    await app.agent
      .post(`/api/v1/conversations/${doBruno.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'oi' })
      .expect(404);
    expect(await countMessages(tenant.id)).toBe(0);
  });
});

/**
 * Contrato consumido por ProposalService/ApprovalService. Se esta suite quebrar,
 * quebrou a integracao com o dominio de propostas — nao so o inbox.
 */
describe('MessageService — interface para outros dominios', () => {
  let service: MessageService;
  let wsHub: FakeWsHub;

  beforeEach(async () => {
    await resetDatabase();
    const db = await getTestDb();
    wsHub = new FakeWsHub();
    service = new MessageService({
      messages: new MessageRepository(db),
      conversations: new ConversationRepository(db),
      wsHub,
    });
  });

  it('createSystemEvent(tenantId, conversationId, content) grava a bolha de sistema', async () => {
    const tenant = await createTenant();
    const conversation = await createConversation({ tenantId: tenant.id });

    const message = await service.createSystemEvent(
      tenant.id,
      conversation.id,
      'Orcamento enviado ao paciente',
    );

    expect(message.senderType).toBe('system');
    expect(message.senderId).toBeNull();
    expect(message.senderName).toBeNull();
    expect(message.content).toBe('Orcamento enviado ao paciente');
    expect(message.conversationId).toBe(conversation.id);

    expect(wsHub.eventsFor(tenant.id, 'conversation.new_message')).toHaveLength(1);
    // Evento de sistema nao conta como "nao lida" do paciente.
    const row = await readConversationRow(conversation.id);
    expect(row?.unread_count).toBe(0);
  });

  it('createSystemEvent funciona em conversa arquivada (o fato aconteceu)', async () => {
    const tenant = await createTenant();
    const conversation = await createConversation({ tenantId: tenant.id, status: 'archived' });

    const message = await service.createSystemEvent(tenant.id, conversation.id, 'Proposta ganha');
    expect(message.id).toBeTruthy();
  });

  it('createSystemEvent em conversa de outro tenant -> NOT_FOUND', async () => {
    const alfa = await createTenant();
    const beta = await createTenant();
    const daBeta = await createConversation({ tenantId: beta.id });

    await expect(service.createSystemEvent(alfa.id, daBeta.id, 'nope')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await countMessages(beta.id)).toBe(0);
  });

  it('createFromPatient incrementa unread_count e sobe last_message_at', async () => {
    const tenant = await createTenant();
    const conversation = await createConversation({ tenantId: tenant.id });

    await service.createFromPatient(tenant.id, conversation.id, { content: 'Ola' });
    await service.createFromPatient(tenant.id, conversation.id, { content: 'Tem hemograma?' });

    const row = await readConversationRow(conversation.id);
    expect(row?.unread_count).toBe(2);

    const page = await service.listByConversation(tenant.id, conversation.id);
    expect(page.messages.map((m) => m.content)).toEqual(['Ola', 'Tem hemograma?']);
    expect(page.pagination.total).toBe(2);
    expect(wsHub.eventsFor(tenant.id, 'conversation.new_message')).toHaveLength(2);
  });

  it('createFromPatient e idempotente por externalId (reentrega do canal)', async () => {
    const tenant = await createTenant();
    const conversation = await createConversation({ tenantId: tenant.id });

    const primeira = await service.createFromPatient(tenant.id, conversation.id, {
      content: 'Ola',
      externalId: 'wamid.ABC',
    });
    const repetida = await service.createFromPatient(tenant.id, conversation.id, {
      content: 'Ola',
      externalId: 'wamid.ABC',
    });

    expect(repetida.id).toBe(primeira.id);
    expect(await countMessages(tenant.id)).toBe(1);
    // A reentrega nao gera segundo evento nem segundo "nao lida".
    expect(wsHub.eventsFor(tenant.id, 'conversation.new_message')).toHaveLength(1);
    const row = await readConversationRow(conversation.id);
    expect(row?.unread_count).toBe(1);
  });
});
