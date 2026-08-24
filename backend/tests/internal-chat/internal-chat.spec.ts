/**
 * InternalChatService + rotas — SERVICES.md §7, WORKFLOWS.md §6.
 *
 * Regra de PAGES.md §11 coberta aqui: o console de plataforma NAO acessa canais
 * internos de laboratorio.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiErrorBody,
  InternalMessage,
  ListChannelsResponse,
  ListInternalMessagesResponse,
} from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { internalChatModule } from '../../src/controllers/internal-chat.routes.js';
import { proposalModule } from '../../src/controllers/proposal.routes.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createProposal, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

const CHANNEL_KEYS = ['id', 'key', 'kind', 'lastMessageAt', 'name', 'unreadCount'];
const MESSAGE_KEYS = [
  'attachedProposalId',
  'channelId',
  'content',
  'createdAt',
  'id',
  'isSystem',
  'senderId',
  'senderName',
];

describe('/api/v1/internal-chat', () => {
  let db: DbClient;
  let app: TestApp;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    app = await createTestApp({ db, modules: [internalChatModule, proposalModule] });
  });

  async function channelsOf(
    user: Parameters<TestApp['auth']>[0],
  ): Promise<ListChannelsResponse['channels']> {
    const response = await app.agent
      .get('/api/v1/internal-chat/channels')
      .set(app.auth(user))
      .expect(200);
    return (response.body as ListChannelsResponse).channels;
  }

  it('lista os canais padrao #geral e #aprovacoes no shape do contrato', async () => {
    const tenant = await createTenant();
    const user = await createUser({ tenantId: tenant.id, role: 'attendant' });

    const channels = await channelsOf(user);
    expect(channels.map((c) => c.key).sort()).toEqual(['aprovacoes', 'geral']);
    expect(Object.keys(channels[0] as object).sort()).toEqual(CHANNEL_KEYS);
    expect(channels.every((c) => c.kind === 'channel')).toBe(true);
  });

  it('nao duplica canais quando listado duas vezes', async () => {
    const tenant = await createTenant();
    const user = await createUser({ tenantId: tenant.id, role: 'attendant' });

    await channelsOf(user);
    const segunda = await channelsOf(user);
    expect(segunda).toHaveLength(2);
  });

  it('envia mensagem e a devolve no shape de InternalMessage', async () => {
    const tenant = await createTenant();
    const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const channels = await channelsOf(user);
    const geral = channels.find((c) => c.key === 'geral');

    const response = await app.agent
      .post(`/api/v1/internal-chat/channels/${geral?.id}/messages`)
      .set(app.auth(user))
      .send({ content: 'Bom dia, equipe' })
      .expect(201);

    const message = response.body as InternalMessage;
    expect(Object.keys(message).sort()).toEqual(MESSAGE_KEYS);
    expect(message.senderName).toBe(user.name);
    expect(message.isSystem).toBe(false);
    expect(message.attachedProposalId).toBeNull();

    // WebSocket: notificacao com IDs, para o tenant certo.
    const eventos = app.wsHub.eventsFor(tenant.id, 'internal_chat.new_message');
    expect(eventos).toHaveLength(1);
    expect(eventos[0]?.data).toEqual({ channelId: geral?.id, messageId: message.id });
  });

  it('anexa proposta do proprio tenant', async () => {
    const tenant = await createTenant();
    const user = await createUser({ tenantId: tenant.id, role: 'manager' });
    const proposal = await createProposal({ tenantId: tenant.id, createdBy: user.id });
    const channels = await channelsOf(user);
    const geral = channels.find((c) => c.key === 'geral');

    const response = await app.agent
      .post(`/api/v1/internal-chat/channels/${geral?.id}/messages`)
      .set(app.auth(user))
      .send({ content: 'Olhem este orçamento', attachedProposalId: proposal.id })
      .expect(201);

    expect((response.body as InternalMessage).attachedProposalId).toBe(proposal.id);
  });

  it('anexar proposta de outro tenant -> 404', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const user = await createUser({ tenantId: a.id, role: 'manager' });
    const alheia = await createProposal({ tenantId: b.id });
    const channels = await channelsOf(user);
    const geral = channels.find((c) => c.key === 'geral');

    const response = await app.agent
      .post(`/api/v1/internal-chat/channels/${geral?.id}/messages`)
      .set(app.auth(user))
      .send({ content: 'Espiando o vizinho', attachedProposalId: alheia.id })
      .expect(404);
    expect((response.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
  });

  it('lista mensagens paginadas, em ordem cronologica', async () => {
    const tenant = await createTenant();
    const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const channels = await channelsOf(user);
    const geral = channels.find((c) => c.key === 'geral');

    for (const content of ['primeira', 'segunda', 'terceira']) {
      await app.agent
        .post(`/api/v1/internal-chat/channels/${geral?.id}/messages`)
        .set(app.auth(user))
        .send({ content })
        .expect(201);
    }

    const response = await app.agent
      .get(`/api/v1/internal-chat/channels/${geral?.id}/messages?page=1&limit=2`)
      .set(app.auth(user))
      .expect(200);

    const body = response.body as ListInternalMessagesResponse;
    expect(Object.keys(body).sort()).toEqual(['messages', 'pagination']);
    expect(body.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(body.messages.map((m) => m.content)).toEqual(['primeira', 'segunda']);
  });

  it('canal de outro tenant -> 404 (nunca 403)', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const userA = await createUser({ tenantId: a.id, role: 'manager' });
    const userB = await createUser({ tenantId: b.id, role: 'manager' });

    const canaisB = await channelsOf(userB);
    const alvo = canaisB[0];

    await app.agent
      .get(`/api/v1/internal-chat/channels/${alvo?.id}/messages`)
      .set(app.auth(userA))
      .expect(404);

    await app.agent
      .post(`/api/v1/internal-chat/channels/${alvo?.id}/messages`)
      .set(app.auth(userA))
      .send({ content: 'oi' })
      .expect(404);
  });

  it('mensagem de um tenant nunca aparece no canal do outro', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const userA = await createUser({ tenantId: a.id, role: 'manager' });
    const userB = await createUser({ tenantId: b.id, role: 'manager' });

    const canalA = (await channelsOf(userA)).find((c) => c.key === 'geral');
    await app.agent
      .post(`/api/v1/internal-chat/channels/${canalA?.id}/messages`)
      .set(app.auth(userA))
      .send({ content: 'segredo do lab A' })
      .expect(201);

    const canalB = (await channelsOf(userB)).find((c) => c.key === 'geral');
    const response = await app.agent
      .get(`/api/v1/internal-chat/channels/${canalB?.id}/messages`)
      .set(app.auth(userB))
      .expect(200);
    expect((response.body as ListInternalMessagesResponse).messages).toHaveLength(0);
  });

  it('operador de plataforma NAO acessa canais de laboratorio (PAGES.md §11)', async () => {
    const tenant = await createTenant();
    const operador = await createUser({
      tenantId: tenant.id,
      role: 'platform_operator',
      discountLimit: 0,
    });

    const response = await app.agent
      .get('/api/v1/internal-chat/channels')
      .set(app.auth(operador))
      .expect(403);
    expect((response.body as ApiErrorBody).error.code).toBe('FORBIDDEN');
  });

  it('conteudo vazio -> VALIDATION_ERROR', async () => {
    const tenant = await createTenant();
    const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const geral = (await channelsOf(user)).find((c) => c.key === 'geral');

    await app.agent
      .post(`/api/v1/internal-chat/channels/${geral?.id}/messages`)
      .set(app.auth(user))
      .send({ content: '' })
      .expect(400);
  });

  it('sem token -> 401', async () => {
    await app.agent.get('/api/v1/internal-chat/channels').expect(401);
  });
});
