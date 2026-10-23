/**
 * Contador da barra lateral (CRMLAB-112, D-277) — API_CONTRACTS.md:
 *
 *   GET /conversations/unread-count   { unreadMessages }
 *
 * Soma de `unread_count` (mensagens, nao conversas) das conversas ATIVAS que
 * quem pede enxerga: atendente = as proprias + fila livre + as em que
 * participa (D-263); gestora/admin = todas do tenant. Encerradas nao contam.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConversationUnreadCountResponse } from '@crm-lab/shared';
import { conversationModule } from '../../src/controllers/conversation.routes.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { setUnreadCount } from './helpers.js';

async function addParticipant(tenantId: string, conversationId: string, userId: string) {
  const db = await getTestDb();
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO conversation_participants (tenant_id, conversation_id, user_id)
       VALUES ($1, $2, $3)`,
      [tenantId, conversationId, userId],
    ),
  );
}

describe('GET /conversations/unread-count (D-277)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ modules: [conversationModule] });
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  async function countFor(user: Parameters<TestApp['auth']>[0]): Promise<number> {
    const response = await app.agent
      .get('/api/v1/conversations/unread-count')
      .set(app.auth(user))
      .expect(200);
    return (response.body as ConversationUnreadCountResponse).unreadMessages;
  }

  it('atendente soma as proprias, a fila livre e as em que participa; nao soma a de outra nem encerrada', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const bia = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const minha = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
    const livre = await createConversation({ tenantId: tenant.id, assignedTo: null });
    const daBia = await createConversation({ tenantId: tenant.id, assignedTo: bia.id });
    const participo = await createConversation({ tenantId: tenant.id, assignedTo: bia.id });
    const encerrada = await createConversation({
      tenantId: tenant.id,
      assignedTo: ana.id,
      status: 'closed',
    });
    await setUnreadCount(minha.id, 3);
    await setUnreadCount(livre.id, 2);
    await setUnreadCount(daBia.id, 7);
    await setUnreadCount(participo.id, 4);
    await setUnreadCount(encerrada.id, 9);
    await addParticipant(tenant.id, participo.id, ana.id);

    expect(await countFor(ana)).toBe(3 + 2 + 4);
    expect(await countFor(bia)).toBe(2 + 7 + 4);
  });

  it('gestora e admin somam todas as ativas do tenant, nunca as encerradas', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const gestora = await createUser({ tenantId: tenant.id, role: 'manager' });
    const admin = await createUser({ tenantId: tenant.id, role: 'admin' });
    const daAna = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
    const livre = await createConversation({ tenantId: tenant.id, assignedTo: null });
    const encerrada = await createConversation({ tenantId: tenant.id, status: 'closed' });
    await setUnreadCount(daAna.id, 5);
    await setUnreadCount(livre.id, 1);
    await setUnreadCount(encerrada.id, 8);

    expect(await countFor(gestora)).toBe(6);
    expect(await countFor(admin)).toBe(6);
  });

  it('sem nao lidas devolve zero', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
    expect(await countFor(ana)).toBe(0);
  });

  it('nao soma conversa de outro tenant (nem para a gestora)', async () => {
    const alfa = await createTenant();
    const beta = await createTenant();
    const gestora = await createUser({ tenantId: alfa.id, role: 'manager' });
    const ana = await createUser({ tenantId: alfa.id, role: 'attendant' });
    const alheia = await createConversation({ tenantId: beta.id, assignedTo: null });
    await setUnreadCount(alheia.id, 11);

    expect(await countFor(gestora)).toBe(0);
    expect(await countFor(ana)).toBe(0);
  });
});
