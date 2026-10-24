/**
 * Editar e apagar para todos pela autora (CRMLAB-105, D-280):
 *
 *   PATCH  /conversations/:id/messages/:messageId  { content }
 *   DELETE /conversations/:id/messages/:messageId
 *
 * Só a autora, só mensagem enviada pelo CRM, dentro do prazo do WhatsApp
 * (15 min editar, 48 h apagar). Gateway falhou: nada muda. O eco do webhook
 * depois da nossa ação vira no-op.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { GetConversationResponse, Message } from '@crm-lab/shared';
import { MESSAGE_DELETE_WINDOW_MS, MESSAGE_EDIT_WINDOW_MS } from '@crm-lab/shared';
import { makeConversationModule } from '../../src/controllers/conversation.routes.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import { ConversationRepository } from '../../src/repositories/conversation.repository.js';
import { MessageRepository } from '../../src/repositories/message.repository.js';
import { createAuditService } from '../../src/services/audit.service.js';
import { MessageService } from '../../src/services/message.service.js';
import {
  HttpWhatsAppDriver,
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
let whatsapp: WhatsAppService;

async function build(custom?: WhatsAppDriver): Promise<void> {
  driver = new MockWhatsAppDriver();
  whatsapp = new WhatsAppService({
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

/** Driver que finge o canal mas recusa editar/apagar (gateway fora ou recusou). */
class RefusingDriver extends MockWhatsAppDriver {
  override async editMessage(): Promise<void> {
    throw new Error('Evolution API respondeu 400 em /chat/updateMessage');
  }
  override async deleteMessage(): Promise<void> {
    throw new Error('Evolution API respondeu 500 em /chat/deleteMessageForEveryone');
  }
}

async function scenario() {
  const tenant = await createTenant();
  const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
  const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
  const sent = await app.agent
    .post(`/api/v1/conversations/${conversation.id}/messages`)
    .set(app.auth(ana))
    .send({ content: 'O exame custa R$ 98,90' })
    .expect(201);
  return { tenant, ana, conversation, message: sent.body as Message };
}

const path = (conversationId: string, messageId: string) =>
  `/api/v1/conversations/${conversationId}/messages/${messageId}`;

/**
 * Folga de 1 dia nos recuos: `messages.created_at` e `TIMESTAMP` sem fuso
 * (D-078 fixa UTC no driver de producao), e o PGlite dos testes le no fuso da
 * maquina — numa estacao em -03 a hora "anda" 3 h. 1 dia cobre qualquer fuso
 * e ainda deixa a mensagem de "editar vencido" dentro das 48 h de apagar.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

async function backdate(messageId: string, ms: number): Promise<void> {
  const db = await getTestDb();
  const result = await db.withoutTenant((tx) =>
    tx.query("UPDATE messages SET created_at = now() - $2::int * interval '1 second' WHERE id = $1", [
      messageId,
      Math.ceil(ms / 1000),
    ]),
  );
  expect(result.rowCount ?? result.rows.length).not.toBe(0);
}

async function rawRow(id: string) {
  const db = await getTestDb();
  const result = await db.withoutTenant((tx) =>
    tx.query<{ content: string; edited_at: Date | null; deleted_at: Date | null; deleted_by: string | null }>(
      'SELECT content, edited_at, deleted_at, deleted_by FROM messages WHERE id = $1',
      [id],
    ),
  );
  return result.rows[0];
}

async function editsOf(messageId: string) {
  const db = await getTestDb();
  const result = await db.withoutTenant((tx) =>
    tx.query<{ previous_content: string; edited_by: string }>(
      'SELECT previous_content, edited_by FROM message_edits WHERE message_id = $1',
      [messageId],
    ),
  );
  return result.rows;
}

async function auditOf(tenantId: string, action: string) {
  const db = await getTestDb();
  const result = await db.withoutTenant((tx) =>
    tx.query<{
      user_id: string | null;
      entity_id: string;
      old_values: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
    }>(
      'SELECT user_id, entity_id, old_values, new_values FROM audit_logs WHERE tenant_id = $1 AND action = $2',
      [tenantId, action],
    ),
  );
  return result.rows;
}

describe('editar (D-280)', () => {
  it('a autora edita: sai pelo canal, guarda a versão anterior, audit com userId e WS', async () => {
    const { tenant, ana, conversation, message } = await scenario();

    const response = await app.agent
      .patch(path(conversation.id, message.id))
      .set(app.auth(ana))
      .send({ content: 'O exame custa R$ 89,90' })
      .expect(200);
    const body = response.body as Message;

    expect(body.content).toBe('O exame custa R$ 89,90');
    expect(body.editedAt).toEqual(expect.any(String));
    expect(driver.messageActions).toEqual([
      expect.objectContaining({ kind: 'edit', content: 'O exame custa R$ 89,90' }),
    ]);
    expect(driver.messageActions[0]?.externalId).toMatch(/^wamid\.mock\./);
    expect(await editsOf(message.id)).toEqual([
      { previous_content: 'O exame custa R$ 98,90', edited_by: 'agent' },
    ]);
    const audit = await auditOf(tenant.id, 'edit_message');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      user_id: ana.id,
      entity_id: message.id,
      old_values: { content: 'O exame custa R$ 98,90' },
      new_values: expect.objectContaining({ content: 'O exame custa R$ 89,90' }),
    });
    expect(app.wsHub.eventsFor(tenant.id, 'conversation.message_updated')).toHaveLength(1);
  });

  it('outra atendente e gestora não editam mensagem da colega -> FORBIDDEN, nada sai', async () => {
    const { tenant, conversation, message } = await scenario();
    const bia = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const gestora = await createUser({ tenantId: tenant.id, role: 'manager' });
    const admin = await createUser({ tenantId: tenant.id, role: 'admin' });
    // Bia participa (enxerga a conversa) — o que recusa é a autoria.
    await app.agent
      .post(`/api/v1/conversations/${conversation.id}/participants`)
      .set(app.auth(gestora))
      .send({ userId: bia.id })
      .expect(200);

    for (const user of [bia, gestora, admin]) {
      const response = await app.agent
        .patch(path(conversation.id, message.id))
        .set(app.auth(user))
        .send({ content: 'mexido' })
        .expect(403);
      expect(response.body.error.details).toMatchObject({ reason: 'not_author' });
      await app.agent.delete(path(conversation.id, message.id)).set(app.auth(user)).expect(403);
    }
    expect(driver.messageActions).toHaveLength(0);
    expect((await rawRow(message.id))?.content).toBe('O exame custa R$ 98,90');
  });

  it('depois de 15 min -> CONFLICT window_expired (apagar ainda pode)', async () => {
    const { ana, conversation, message } = await scenario();
    await backdate(message.id, MESSAGE_EDIT_WINDOW_MS + DAY_MS);

    const response = await app.agent
      .patch(path(conversation.id, message.id))
      .set(app.auth(ana))
      .send({ content: 'tarde demais' })
      .expect(409);
    expect(response.body.error.details).toMatchObject({ reason: 'window_expired' });
    expect(driver.messageActions).toHaveLength(0);

    await app.agent.delete(path(conversation.id, message.id)).set(app.auth(ana)).expect(204);
  });

  it('gateway recusou -> MESSAGE_SEND_FAILED e NADA muda no CRM', async () => {
    await build(new RefusingDriver());
    const { tenant, ana, conversation, message } = await scenario();

    await app.agent
      .patch(path(conversation.id, message.id))
      .set(app.auth(ana))
      .send({ content: 'corrigido' })
      .expect(502);

    const row = await rawRow(message.id);
    expect(row?.content).toBe('O exame custa R$ 98,90');
    expect(row?.edited_at).toBeNull();
    expect(await editsOf(message.id)).toHaveLength(0);
    expect(await auditOf(tenant.id, 'edit_message')).toHaveLength(0);
    expect(app.wsHub.eventsFor(tenant.id, 'conversation.message_updated')).toHaveLength(0);
  });

  it('documento não edita (not_editable); texto vazio ou acima de 4000 -> 400', async () => {
    const { tenant, ana, conversation, message } = await scenario();
    const doc = await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      senderType: 'agent',
      senderId: ana.id,
      externalMessageId: 'WA-DOC-1',
    });
    const db = await getTestDb();
    await db.withoutTenant((tx) => tx.query("UPDATE messages SET message_type = 'pdf' WHERE id = $1", [doc.id]));

    const response = await app.agent
      .patch(path(conversation.id, doc.id))
      .set(app.auth(ana))
      .send({ content: 'nova legenda' })
      .expect(409);
    expect(response.body.error.details).toMatchObject({ reason: 'not_editable' });

    for (const content of ['   ', 'x'.repeat(4001)]) {
      await app.agent.patch(path(conversation.id, message.id)).set(app.auth(ana)).send({ content }).expect(400);
    }
  });

  it('resposta de participante sai editada com o nome; o eco com `*Nome*` vira no-op', async () => {
    const tenant = await createTenant();
    const dona = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const gestora = await createUser({ tenantId: tenant.id, role: 'manager', name: 'Gi' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: dona.id });
    await app.agent
      .post(`/api/v1/conversations/${conversation.id}/participants`)
      .set(app.auth(gestora))
      .send({ userId: gestora.id })
      .expect(200);
    const sent = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(gestora))
      .send({ content: 'Pode vir em jejum' })
      .expect(201);
    const message = sent.body as Message;

    await app.agent
      .patch(path(conversation.id, message.id))
      .set(app.auth(gestora))
      .send({ content: 'Venha em jejum de 8 h' })
      .expect(200);
    expect(driver.messageActions[0]?.content).toBe('*Gi*\nVenha em jejum de 8 h');

    const service = await directService();
    const externalId = driver.messageActions[0]?.externalId ?? '';
    expect(await service.applySenderEdit(tenant.id, externalId, '*Gi*\nVenha em jejum de 8 h')).toBe(
      'sem_efeito',
    );
    expect(await editsOf(message.id)).toHaveLength(1);
    expect((await rawRow(message.id))?.content).toBe('Venha em jejum de 8 h');
  });
});

describe('apagar para todos (D-280)', () => {
  it('a autora apaga: esconde (deleted_by agent), texto fica no audit com userId', async () => {
    const { tenant, ana, conversation, message } = await scenario();

    await app.agent.delete(path(conversation.id, message.id)).set(app.auth(ana)).expect(204);

    const row = await rawRow(message.id);
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.deleted_by).toBe('agent');
    // Nada é apagado de verdade.
    expect(row?.content).toBe('O exame custa R$ 98,90');
    expect(driver.messageActions).toEqual([expect.objectContaining({ kind: 'delete' })]);
    const audit = await auditOf(tenant.id, 'delete_message');
    expect(audit[0]).toMatchObject({
      user_id: ana.id,
      old_values: { content: 'O exame custa R$ 98,90', deletedAt: null },
      new_values: expect.objectContaining({ deletedBy: 'agent' }),
    });
    expect(app.wsHub.eventsFor(tenant.id, 'conversation.message_updated')).toHaveLength(1);

    // Já apagada: não apaga nem edita de novo.
    const again = await app.agent.delete(path(conversation.id, message.id)).set(app.auth(ana)).expect(409);
    expect(again.body.error.details).toMatchObject({ reason: 'already_deleted' });
    await app.agent.patch(path(conversation.id, message.id)).set(app.auth(ana)).send({ content: 'x' }).expect(409);
  });

  it('o eco do webhook (MESSAGES_DELETE / MESSAGES_EDITED) depois da nossa ação é no-op', async () => {
    const { tenant, ana, conversation, message } = await scenario();
    await app.agent
      .patch(path(conversation.id, message.id))
      .set(app.auth(ana))
      .send({ content: 'O exame custa R$ 89,90' })
      .expect(200);
    await app.agent.delete(path(conversation.id, message.id)).set(app.auth(ana)).expect(204);
    const externalId = driver.messageActions[0]?.externalId ?? '';

    const service = await directService();
    expect(await service.applySenderEdit(tenant.id, externalId, 'O exame custa R$ 89,90')).toBe('sem_efeito');
    expect(await service.applySenderDelete(tenant.id, externalId)).toBe('sem_efeito');
    expect(await editsOf(message.id)).toHaveLength(1);
    expect(await auditOf(tenant.id, 'message_deleted_by_sender')).toHaveLength(0);
    expect(await auditOf(tenant.id, 'message_edited_by_sender')).toHaveLength(0);
  });

  it('depois de 48 h -> CONFLICT window_expired', async () => {
    const { ana, conversation, message } = await scenario();
    await backdate(message.id, MESSAGE_DELETE_WINDOW_MS + DAY_MS);
    const response = await app.agent.delete(path(conversation.id, message.id)).set(app.auth(ana)).expect(409);
    expect(response.body.error.details).toMatchObject({ reason: 'window_expired' });
    expect(driver.messageActions).toHaveLength(0);
  });

  it('gateway falhou -> MESSAGE_SEND_FAILED e a mensagem continua visível', async () => {
    await build(new RefusingDriver());
    const { tenant, ana, conversation, message } = await scenario();
    await app.agent.delete(path(conversation.id, message.id)).set(app.auth(ana)).expect(502);
    expect((await rawRow(message.id))?.deleted_at).toBeNull();
    expect(await auditOf(tenant.id, 'delete_message')).toHaveLength(0);
  });

  it('do celular (sender nulo), automática, do paciente e sem id externo ficam de fora', async () => {
    const { tenant, ana, conversation } = await scenario();
    const fromPhone = await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      senderType: 'agent',
      externalMessageId: 'WA-CEL-1',
    });
    const automatic = await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      senderType: 'agent',
      externalMessageId: 'WA-AUTO-1',
    });
    const db = await getTestDb();
    await db.withoutTenant((tx) =>
      tx.query("UPDATE messages SET automation = 'greeting' WHERE id = $1", [automatic.id]),
    );
    const fromPatient = await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      externalMessageId: 'WA-PAC-1',
    });
    for (const id of [fromPhone.id, automatic.id, fromPatient.id]) {
      await app.agent.delete(path(conversation.id, id)).set(app.auth(ana)).expect(403);
    }

    const local = await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      senderType: 'agent',
      senderId: ana.id,
      status: 'sent',
    });
    const response = await app.agent.delete(path(conversation.id, local.id)).set(app.auth(ana)).expect(409);
    expect(response.body.error.details).toMatchObject({ reason: 'not_sent' });
    expect(driver.messageActions).toHaveLength(0);
  });

  it('conversa invisível para a atendente, de outra conversa ou de outro tenant -> 404', async () => {
    const { tenant, ana, conversation, message } = await scenario();
    const bia = await createUser({ tenantId: tenant.id, role: 'attendant' });
    await app.agent.delete(path(conversation.id, message.id)).set(app.auth(bia)).expect(404);

    const other = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
    await app.agent.delete(path(other.id, message.id)).set(app.auth(ana)).expect(404);

    const tenantB = await createTenant();
    const userB = await createUser({ tenantId: tenantB.id, role: 'admin' });
    await app.agent.delete(path(conversation.id, message.id)).set(app.auth(userB)).expect(404);
    expect(driver.messageActions).toHaveLength(0);
  });
});

describe('capacidade do canal (D-280)', () => {
  it('GET /conversations/:id manda canEditMessages: mock sim, Cloud API (HTTP) não', async () => {
    const { ana, conversation } = await scenario();
    const withMock = await app.agent.get(`/api/v1/conversations/${conversation.id}`).set(app.auth(ana)).expect(200);
    expect((withMock.body as GetConversationResponse).canEditMessages).toBe(true);

    await build(new HttpWhatsAppDriver());
    const cloud = await app.agent.get(`/api/v1/conversations/${conversation.id}`).set(app.auth(ana)).expect(200);
    expect((cloud.body as GetConversationResponse).canEditMessages).toBe(false);
  });

  it('Cloud API: a API recusa editar/apagar com CONFLICT channel_unsupported', async () => {
    const { ana, conversation, message } = await scenario();
    await build(new HttpWhatsAppDriver());
    const response = await app.agent.delete(path(conversation.id, message.id)).set(app.auth(ana)).expect(409);
    expect(response.body.error.details).toMatchObject({ reason: 'channel_unsupported' });
  });
});

/** MessageService sobre o mesmo banco — para simular o eco do webhook. */
async function directService(): Promise<MessageService> {
  const db = await getTestDb();
  return new MessageService({
    messages: new MessageRepository(db),
    conversations: new ConversationRepository(db),
    wsHub: app.wsHub,
    whatsapp,
    audit: createAuditService(db),
  });
}
