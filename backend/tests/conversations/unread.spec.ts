/**
 * "Nao lidas" (CRMLAB-68, D-229) — API_CONTRACTS.md §2:
 *
 *   POST /conversations/:id/unread   unread_count = max(unread_count, 1)
 *   GET  /conversations?unread=true  so com nao lidas; `counts.unread`
 *
 * O contador e POR CONVERSA (o que ja existia). Marcar como nao lida nao mexe
 * em `last_message_at` (o aviso de mensagem nova depende dele, D-241) e nao
 * emite WebSocket.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ListConversationsResponse } from '@crm-lab/shared';
import { conversationModule } from '../../src/controllers/conversation.routes.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { FakeWsHub } from '../helpers/fake-ws.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { readConversationRow, seedMessage, setUnreadCount } from './helpers.js';

async function lastMessageAt(conversationId: string): Promise<string> {
  const db = await getTestDb();
  const found = await db.withoutTenant((tx) =>
    tx.query<{ at: string }>(
      'SELECT last_message_at::text AS at FROM conversations WHERE id = $1',
      [conversationId],
    ),
  );
  return found.rows[0]?.at ?? '';
}

describe('POST /conversations/:id/unread e ?unread=true (D-229)', () => {
  let app: TestApp;
  const ws = new FakeWsHub();

  beforeAll(async () => {
    app = await createTestApp({ modules: [conversationModule], wsHub: ws });
  });

  beforeEach(async () => {
    await resetDatabase();
    ws.clear();
  });

  it('marca como nao lida sem mexer em last_message_at nem emitir WS; abrir zera de novo', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
    await seedMessage({ tenantId: tenant.id, conversationId: conversation.id, status: 'read' });
    const before = await lastMessageAt(conversation.id);

    await app.agent
      .post(`/api/v1/conversations/${conversation.id}/unread`)
      .set(app.auth(ana))
      .expect(204);
    expect((await readConversationRow(conversation.id))?.unread_count).toBe(1);
    expect(await lastMessageAt(conversation.id)).toBe(before);
    expect(ws.emitted).toHaveLength(0);

    // Idempotente.
    await app.agent
      .post(`/api/v1/conversations/${conversation.id}/unread`)
      .set(app.auth(ana))
      .expect(204);
    expect((await readConversationRow(conversation.id))?.unread_count).toBe(1);

    const detail = await app.agent
      .get(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(ana))
      .expect(200);
    expect(detail.body.conversation.unreadCount).toBe(0);
    expect((await readConversationRow(conversation.id))?.unread_count).toBe(0);
  });

  it('conversa que ja tinha nao lidas continua com o numero dela', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
    await setUnreadCount(conversation.id, 3);
    await app.agent
      .post(`/api/v1/conversations/${conversation.id}/unread`)
      .set(app.auth(ana))
      .expect(204);
    expect((await readConversationRow(conversation.id))?.unread_count).toBe(3);
  });

  it('conversa de outra atendente ou de outro tenant -> 404, sem efeito', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const bia = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const daBia = await createConversation({ tenantId: tenant.id, assignedTo: bia.id });
    const outro = await createTenant();
    const alheia = await createConversation({ tenantId: outro.id });

    for (const id of [daBia.id, alheia.id]) {
      const response = await app.agent
        .post(`/api/v1/conversations/${id}/unread`)
        .set(app.auth(ana))
        .expect(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect((await readConversationRow(id))?.unread_count).toBe(0);
    }
  });

  it('?unread=true lista so as com nao lidas; counts.unread sai do mesmo recorte e nao muda com o filtro', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const bia = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const lida = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
    const naoLida = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
    const livreNaoLida = await createConversation({ tenantId: tenant.id, assignedTo: null });
    const daBia = await createConversation({ tenantId: tenant.id, assignedTo: bia.id });
    await setUnreadCount(naoLida.id, 2);
    await setUnreadCount(livreNaoLida.id, 1);
    await setUnreadCount(daBia.id, 5);

    const todas = await app.agent.get('/api/v1/conversations').set(app.auth(ana)).expect(200);
    const all = todas.body as ListConversationsResponse;
    expect(all.counts).toEqual({ mine: 2, unassigned: 1, unread: 2, participating: 0 });
    expect(all.pagination.total).toBe(3);

    const filtrada = await app.agent
      .get('/api/v1/conversations?unread=true')
      .set(app.auth(ana))
      .expect(200);
    const unread = filtrada.body as ListConversationsResponse;
    expect(unread.conversations.map((c) => c.id).sort()).toEqual(
      [naoLida.id, livreNaoLida.id].sort(),
    );
    expect(unread.pagination.total).toBe(2);
    expect(unread.counts).toEqual(all.counts);
    expect(unread.conversations.map((c) => c.id)).not.toContain(lida.id);

    const semFiltro = await app.agent
      .get('/api/v1/conversations?unread=false')
      .set(app.auth(ana))
      .expect(200);
    expect(semFiltro.body.pagination.total).toBe(3);

    await app.agent.get('/api/v1/conversations?unread=sim').set(app.auth(ana)).expect(400);
  });
});
