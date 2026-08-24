/**
 * GET /conversations e GET /conversations/:id — API_CONTRACTS.md §2.
 *
 * Cobre as duas camadas de recorte que a tela depende:
 *  - entre tenants (RLS): conversa de outro laboratorio nao aparece e da 404
 *  - dentro do tenant (regra de negocio): atendente ve as proprias + a fila
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { conversationModule } from '../../src/controllers/conversation.routes.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/test-db.js';
import { seedMessage } from './helpers.js';

describe('GET /conversations', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ modules: [conversationModule] });
  });

  beforeEach(async () => {
    await resetDatabase();
    app.wsHub.clear();
  });

  it('devolve o shape do contrato: conversations + pagination + counts', async () => {
    const tenant = await createTenant();
    const attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const conversation = await createConversation({
      tenantId: tenant.id,
      assignedTo: attendant.id,
      patientName: 'Joao Santos',
      patientPhone: '+5511987654321',
    });
    await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      content: 'Quanto custa um hemograma?',
    });

    const response = await app.agent
      .get('/api/v1/conversations')
      .set(app.auth(attendant))
      .expect(200);

    expect(Object.keys(response.body).sort()).toEqual(['conversations', 'counts', 'pagination']);
    expect(response.body.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
    expect(response.body.counts).toEqual({ mine: 1, unassigned: 0 });

    const item = response.body.conversations[0];
    expect(Object.keys(item).sort()).toEqual([
      'assignedTo',
      'assignedToName',
      'channel',
      'createdAt',
      'id',
      'lastMessageAt',
      'lastMessagePreview',
      'patientName',
      'patientPhone',
      'status',
      'tags',
      'unreadCount',
    ]);
    expect(item.assignedTo).toBe(attendant.id);
    expect(item.assignedToName).toBe(attendant.name);
    expect(item.lastMessagePreview).toBe('Quanto custa um hemograma?');
    expect(item.tags).toEqual([]);
    // ISO 8601 UTC no fio (CLAUDE.md regra 9).
    expect(item.createdAt).toMatch(/Z$/);
  });

  it('atendente ve as proprias e as nao atribuidas; nao ve a de outro atendente', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    const bruno = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Bruno' });

    const daAna = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
    const doBruno = await createConversation({ tenantId: tenant.id, assignedTo: bruno.id });
    const livre = await createConversation({ tenantId: tenant.id, assignedTo: null });

    const response = await app.agent.get('/api/v1/conversations').set(app.auth(ana)).expect(200);

    const ids = response.body.conversations.map((c: { id: string }) => c.id).sort();
    expect(ids).toEqual([daAna.id, livre.id].sort());
    expect(ids).not.toContain(doBruno.id);
    expect(response.body.pagination.total).toBe(2);
  });

  it('gestor ve todas as conversas do laboratorio', async () => {
    const tenant = await createTenant();
    const gestor = await createUser({ tenantId: tenant.id, role: 'manager' });
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const bruno = await createUser({ tenantId: tenant.id, role: 'attendant' });

    await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
    await createConversation({ tenantId: tenant.id, assignedTo: bruno.id });
    await createConversation({ tenantId: tenant.id, assignedTo: null });

    const response = await app.agent.get('/api/v1/conversations').set(app.auth(gestor)).expect(200);
    expect(response.body.pagination.total).toBe(3);
    // O gestor nao "possui" nenhuma: o chip "Minhas" reflete isso.
    expect(response.body.counts).toEqual({ mine: 0, unassigned: 1 });
  });

  it('counts.mine e counts.unassigned batem com a listagem filtrada por escopo', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
    await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
    await createConversation({ tenantId: tenant.id, assignedTo: null });
    await createConversation({ tenantId: tenant.id, assignedTo: null });
    await createConversation({ tenantId: tenant.id, assignedTo: null });

    const todas = await app.agent.get('/api/v1/conversations').set(app.auth(ana)).expect(200);
    expect(todas.body.counts).toEqual({ mine: 2, unassigned: 3 });

    const minhas = await app.agent
      .get('/api/v1/conversations?scope=mine')
      .set(app.auth(ana))
      .expect(200);
    expect(minhas.body.conversations).toHaveLength(minhas.body.counts.mine);
    expect(minhas.body.pagination.total).toBe(2);
    // O chip nao clicado continua mostrando o proprio numero.
    expect(minhas.body.counts).toEqual({ mine: 2, unassigned: 3 });

    const livres = await app.agent
      .get('/api/v1/conversations?scope=unassigned')
      .set(app.auth(ana))
      .expect(200);
    expect(livres.body.conversations).toHaveLength(livres.body.counts.unassigned);
    expect(livres.body.pagination.total).toBe(3);
  });

  it('busca por nome e por telefone', async () => {
    const tenant = await createTenant();
    const gestor = await createUser({ tenantId: tenant.id, role: 'manager' });
    const joao = await createConversation({
      tenantId: tenant.id,
      patientName: 'Joao Santos',
      patientPhone: '+5511987654321',
    });
    await createConversation({
      tenantId: tenant.id,
      patientName: 'Maria Silva',
      patientPhone: '+5548999111222',
    });

    const porNome = await app.agent
      .get('/api/v1/conversations?search=Santos')
      .set(app.auth(gestor))
      .expect(200);
    expect(porNome.body.conversations.map((c: { id: string }) => c.id)).toEqual([joao.id]);

    // O usuario digita formatado; o banco guarda em E.164.
    const porTelefone = await app.agent
      .get('/api/v1/conversations?search=(11) 98765-4321')
      .set(app.auth(gestor))
      .expect(200);
    expect(porTelefone.body.conversations.map((c: { id: string }) => c.id)).toEqual([joao.id]);
  });

  it('pagina com limite e ordena por lastMessageAt desc por padrao', async () => {
    const tenant = await createTenant();
    const gestor = await createUser({ tenantId: tenant.id, role: 'manager' });
    for (let i = 0; i < 3; i += 1) {
      await createConversation({ tenantId: tenant.id });
    }

    const response = await app.agent
      .get('/api/v1/conversations?page=1&limit=2')
      .set(app.auth(gestor))
      .expect(200);

    expect(response.body.conversations).toHaveLength(2);
    expect(response.body.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
  });

  it('platform_operator recebe FORBIDDEN — o console nao acessa conversas', async () => {
    const tenant = await createTenant();
    const operador = await createUser({ tenantId: tenant.id, role: 'platform_operator' });
    await createConversation({ tenantId: tenant.id });

    const response = await app.agent
      .get('/api/v1/conversations')
      .set(app.auth(operador))
      .expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('sem token -> 401', async () => {
    await app.agent.get('/api/v1/conversations').expect(401);
  });
});

describe('GET /conversations — isolamento multitenant (bloqueante)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ modules: [conversationModule] });
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('a listagem nunca traz conversa de outro tenant', async () => {
    const alfa = await createTenant();
    const beta = await createTenant();
    const gestorAlfa = await createUser({ tenantId: alfa.id, role: 'manager' });
    await createConversation({ tenantId: alfa.id, patientName: 'Do Alfa' });
    const daBeta = await createConversation({ tenantId: beta.id, patientName: 'Do Beta' });

    const response = await app.agent
      .get('/api/v1/conversations')
      .set(app.auth(gestorAlfa))
      .expect(200);

    expect(response.body.pagination.total).toBe(1);
    expect(response.body.conversations.map((c: { id: string }) => c.id)).not.toContain(daBeta.id);
  });

  it('a busca nunca cruza tenants', async () => {
    const alfa = await createTenant();
    const beta = await createTenant();
    const gestorAlfa = await createUser({ tenantId: alfa.id, role: 'manager' });
    await createConversation({
      tenantId: beta.id,
      patientName: 'Joao Santos',
      patientPhone: '+5511987654321',
    });

    const porNome = await app.agent
      .get('/api/v1/conversations?search=Santos')
      .set(app.auth(gestorAlfa))
      .expect(200);
    expect(porNome.body.conversations).toEqual([]);
    expect(porNome.body.counts).toEqual({ mine: 0, unassigned: 0 });

    const porTelefone = await app.agent
      .get('/api/v1/conversations?search=987654321')
      .set(app.auth(gestorAlfa))
      .expect(200);
    expect(porTelefone.body.conversations).toEqual([]);
  });

  it('GET /conversations/:id de outro tenant -> 404, nunca 403', async () => {
    const alfa = await createTenant();
    const beta = await createTenant();
    const gestorAlfa = await createUser({ tenantId: alfa.id, role: 'admin' });
    const daBeta = await createConversation({ tenantId: beta.id });

    const response = await app.agent
      .get(`/api/v1/conversations/${daBeta.id}`)
      .set(app.auth(gestorAlfa))
      .expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});

describe('GET /conversations/:id', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ modules: [conversationModule] });
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('devolve conversa + mensagens paginadas no shape do contrato', async () => {
    const tenant = await createTenant();
    const attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const conversation = await createConversation({
      tenantId: tenant.id,
      assignedTo: attendant.id,
      patientName: 'Joao Santos',
      patientEmail: 'joao@email.com',
    });
    await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      senderType: 'patient',
      content: 'Ola',
    });
    await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      senderType: 'agent',
      senderId: attendant.id,
      content: 'Oi Joao',
    });

    const response = await app.agent
      .get(`/api/v1/conversations/${conversation.id}?messageLimit=50&page=1`)
      .set(app.auth(attendant))
      .expect(200);

    expect(Object.keys(response.body).sort()).toEqual([
      'conversation',
      'messages',
      'pagination',
    ]);
    expect(response.body.conversation.patientEmail).toBe('joao@email.com');
    expect(response.body.conversation.customFields).toEqual({});
    expect(response.body.pagination).toEqual({ page: 1, limit: 50, total: 2, totalPages: 1 });

    const [primeira, segunda] = response.body.messages;
    expect(Object.keys(primeira).sort()).toEqual([
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
    // Ordem cronologica crescente: o frontend renderiza de cima para baixo.
    expect(primeira.content).toBe('Ola');
    expect(primeira.senderType).toBe('patient');
    expect(primeira.senderName).toBe('Joao Santos');
    expect(segunda.senderType).toBe('agent');
    expect(segunda.senderName).toBe(attendant.name);
  });

  it('conversa de OUTRO atendente do mesmo tenant -> 404 (nao 403)', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const bruno = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const doBruno = await createConversation({ tenantId: tenant.id, assignedTo: bruno.id });

    const response = await app.agent
      .get(`/api/v1/conversations/${doBruno.id}`)
      .set(app.auth(ana))
      .expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');

    // O gestor enxerga a mesma conversa.
    const gestor = await createUser({ tenantId: tenant.id, role: 'manager' });
    await app.agent
      .get(`/api/v1/conversations/${doBruno.id}`)
      .set(app.auth(gestor))
      .expect(200);
  });
});
