/**
 * Responder citando e reagir pela API (CRMLAB-66, D-221/D-222):
 *
 *   POST   /conversations/:id/messages        { content, quotedMessageId }
 *   POST   /conversations/:id/attachments     { ..., quotedMessageId }
 *   PUT    /conversations/:id/messages/:messageId/reaction  { emoji }
 *   DELETE /conversations/:id/messages/:messageId/reaction
 *
 * Isolamento: citada/reagida de outra conversa, de outro tenant ou apagada é
 * `NOT_FOUND` — nunca `FORBIDDEN` (regra 8).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '@crm-lab/shared';
import { makeConversationModule } from '../../src/controllers/conversation.routes.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import {
  MockWhatsAppDriver,
  WhatsAppService,
  type WhatsAppDriver,
} from '../../src/services/whatsapp.service.js';
import { seedMessage } from '../conversations/helpers.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { testCredentialsResolver } from '../whatsapp/fixtures.js';

let app: TestApp;
let driver: MockWhatsAppDriver;

async function build(custom?: WhatsAppDriver): Promise<void> {
  driver = new MockWhatsAppDriver();
  const whatsapp = new WhatsAppService({
    credentials: testCredentialsResolver(new Map()),
    driver: custom ?? driver,
    queue: createInMemoryQueue({ sleep: async () => undefined }),
    attempts: 3,
  });
  app = await createTestApp({ db: await getTestDb(), modules: [makeConversationModule({ whatsapp })] });
}

beforeEach(async () => {
  await resetDatabase();
  await build();
});

async function scenario() {
  const tenant = await createTenant();
  const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
  const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
  const fromPatient = await seedMessage({
    tenantId: tenant.id,
    conversationId: conversation.id,
    content: 'Qual o preço do hemograma?',
    externalMessageId: 'WA-PAC-1',
  });
  return { tenant, ana, conversation, fromPatient };
}

describe('responder citando (D-221)', () => {
  it('mensagem sai citada para o WhatsApp e volta com o bloco citado', async () => {
    const { ana, conversation, fromPatient } = await scenario();

    const response = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'R$ 89,90', quotedMessageId: fromPatient.id })
      .expect(201);
    const body = response.body as Message;

    expect(body.quotedMessageId).toBe(fromPatient.id);
    expect(body.quoted).toMatchObject({
      id: fromPatient.id,
      senderType: 'patient',
      preview: 'Qual o preço do hemograma?',
      deleted: false,
    });
    expect(driver.sent.at(-1)).toMatchObject({ content: 'R$ 89,90', quotedExternalId: 'WA-PAC-1' });
  });

  it('original sem id externo: sai sem citação para o canal, continua citada no CRM', async () => {
    const { tenant, ana, conversation } = await scenario();
    const local = await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      senderType: 'agent',
      senderId: ana.id,
      content: 'nota interna',
    });
    const response = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'complemento', quotedMessageId: local.id })
      .expect(201);
    expect((response.body as Message).quoted?.id).toBe(local.id);
    expect(driver.sent.at(-1)?.quotedExternalId).toBeUndefined();
  });

  it('anexo também sai citando', async () => {
    const { ana, conversation, fromPatient } = await scenario();
    const response = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/attachments`)
      .set(app.auth(ana))
      .send({
        fileName: 'preparo.pdf',
        mimeType: 'application/pdf',
        contentBase64: Buffer.from('%PDF-1.4 teste').toString('base64'),
        quotedMessageId: fromPatient.id,
      })
      .expect(201);
    expect((response.body as Message).quoted?.id).toBe(fromPatient.id);
    expect(driver.sent.at(-1)?.quotedExternalId).toBe('WA-PAC-1');
  });

  it('citada de OUTRA conversa, de outro tenant, inexistente ou apagada -> NOT_FOUND e nada gravado', async () => {
    const { tenant, ana, conversation } = await scenario();
    const otherConversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
    const inOther = await seedMessage({ tenantId: tenant.id, conversationId: otherConversation.id });

    const tenantB = await createTenant();
    const convB = await createConversation({ tenantId: tenantB.id });
    const inB = await seedMessage({ tenantId: tenantB.id, conversationId: convB.id });

    const deleted = await seedMessage({ tenantId: tenant.id, conversationId: conversation.id });
    const db = await getTestDb();
    await db.withoutTenant((tx) =>
      tx.query("UPDATE messages SET deleted_at = now(), deleted_by = 'patient' WHERE id = $1", [
        deleted.id,
      ]),
    );

    for (const quotedMessageId of [inOther.id, inB.id, deleted.id, '00000000-0000-4000-8000-000000000000']) {
      const response = await app.agent
        .post(`/api/v1/conversations/${conversation.id}/messages`)
        .set(app.auth(ana))
        .send({ content: 'x', quotedMessageId })
        .expect(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    }
    expect(driver.sent).toHaveLength(0);
  });

  it('quotedMessageId que não é uuid -> VALIDATION_ERROR', async () => {
    const { ana, conversation } = await scenario();
    await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'x', quotedMessageId: 'nao-e-uuid' })
      .expect(400);
  });
});

describe('reagir (D-222)', () => {
  it('PUT reage, troca; DELETE remove — e a reação sai para o WhatsApp', async () => {
    const { tenant, ana, conversation, fromPatient } = await scenario();
    const path = `/api/v1/conversations/${conversation.id}/messages/${fromPatient.id}/reaction`;

    const first = await app.agent.put(path).set(app.auth(ana)).send({ emoji: '👍' }).expect(200);
    expect((first.body as Message).reactions).toEqual([
      expect.objectContaining({ emoji: '👍', reactorType: 'agent', userId: ana.id }),
    ]);

    const second = await app.agent.put(path).set(app.auth(ana)).send({ emoji: '❤️' }).expect(200);
    expect((second.body as Message).reactions?.map((r) => r.emoji)).toEqual(['❤️']);

    await app.agent.delete(path).set(app.auth(ana)).expect(204);
    // Idempotente: sem reação, continua 204 e nem vai ao canal.
    await app.agent.delete(path).set(app.auth(ana)).expect(204);

    expect(driver.reactions.map((r) => [r.targetExternalId, r.emoji])).toEqual([
      ['WA-PAC-1', '👍'],
      ['WA-PAC-1', '❤️'],
      ['WA-PAC-1', ''],
    ]);
    expect(app.wsHub.eventsFor(tenant.id, 'conversation.message_updated')).toHaveLength(3);
    expect(app.wsHub.eventsFor(tenant.id, 'conversation.new_message')).toHaveLength(0);
  });

  it('reação e do LADO do laboratório: a colega que reage depois substitui', async () => {
    const { tenant, ana, conversation, fromPatient } = await scenario();
    const bia = await createUser({ tenantId: tenant.id, role: 'manager' });
    const path = `/api/v1/conversations/${conversation.id}/messages/${fromPatient.id}/reaction`;
    await app.agent.put(path).set(app.auth(ana)).send({ emoji: '👍' }).expect(200);
    const response = await app.agent.put(path).set(app.auth(bia)).send({ emoji: '🙏' }).expect(200);
    expect((response.body as Message).reactions).toEqual([
      expect.objectContaining({ emoji: '🙏', reactorType: 'agent', userId: bia.id }),
    ]);
  });

  it('canal falhou: MESSAGE_SEND_FAILED e nada gravado', async () => {
    class FailingReaction extends MockWhatsAppDriver {
      override async sendReaction(): Promise<void> {
        throw new Error('gateway fora');
      }
    }
    await build(new FailingReaction());
    const { ana, conversation, fromPatient } = await scenario();
    const response = await app.agent
      .put(`/api/v1/conversations/${conversation.id}/messages/${fromPatient.id}/reaction`)
      .set(app.auth(ana))
      .send({ emoji: '👍' })
      .expect(502);
    expect(response.body.error.code).toBe('MESSAGE_SEND_FAILED');
    const db = await getTestDb();
    const rows = await db.withoutTenant((tx) => tx.query('SELECT 1 FROM message_reactions'));
    expect(rows.rows).toHaveLength(0);
  });

  it('mensagem de outro tenant, de outra conversa, apagada ou de sistema -> NOT_FOUND', async () => {
    const { tenant, ana, conversation } = await scenario();
    const tenantB = await createTenant();
    const convB = await createConversation({ tenantId: tenantB.id });
    const inB = await seedMessage({ tenantId: tenantB.id, conversationId: convB.id, externalMessageId: 'B-1' });
    const other = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
    const inOther = await seedMessage({ tenantId: tenant.id, conversationId: other.id });
    const system = await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      senderType: 'system',
    });
    const deleted = await seedMessage({ tenantId: tenant.id, conversationId: conversation.id });
    const db = await getTestDb();
    await db.withoutTenant((tx) =>
      tx.query("UPDATE messages SET deleted_at = now(), deleted_by = 'patient' WHERE id = $1", [
        deleted.id,
      ]),
    );

    for (const messageId of [inB.id, inOther.id, system.id, deleted.id]) {
      const response = await app.agent
        .put(`/api/v1/conversations/${conversation.id}/messages/${messageId}/reaction`)
        .set(app.auth(ana))
        .send({ emoji: '👍' })
        .expect(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    }
    // Conversa de outro tenant pelo caminho: 404 também.
    await app.agent
      .put(`/api/v1/conversations/${convB.id}/messages/${inB.id}/reaction`)
      .set(app.auth(ana))
      .send({ emoji: '👍' })
      .expect(404);
    expect(driver.reactions).toHaveLength(0);
  });

  it('emoji vazio ou acima de 32 bytes -> VALIDATION_ERROR', async () => {
    const { ana, conversation, fromPatient } = await scenario();
    const path = `/api/v1/conversations/${conversation.id}/messages/${fromPatient.id}/reaction`;
    await app.agent.put(path).set(app.auth(ana)).send({ emoji: '' }).expect(400);
    await app.agent.put(path).set(app.auth(ana)).send({ emoji: '👍'.repeat(9) }).expect(400);
  });

  it('atendimento encerrado -> CONVERSATION_ARCHIVED', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const conversation = await createConversation({
      tenantId: tenant.id,
      assignedTo: ana.id,
      status: 'closed',
    });
    const message = await seedMessage({ tenantId: tenant.id, conversationId: conversation.id });
    await app.agent
      .put(`/api/v1/conversations/${conversation.id}/messages/${message.id}/reaction`)
      .set(app.auth(ana))
      .send({ emoji: '👍' })
      .expect(409);
  });
});

describe('GET /conversations/:id esconde a apagada (D-220)', () => {
  it('content vazio, sem anexo — a linha continua no banco', async () => {
    const { tenant, ana, conversation, fromPatient } = await scenario();
    const db = await getTestDb();
    await db.withoutTenant((tx) =>
      tx.query("UPDATE messages SET deleted_at = now(), deleted_by = 'patient' WHERE id = $1", [
        fromPatient.id,
      ]),
    );
    const response = await app.agent
      .get(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(ana))
      .expect(200);
    const hidden = (response.body.messages as Message[]).find((m) => m.id === fromPatient.id);
    expect(hidden).toMatchObject({ content: '', attachmentUrl: null, reactions: [], quoted: null });
    expect(hidden?.deletedAt).toEqual(expect.any(String));
    expect(response.body.conversation.lastMessagePreview).toBe('');
    expect(JSON.stringify(response.body)).not.toContain('hemograma');

    const raw = await db.withoutTenant((tx) =>
      tx.query<{ content: string }>('SELECT content FROM messages WHERE id = $1', [fromPatient.id]),
    );
    expect(raw.rows[0]?.content).toBe('Qual o preço do hemograma?');
    expect(tenant.id).toBeTruthy();
  });
});
