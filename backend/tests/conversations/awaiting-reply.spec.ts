/**
 * `Conversation.awaitingReplySince` — alerta de tempo de resposta (CRMLAB-84,
 * D-254), API_CONTRACTS.md §2.
 *
 * A espera comeca na PRIMEIRA mensagem do paciente depois da ultima resposta
 * de pessoa do laboratorio (`sender_type = 'agent'` e `automation` nulo). A
 * mensagem automatica (reingajamento) e a de sistema nao tiram do alerta;
 * conversa encerrada nunca espera.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Conversation, ListConversationsResponse, SenderType } from '@crm-lab/shared';
import { conversationModule } from '../../src/controllers/conversation.routes.js';
import { createConversation, createTenant, createUser, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

interface Seed {
  senderType: SenderType;
  at: string;
  automation?: 'reengagement';
  senderId?: string | null;
}

async function seed(tenantId: string, conversationId: string, messages: Seed[]): Promise<void> {
  const db = await getTestDb();
  await db.withoutTenant(async (tx) => {
    for (const m of messages) {
      await tx.query(
        `INSERT INTO messages (id, tenant_id, conversation_id, sender_type, sender_id, content,
                               message_type, status, automation, created_at)
         VALUES ($1, $2, $3, $4, $5, 'oi', 'text', 'delivered', $6, $7::timestamp)`,
        [randomUUID(), tenantId, conversationId, m.senderType, m.senderId ?? null, m.automation ?? null, m.at],
      );
    }
  });
}

describe('awaitingReplySince na lista e no detalhe (D-254)', () => {
  let app: TestApp;
  let tenantId: string;
  let ana: UserRecord;

  beforeAll(async () => {
    app = await createTestApp({ modules: [conversationModule] });
  });

  beforeEach(async () => {
    await resetDatabase();
    tenantId = (await createTenant()).id;
    ana = await createUser({ tenantId, role: 'manager' });
  });

  async function listed(id: string, status: 'active' | 'closed' = 'active'): Promise<Conversation | undefined> {
    const res = await app.agent
      .get(`/api/v1/conversations?status=${status}&scope=all`)
      .set(app.auth(ana))
      .expect(200);
    return (res.body as ListConversationsResponse).conversations.find((c) => c.id === id);
  }

  it('sem resposta humana ainda: a primeira mensagem do paciente', async () => {
    const c = await createConversation({ tenantId });
    await seed(tenantId, c.id, [
      { senderType: 'patient', at: '2026-10-01 12:00:00' },
      { senderType: 'patient', at: '2026-10-01 12:05:00' },
    ]);
    expect((await listed(c.id))?.awaitingReplySince).toBe('2026-10-01T12:00:00.000Z');
  });

  it('a atendente respondeu por ultimo: null', async () => {
    const c = await createConversation({ tenantId });
    await seed(tenantId, c.id, [
      { senderType: 'patient', at: '2026-10-01 12:00:00' },
      { senderType: 'agent', senderId: ana.id, at: '2026-10-01 12:10:00' },
    ]);
    expect((await listed(c.id))?.awaitingReplySince).toBeNull();
  });

  it('resposta pelo celular (agent sem sender_id) tambem conta como resposta', async () => {
    const c = await createConversation({ tenantId });
    await seed(tenantId, c.id, [
      { senderType: 'patient', at: '2026-10-01 12:00:00' },
      { senderType: 'agent', senderId: null, at: '2026-10-01 12:10:00' },
    ]);
    expect((await listed(c.id))?.awaitingReplySince).toBeNull();
  });

  it('conta a partir da primeira do paciente DEPOIS da ultima resposta humana', async () => {
    const c = await createConversation({ tenantId });
    await seed(tenantId, c.id, [
      { senderType: 'patient', at: '2026-10-01 11:00:00' },
      { senderType: 'agent', senderId: ana.id, at: '2026-10-01 11:30:00' },
      { senderType: 'patient', at: '2026-10-01 12:00:00' },
      { senderType: 'patient', at: '2026-10-01 12:20:00' },
    ]);
    expect((await listed(c.id))?.awaitingReplySince).toBe('2026-10-01T12:00:00.000Z');
  });

  it('mensagem automatica e de sistema depois do paciente NAO tiram do alerta', async () => {
    const c = await createConversation({ tenantId });
    await seed(tenantId, c.id, [
      { senderType: 'agent', senderId: ana.id, at: '2026-10-01 11:00:00' },
      { senderType: 'patient', at: '2026-10-01 12:00:00' },
      { senderType: 'agent', automation: 'reengagement', at: '2026-10-01 13:00:00' },
      { senderType: 'system', at: '2026-10-01 13:05:00' },
    ]);
    const item = await listed(c.id);
    expect(item?.awaitingReplySince).toBe('2026-10-01T12:00:00.000Z');

    const detail = await app.agent.get(`/api/v1/conversations/${c.id}`).set(app.auth(ana)).expect(200);
    expect((detail.body as { conversation: Conversation }).conversation.awaitingReplySince).toBe(
      '2026-10-01T12:00:00.000Z',
    );
  });

  it('automatica sozinha nao vira resposta nem espera: so automatica e sistema = null', async () => {
    const c = await createConversation({ tenantId });
    await seed(tenantId, c.id, [
      { senderType: 'agent', automation: 'reengagement', at: '2026-10-01 13:00:00' },
      { senderType: 'system', at: '2026-10-01 13:05:00' },
    ]);
    expect((await listed(c.id))?.awaitingReplySince).toBeNull();
  });

  it('conversa encerrada nunca espera', async () => {
    const c = await createConversation({ tenantId, status: 'closed' });
    await seed(tenantId, c.id, [{ senderType: 'patient', at: '2026-10-01 12:00:00' }]);
    expect((await listed(c.id, 'closed'))?.awaitingReplySince).toBeNull();
  });
});
