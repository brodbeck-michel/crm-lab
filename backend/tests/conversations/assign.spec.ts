/**
 * PATCH /conversations/:id — atribuicao, transferencia, arquivamento, tags
 * e POST /conversations/:id/read.
 *
 * O teste central e a CORRIDA: duas chamadas concorrentes de "Assumir" na mesma
 * conversa livre. Uma ganha, a outra recebe `CONVERSATION_ALREADY_ASSIGNED`
 * (409) com `details.assignedTo` / `details.assignedToName` — quem perdeu
 * precisa saber para quem foi.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { conversationModule } from '../../src/controllers/conversation.routes.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/test-db.js';
import { readConversationRow, seedMessage, setUnreadCount } from './helpers.js';

describe('PATCH /conversations/:id — atribuicao', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ modules: [conversationModule] });
  });

  beforeEach(async () => {
    await resetDatabase();
    app.wsHub.clear();
  });

  it('assumir uma conversa livre devolve o shape de UpdateConversationResponse', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: null });

    const response = await app.agent
      .patch(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(ana))
      .send({ assignedTo: ana.id })
      .expect(200);

    expect(Object.keys(response.body).sort()).toEqual([
      'assignedTo',
      'assignedToName',
      'id',
      'status',
      'tags',
    ]);
    expect(response.body.assignedTo).toBe(ana.id);
    expect(response.body.assignedToName).toBe('Ana');

    const row = await readConversationRow(conversation.id);
    expect(row?.assigned_to).toBe(ana.id);
  });

  it('CORRIDA: duas atribuicoes concorrentes — a primeira ganha, a segunda recebe 409', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    const bruno = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Bruno' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: null });

    // Disparadas juntas, sem await entre elas: a decisao e do banco.
    const [primeira, segunda] = await Promise.all([
      app.agent
        .patch(`/api/v1/conversations/${conversation.id}`)
        .set(app.auth(ana))
        .send({ assignedTo: ana.id }),
      app.agent
        .patch(`/api/v1/conversations/${conversation.id}`)
        .set(app.auth(bruno))
        .send({ assignedTo: bruno.id }),
    ]);

    const status = [primeira.status, segunda.status].sort();
    expect(status).toEqual([200, 409]);

    const vencedora = primeira.status === 200 ? primeira : segunda;
    const perdedora = primeira.status === 200 ? segunda : primeira;

    expect(perdedora.body.error.code).toBe('CONVERSATION_ALREADY_ASSIGNED');
    expect(perdedora.body.error.statusCode).toBe(409);
    // Quem perdeu precisa saber para quem foi.
    expect(perdedora.body.error.details.assignedTo).toBe(vencedora.body.assignedTo);
    expect(perdedora.body.error.details.assignedToName).toBe(vencedora.body.assignedToName);

    // O banco tem UM dono, e e o vencedor.
    const row = await readConversationRow(conversation.id);
    expect(row?.assigned_to).toBe(vencedora.body.assignedTo);
  });

  it('atendente nao rouba conversa ja atribuida a outro atendente', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    const bruno = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Bruno' });
    const daAna = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });

    const response = await app.agent
      .patch(`/api/v1/conversations/${daAna.id}`)
      .set(app.auth(bruno))
      .send({ assignedTo: bruno.id })
      .expect(409);
    expect(response.body.error.code).toBe('CONVERSATION_ALREADY_ASSIGNED');
    expect(response.body.error.details.assignedTo).toBe(ana.id);
    expect(response.body.error.details.assignedToName).toBe('Ana');

    // E o dono nao mudou.
    const row = await readConversationRow(daAna.id);
    expect(row?.assigned_to).toBe(ana.id);
  });

  it('reatribuir e idempotente quando o dono ja e o alvo', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });

    const response = await app.agent
      .patch(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(ana))
      .send({ assignedTo: ana.id })
      .expect(200);
    expect(response.body.assignedTo).toBe(ana.id);
  });

  it('assignedTo de usuario inexistente -> VALIDATION_ERROR', async () => {
    const tenant = await createTenant();
    const outro = await createTenant();
    const gestor = await createUser({ tenantId: tenant.id, role: 'manager' });
    const forasteiro = await createUser({ tenantId: outro.id, role: 'attendant' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: null });

    const response = await app.agent
      .patch(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(gestor))
      .send({ assignedTo: forasteiro.id })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PATCH /conversations/:id — transferencia (WORKFLOWS §5)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ modules: [conversationModule] });
  });

  beforeEach(async () => {
    await resetDatabase();
    app.wsHub.clear();
  });

  it('gera mensagem de sistema e preserva o historico completo', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    const bruno = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Bruno' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });

    await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      senderType: 'patient',
      content: 'Bom dia',
    });
    await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      senderType: 'agent',
      senderId: ana.id,
      content: 'Bom dia! Como posso ajudar?',
    });

    // Ana (dona atual) transfere para Bruno.
    const transferida = await app.agent
      .patch(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(ana))
      .send({ assignedTo: bruno.id })
      .expect(200);
    expect(transferida.body.assignedTo).toBe(bruno.id);
    expect(transferida.body.assignedToName).toBe('Bruno');

    // Bruno abre a conversa: ve o historico inteiro + a bolha de sistema.
    const detalhe = await app.agent
      .get(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(bruno))
      .expect(200);

    const conteudos = detalhe.body.messages.map((m: { content: string }) => m.content);
    expect(conteudos).toEqual([
      'Bom dia',
      'Bom dia! Como posso ajudar?',
      'Conversa transferida de Ana para Bruno',
    ]);

    const evento = detalhe.body.messages[2];
    expect(evento.senderType).toBe('system');
    expect(evento.senderId).toBeNull();
    expect(evento.senderName).toBeNull();

    // A transferencia notifica em tempo real (a bolha nova e uma mensagem).
    const eventos = app.wsHub.eventsFor(tenant.id, 'conversation.new_message');
    expect(eventos).toHaveLength(1);
    expect(eventos[0]?.data).toEqual({
      conversationId: conversation.id,
      messageId: evento.id,
    });
  });

  it('gestor transfere conversa de qualquer atendente', async () => {
    const tenant = await createTenant();
    const gestor = await createUser({ tenantId: tenant.id, role: 'manager' });
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    const bruno = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Bruno' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });

    await app.agent
      .patch(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(gestor))
      .send({ assignedTo: bruno.id })
      .expect(200);

    const row = await readConversationRow(conversation.id);
    expect(row?.assigned_to).toBe(bruno.id);
  });

  it('devolver para a fila (assignedTo: null) registra o evento', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });

    const response = await app.agent
      .patch(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(ana))
      .send({ assignedTo: null })
      .expect(200);
    expect(response.body.assignedTo).toBeNull();

    const detalhe = await app.agent
      .get(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(ana))
      .expect(200);
    expect(detalhe.body.messages.at(-1).content).toBe('Conversa devolvida para a fila por Ana');
  });
});

describe('PATCH /conversations/:id — status e tags', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ modules: [conversationModule] });
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('arquiva a conversa', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });

    const response = await app.agent
      .patch(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(ana))
      .send({ status: 'archived' })
      .expect(200);
    expect(response.body.status).toBe('archived');

    const row = await readConversationRow(conversation.id);
    expect(row?.status).toBe('archived');
  });

  it('atualiza tags e status na mesma chamada', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });

    const response = await app.agent
      .patch(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(ana))
      .send({ status: 'archived', tags: ['orcamento', 'realizado'] })
      .expect(200);

    expect(response.body.status).toBe('archived');
    expect(response.body.tags).toEqual(['orcamento', 'realizado']);
  });

  it('conversa de outro tenant -> 404', async () => {
    const alfa = await createTenant();
    const beta = await createTenant();
    const adminAlfa = await createUser({ tenantId: alfa.id, role: 'admin' });
    const daBeta = await createConversation({ tenantId: beta.id });

    const response = await app.agent
      .patch(`/api/v1/conversations/${daBeta.id}`)
      .set(app.auth(adminAlfa))
      .send({ status: 'archived' })
      .expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');

    // Nada mudou no tenant vizinho.
    const row = await readConversationRow(daBeta.id);
    expect(row?.status).toBe('active');
  });

  it('corpo vazio -> VALIDATION_ERROR', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });

    const response = await app.agent
      .patch(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(ana))
      .send({})
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /conversations/:id/read', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ modules: [conversationModule] });
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('zera unread_count e marca as mensagens do paciente como lidas', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });

    await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      senderType: 'patient',
      status: 'delivered',
    });
    await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      senderType: 'patient',
      status: 'delivered',
    });
    await setUnreadCount(conversation.id, 2);

    // A listagem mostra o badge; abrir a conversa e que zera.
    const lista = await app.agent
      .get('/api/v1/conversations')
      .set(app.auth(ana))
      .expect(200);
    expect(lista.body.conversations[0].unreadCount).toBe(2);

    await app.agent
      .post(`/api/v1/conversations/${conversation.id}/read`)
      .set(app.auth(ana))
      .expect(204);

    const depois = await app.agent
      .get(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(ana))
      .expect(200);
    expect(depois.body.conversation.unreadCount).toBe(0);
    for (const message of depois.body.messages) {
      expect(message.status).toBe('read');
      expect(message.readAt).not.toBeNull();
    }
  });

  it('conversa de outro tenant -> 404 e contador intacto', async () => {
    const alfa = await createTenant();
    const beta = await createTenant();
    const adminAlfa = await createUser({ tenantId: alfa.id, role: 'admin' });
    const daBeta = await createConversation({ tenantId: beta.id });
    await setUnreadCount(daBeta.id, 5);

    await app.agent
      .post(`/api/v1/conversations/${daBeta.id}/read`)
      .set(app.auth(adminAlfa))
      .expect(404);

    const row = await readConversationRow(daBeta.id);
    expect(row?.unread_count).toBe(5);
  });
});

/**
 * PAGES.md §2 ("Ao abrir: markAsRead") + o exemplo de API_CONTRACTS.md §2, que
 * mostra o detalhe com `unreadCount: 0` enquanto a listagem traz `3`.
 */
describe('GET /conversations/:id marca a conversa como lida', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ modules: [conversationModule] });
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('abrir a conversa zera o contador e marca as mensagens do paciente', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
    await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      senderType: 'patient',
      status: 'delivered',
    });
    await setUnreadCount(conversation.id, 3);

    const detalhe = await app.agent
      .get(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(ana))
      .expect(200);

    expect(detalhe.body.conversation.unreadCount).toBe(0);
    expect(detalhe.body.messages[0].status).toBe('read');

    const row = await readConversationRow(conversation.id);
    expect(row?.unread_count).toBe(0);
  });

  it('nao marca nada quando a conversa nao e visivel para o usuario', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const bruno = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const doBruno = await createConversation({ tenantId: tenant.id, assignedTo: bruno.id });
    await setUnreadCount(doBruno.id, 4);

    await app.agent
      .get(`/api/v1/conversations/${doBruno.id}`)
      .set(app.auth(ana))
      .expect(404);

    const row = await readConversationRow(doBruno.id);
    expect(row?.unread_count).toBe(4);
  });
});
