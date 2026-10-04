/**
 * `Conversation.awaitingReplySince` — alerta de tempo de resposta (CRMLAB-84,
 * D-254), API_CONTRACTS.md §2.
 *
 * A espera comeca na PRIMEIRA mensagem do paciente depois da ultima resposta
 * de pessoa do laboratorio (`sender_type = 'agent'` e `automation` nulo). A
 * mensagem automatica (reingajamento) e a de sistema nao tiram do alerta;
 * conversa encerrada nunca espera.
 *
 * Desde a D-259 (CRMLAB-90) o encerramento ("Atendimento encerrado por X")
 * tambem e fronteira, como no relatorio de tempo de resposta (D-257).
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
  content?: string;
}

async function seed(tenantId: string, conversationId: string, messages: Seed[]): Promise<void> {
  const db = await getTestDb();
  await db.withoutTenant(async (tx) => {
    for (const m of messages) {
      await tx.query(
        `INSERT INTO messages (id, tenant_id, conversation_id, sender_type, sender_id, content,
                               message_type, status, automation, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'text', 'delivered', $7, $8::timestamp)`,
        [
          randomUUID(),
          tenantId,
          conversationId,
          m.senderType,
          m.senderId ?? null,
          m.content ?? 'oi',
          m.automation ?? null,
          m.at,
        ],
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

  describe('encerramento como fronteira (CRMLAB-90, D-259)', () => {
    const CLOSED = 'Atendimento encerrado por Ana';

    it('obrigado -> encerra -> paciente volta dias depois: conta so da mensagem nova', async () => {
      const c = await createConversation({ tenantId });
      await seed(tenantId, c.id, [
        { senderType: 'patient', at: '2026-09-20 10:00:00' },
        { senderType: 'agent', senderId: ana.id, at: '2026-09-20 10:05:00' },
        { senderType: 'patient', content: 'obrigado', at: '2026-09-20 10:10:00' },
        { senderType: 'system', content: CLOSED, at: '2026-09-20 10:15:00' },
        { senderType: 'patient', at: '2026-10-01 12:00:00' },
        { senderType: 'patient', at: '2026-10-01 12:03:00' },
      ]);
      expect((await listed(c.id))?.awaitingReplySince).toBe('2026-10-01T12:00:00.000Z');

      const detail = await app.agent.get(`/api/v1/conversations/${c.id}`).set(app.auth(ana)).expect(200);
      expect((detail.body as { conversation: Conversation }).conversation.awaitingReplySince).toBe(
        '2026-10-01T12:00:00.000Z',
      );
    });

    it('sem nenhuma resposta humana antes do encerramento: tambem zera', async () => {
      const c = await createConversation({ tenantId });
      await seed(tenantId, c.id, [
        { senderType: 'patient', at: '2026-09-20 10:00:00' },
        { senderType: 'system', content: CLOSED, at: '2026-09-20 10:15:00' },
        { senderType: 'patient', at: '2026-10-01 12:00:00' },
      ]);
      expect((await listed(c.id))?.awaitingReplySince).toBe('2026-10-01T12:00:00.000Z');
    });

    it('reaberta sem mensagem nova do paciente: null', async () => {
      const c = await createConversation({ tenantId });
      await seed(tenantId, c.id, [
        { senderType: 'patient', content: 'obrigado', at: '2026-09-20 10:10:00' },
        { senderType: 'system', content: CLOSED, at: '2026-09-20 10:15:00' },
      ]);
      expect((await listed(c.id))?.awaitingReplySince).toBeNull();
    });

    it('resposta humana depois do encerramento continua valendo como fronteira mais recente', async () => {
      const c = await createConversation({ tenantId });
      await seed(tenantId, c.id, [
        { senderType: 'system', content: CLOSED, at: '2026-09-20 10:15:00' },
        { senderType: 'patient', at: '2026-10-01 11:00:00' },
        { senderType: 'agent', senderId: ana.id, at: '2026-10-01 11:30:00' },
        { senderType: 'patient', at: '2026-10-01 12:00:00' },
      ]);
      expect((await listed(c.id))?.awaitingReplySince).toBe('2026-10-01T12:00:00.000Z');
    });

    it('outra mensagem de sistema (nao encerramento) continua sem zerar', async () => {
      const c = await createConversation({ tenantId });
      await seed(tenantId, c.id, [
        { senderType: 'patient', at: '2026-10-01 12:00:00' },
        { senderType: 'system', content: 'Atendimento transferido para Bia', at: '2026-10-01 12:10:00' },
        { senderType: 'patient', at: '2026-10-01 12:20:00' },
      ]);
      expect((await listed(c.id))?.awaitingReplySince).toBe('2026-10-01T12:00:00.000Z');
    });
  });

  it('conversa encerrada nunca espera', async () => {
    const c = await createConversation({ tenantId, status: 'closed' });
    await seed(tenantId, c.id, [{ senderType: 'patient', at: '2026-10-01 12:00:00' }]);
    expect((await listed(c.id, 'closed'))?.awaitingReplySince).toBeNull();
  });
});
