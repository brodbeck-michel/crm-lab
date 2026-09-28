/**
 * Webhook do Evolution — citação, reação, apagada e editada pelo remetente
 * (CRMLAB-66, D-220..D-223). Payloads na forma do Evolution v2 (Baileys):
 *
 * - `messages.upsert` com `data.contextInfo.stanzaId` (o v2 sobe o
 *   `contextInfo` para o topo do `data`) ou `extendedTextMessage.contextInfo`;
 * - `messages.upsert` com `messageType: 'reactionMessage'`;
 * - `messages.upsert` com `protocolMessage` REVOKE / MESSAGE_EDIT;
 * - `messages.edited` com o `protocolMessage` como `data`;
 * - `messages.delete` com a `key` achatada + `status: 'DELETED'`.
 *
 * O que mais importa: apagada NUNCA sai do banco (linha, texto e mídia ficam),
 * mas a API nunca devolve o conteúdo escondido.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeWebhookModule } from '../../src/controllers/webhook.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { evolutionInstanceName } from '../../src/lib/evolution-client.js';
import { logger } from '../../src/lib/logger.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import { ConversationRepository } from '../../src/repositories/conversation.repository.js';
import { MessageRepository } from '../../src/repositories/message.repository.js';
import {
  MockWhatsAppDriver,
  WhatsAppService,
  type WhatsAppCredentials,
  type WhatsAppCredentialsResolver,
} from '../../src/services/whatsapp.service.js';
import { seedMessage } from '../conversations/helpers.js';
import { createConversation, createTenant, type TenantRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const TOKEN = 'segredo-do-gateway-crmlab66';
const WEBHOOK = '/api/v1/webhooks/evolution';
const PATIENT_PHONE = '5548999991234';
const PATIENT_JID = `${PATIENT_PHONE}@s.whatsapp.net`;

let db: DbClient;
let app: TestApp;
let messages: MessageRepository;
const slugToId = new Map<string, string>();

function resolver(): WhatsAppCredentialsResolver {
  const build = (tenantId: string): WhatsAppCredentials => ({
    tenantId,
    phoneNumberId: 'numero-do-lab',
    apiUrl: '',
    apiToken: '',
    webhookSecret: '',
    isActive: true,
    apiTokenRevoked: false,
    connectionMode: 'qr',
    qrInstanceApiKey: null,
  });
  return {
    forTenant: async (tenantId) => build(tenantId),
    byWebhookIdentity: async (identity) => {
      const tenantId = slugToId.get(identity);
      return tenantId ? build(tenantId) : null;
    },
  };
}

beforeEach(async () => {
  db = await getTestDb();
  await resetDatabase(db);
  slugToId.clear();
  process.env.EVOLUTION_WEBHOOK_TOKEN = TOKEN;
  const whatsapp = new WhatsAppService({
    credentials: resolver(),
    driver: new MockWhatsAppDriver(),
    queue: createInMemoryQueue({ sleep: async () => undefined }),
  });
  app = await createTestApp({ db, modules: [makeWebhookModule({ whatsapp })] });
  messages = new MessageRepository(db);
});

afterEach(() => {
  delete process.env.EVOLUTION_WEBHOOK_TOKEN;
  vi.restoreAllMocks();
});

async function lab(slug: string): Promise<{ tenant: TenantRecord; conversationId: string }> {
  const tenant = await createTenant({ slug });
  slugToId.set(slug, tenant.id);
  const conversation = await createConversation({
    tenantId: tenant.id,
    patientPhone: `+${PATIENT_PHONE}`,
  });
  return { tenant, conversationId: conversation.id };
}

function post(slug: string, tenant: TenantRecord, event: string, data: Record<string, unknown>) {
  return app.agent
    .post(`${WEBHOOK}/${slug}`)
    .set('x-evolution-webhook-token', TOKEN)
    .send({ event, instance: evolutionInstanceName(tenant.id), data })
    .expect(200, { received: true });
}

async function rawRow(id: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{
      content: string;
      deleted_at: Date | null;
      deleted_by: string | null;
      edited_at: Date | null;
      attachment_url: string | null;
    }>('SELECT content, deleted_at, deleted_by, edited_at, attachment_url FROM messages WHERE id = $1', [
      id,
    ]),
  );
  return result.rows[0];
}

async function auditOf(tenantId: string, action: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ entity_id: string; new_values: Record<string, unknown> }>(
      'SELECT entity_id, new_values FROM audit_logs WHERE tenant_id = $1 AND action = $2',
      [tenantId, action],
    ),
  );
  return result.rows;
}

describe('citação que chega do paciente (D-221)', () => {
  it('data.contextInfo.stanzaId (forma do Evolution v2) vira quoted com autor e trecho', async () => {
    const { tenant, conversationId } = await lab('lab-cita');
    const original = await seedMessage({
      tenantId: tenant.id,
      conversationId,
      senderType: 'agent',
      content: 'Seu exame fica pronto amanhã',
      externalMessageId: '3EB0ORIGINAL',
      db,
    });

    await post('lab-cita', tenant, 'messages.upsert', {
      key: { remoteJid: PATIENT_JID, fromMe: false, id: '3EB0RESPOSTA' },
      pushName: 'Maria',
      messageType: 'extendedTextMessage',
      message: { extendedTextMessage: { text: 'Que horas?' } },
      contextInfo: {
        stanzaId: '3EB0ORIGINAL',
        participant: '554899990000@s.whatsapp.net',
        quotedMessage: { conversation: 'Seu exame fica pronto amanhã' },
      },
    });

    const reply = await messages.findByExternalId(tenant.id, '3EB0RESPOSTA');
    expect(reply?.content).toBe('Que horas?');
    expect(reply?.quotedMessageId).toBe(original.id);
    expect(reply?.quoted).toMatchObject({
      id: original.id,
      senderType: 'agent',
      preview: 'Seu exame fica pronto amanhã',
      messageType: 'text',
      deleted: false,
    });
  });

  it('contextInfo dentro de extendedTextMessage (Baileys cru) também é lido', async () => {
    const { tenant, conversationId } = await lab('lab-cita-cru');
    const original = await seedMessage({
      tenantId: tenant.id,
      conversationId,
      content: 'Tenho pedido médico',
      externalMessageId: 'ORIG-CRU',
      db,
    });

    await post('lab-cita-cru', tenant, 'messages.upsert', {
      key: { remoteJid: PATIENT_JID, fromMe: false, id: 'RESP-CRU' },
      message: {
        extendedTextMessage: { text: 'segue a foto', contextInfo: { stanzaId: 'ORIG-CRU' } },
      },
    });

    const reply = await messages.findByExternalId(tenant.id, 'RESP-CRU');
    expect(reply?.quoted?.id).toBe(original.id);
    expect(reply?.quoted?.senderType).toBe('patient');
  });

  it('original fora do CRM: quoted com id nulo; se ela chegar depois, resolve na leitura', async () => {
    const { tenant, conversationId } = await lab('lab-cita-antes');

    await post('lab-cita-antes', tenant, 'messages.upsert', {
      key: { remoteJid: PATIENT_JID, fromMe: false, id: 'RESP-ANTES' },
      message: { conversation: 'sobre aquilo' },
      contextInfo: { stanzaId: 'ORIG-DEPOIS' },
    });
    const before = await messages.findByExternalId(tenant.id, 'RESP-ANTES');
    expect(before?.quoted).toEqual({
      id: null,
      senderType: null,
      senderName: null,
      preview: '',
      messageType: null,
      deleted: false,
    });

    const late = await seedMessage({
      tenantId: tenant.id,
      conversationId,
      content: 'chegou atrasada',
      externalMessageId: 'ORIG-DEPOIS',
      db,
    });
    const after = await messages.findByExternalId(tenant.id, 'RESP-ANTES');
    expect(after?.quoted?.id).toBe(late.id);
    expect(after?.quotedMessageId).toBe(late.id);
  });
});

describe('reação (D-222)', () => {
  it('paciente reage, troca e remove — sem criar mensagem, com message_updated', async () => {
    const { tenant, conversationId } = await lab('lab-reage');
    const target = await seedMessage({
      tenantId: tenant.id,
      conversationId,
      senderType: 'agent',
      externalMessageId: 'ALVO-1',
      db,
    });
    const reaction = (id: string, text: string) => ({
      key: { remoteJid: PATIENT_JID, fromMe: false, id },
      messageType: 'reactionMessage',
      message: {
        reactionMessage: {
          key: { remoteJid: PATIENT_JID, fromMe: true, id: 'ALVO-1' },
          text,
          senderTimestampMs: '1759000000000',
        },
      },
    });

    await post('lab-reage', tenant, 'messages.upsert', reaction('REACT-1', '👍'));
    expect((await messages.findById(tenant.id, target.id))?.reactions).toEqual([
      expect.objectContaining({ emoji: '👍', reactorType: 'patient', userId: null }),
    ]);

    await post('lab-reage', tenant, 'messages.upsert', reaction('REACT-2', '❤️'));
    expect((await messages.findById(tenant.id, target.id))?.reactions?.map((r) => r.emoji)).toEqual([
      '❤️',
    ]);

    await post('lab-reage', tenant, 'messages.upsert', reaction('REACT-3', ''));
    expect((await messages.findById(tenant.id, target.id))?.reactions).toEqual([]);

    const count = await db.withoutTenant((tx) =>
      tx.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM messages WHERE tenant_id = $1', [tenant.id]),
    );
    expect(count.rows[0]?.n).toBe(1);
    expect(app.wsHub.eventsFor(tenant.id, 'conversation.message_updated')).toHaveLength(3);
    expect(app.wsHub.eventsFor(tenant.id, 'conversation.new_message')).toHaveLength(0);
  });

  it('reação do celular do laboratório (fromMe) fica do lado agent, ao lado da do paciente', async () => {
    const { tenant, conversationId } = await lab('lab-reage-lab');
    const target = await seedMessage({
      tenantId: tenant.id,
      conversationId,
      externalMessageId: 'ALVO-PAC',
      db,
    });
    await post('lab-reage-lab', tenant, 'messages.upsert', {
      key: { remoteJid: PATIENT_JID, fromMe: false, id: 'R-PAC' },
      message: { reactionMessage: { key: { id: 'ALVO-PAC', fromMe: false }, text: '😂' } },
    });
    await post('lab-reage-lab', tenant, 'messages.upsert', {
      key: { remoteJid: PATIENT_JID, fromMe: true, id: 'R-LAB' },
      message: { reactionMessage: { key: { id: 'ALVO-PAC', fromMe: false }, text: '🙏' } },
    });

    const reactions = (await messages.findById(tenant.id, target.id))?.reactions ?? [];
    expect(reactions.map((r) => [r.reactorType, r.emoji])).toEqual([
      ['patient', '😂'],
      ['agent', '🙏'],
    ]);
  });

  it('reação a mensagem que não está no CRM: descarte contável, nada gravado', async () => {
    const { tenant } = await lab('lab-reage-nada');
    const warn = vi.spyOn(logger, 'warn');
    await post('lab-reage-nada', tenant, 'messages.upsert', {
      key: { remoteJid: PATIENT_JID, fromMe: false, id: 'R-X' },
      message: { reactionMessage: { key: { id: 'NAO-EXISTE' }, text: '👍' } },
    });
    expect(warn).toHaveBeenCalledWith(
      'evolution.inbound_discarded',
      expect.objectContaining({ reason: 'mensagem_alvo_desconhecida', messageType: 'reaction' }),
    );
    const rows = await db.withoutTenant((tx) => tx.query('SELECT 1 FROM message_reactions'));
    expect(rows.rows).toHaveLength(0);
  });
});

describe('apagada pelo paciente (D-220) — esconde, nunca apaga', () => {
  async function seedPatientMediaMessage(tenantId: string, conversationId: string, externalId: string) {
    const message = await seedMessage({
      tenantId,
      conversationId,
      content: 'meu CPF é 123',
      externalMessageId: externalId,
      db,
    });
    const media = await db.withoutTenant((tx) =>
      tx.query<{ id: string }>(
        `INSERT INTO message_media (tenant_id, message_id, mime_type, file_name, byte_size)
         VALUES ($1, $2, 'image/jpeg', 'rg.jpg', 10) RETURNING id`,
        [tenantId, message.id],
      ),
    );
    const mediaId = media.rows[0]?.id as string;
    await db.withoutTenant((tx) =>
      tx.query('UPDATE messages SET attachment_url = $2, message_type = $3 WHERE id = $1', [
        message.id,
        `/api/v1/media/${mediaId}`,
        'image',
      ]),
    );
    return { messageId: message.id, mediaId };
  }

  it('protocolMessage REVOKE no upsert: deleted_at gravado, linha e mídia preservadas, API esconde', async () => {
    const { tenant, conversationId } = await lab('lab-apaga');
    const { messageId, mediaId } = await seedPatientMediaMessage(tenant.id, conversationId, 'APAGAR-1');

    await post('lab-apaga', tenant, 'messages.upsert', {
      key: { remoteJid: PATIENT_JID, fromMe: false, id: 'PROTO-1' },
      messageType: 'protocolMessage',
      message: {
        protocolMessage: { key: { remoteJid: PATIENT_JID, fromMe: false, id: 'APAGAR-1' }, type: 'REVOKE' },
      },
    });

    const raw = await rawRow(messageId);
    expect(raw?.deleted_at).not.toBeNull();
    expect(raw?.deleted_by).toBe('patient');
    // O ORIGINAL continua no banco (auditoria).
    expect(raw?.content).toBe('meu CPF é 123');
    expect(raw?.attachment_url).toBe(`/api/v1/media/${mediaId}`);
    const media = await db.withoutTenant((tx) =>
      tx.query<{ message_id: string }>('SELECT message_id FROM message_media WHERE id = $1', [mediaId]),
    );
    expect(media.rows[0]?.message_id).toBe(messageId);

    // A API nunca devolve o conteúdo escondido.
    const api = await messages.findById(tenant.id, messageId);
    expect(api).toMatchObject({
      content: '',
      attachmentUrl: null,
      quoted: null,
      reactions: [],
      messageType: 'image',
    });
    expect(api?.deletedAt).toEqual(expect.any(String));

    // Nem a prévia da lista de conversas.
    const detail = await new ConversationRepository(db).findById(tenant.id, conversationId);
    expect(detail?.lastMessagePreview).toBe('');

    const audit = await auditOf(tenant.id, 'message_deleted_by_sender');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.entity_id).toBe(messageId);
    expect(audit[0]?.new_values).toMatchObject({ deletedBy: 'patient', externalId: 'APAGAR-1' });
    // O audit não carrega o texto (D-220 item 4).
    expect(JSON.stringify(audit[0]?.new_values)).not.toContain('CPF');
    expect(app.wsHub.eventsFor(tenant.id, 'conversation.message_updated')).toHaveLength(1);
  });

  it('messages.delete com a key achatada (status DELETED) também esconde', async () => {
    const { tenant, conversationId } = await lab('lab-apaga-del');
    const message = await seedMessage({
      tenantId: tenant.id,
      conversationId,
      externalMessageId: 'APAGAR-2',
      db,
    });

    await post('lab-apaga-del', tenant, 'messages.delete', {
      remoteJid: PATIENT_JID,
      fromMe: false,
      id: 'APAGAR-2',
      status: 'DELETED',
    });
    expect((await rawRow(message.id))?.deleted_at).not.toBeNull();

    // Reentrega (outro corpo, mesmo alvo): sem segundo audit.
    await post('lab-apaga-del', tenant, 'messages.delete', { key: { id: 'APAGAR-2' } });
    expect(await auditOf(tenant.id, 'message_deleted_by_sender')).toHaveLength(1);
  });

  it('messages.edited com REVOKE (o gateway desvia todo protocolMessage para lá) apaga', async () => {
    const { tenant, conversationId } = await lab('lab-apaga-edited');
    const message = await seedMessage({
      tenantId: tenant.id,
      conversationId,
      externalMessageId: 'APAGAR-3',
      db,
    });
    await post('lab-apaga-edited', tenant, 'messages.edited', {
      key: { remoteJid: PATIENT_JID, fromMe: false, id: 'APAGAR-3' },
      type: 0,
    });
    expect((await rawRow(message.id))?.deleted_at).not.toBeNull();
  });

  it('citada apagada: o bloco da resposta mostra deleted, sem o trecho', async () => {
    const { tenant, conversationId } = await lab('lab-apaga-citada');
    const original = await seedMessage({
      tenantId: tenant.id,
      conversationId,
      content: 'segredo',
      externalMessageId: 'CIT-1',
      db,
    });
    await post('lab-apaga-citada', tenant, 'messages.upsert', {
      key: { remoteJid: PATIENT_JID, fromMe: false, id: 'RESP-CIT-1' },
      message: { conversation: 'isso aí' },
      contextInfo: { stanzaId: 'CIT-1' },
    });
    await post('lab-apaga-citada', tenant, 'messages.delete', { remoteJid: PATIENT_JID, id: 'CIT-1' });

    const reply = await messages.findByExternalId(tenant.id, 'RESP-CIT-1');
    expect(reply?.quoted).toMatchObject({ id: original.id, deleted: true, preview: '' });
  });

  it('não atravessa tenant: o mesmo key.id em outro laboratório não é tocado', async () => {
    const a = await lab('lab-apaga-a');
    const b = await lab('lab-apaga-b');
    const inB = await seedMessage({
      tenantId: b.tenant.id,
      conversationId: b.conversationId,
      externalMessageId: 'MESMO-ID',
      db,
    });
    await post('lab-apaga-a', a.tenant, 'messages.delete', { remoteJid: PATIENT_JID, id: 'MESMO-ID' });
    expect((await rawRow(inB.id))?.deleted_at).toBeNull();
  });

  it('instance de outro laboratório é recusada antes de qualquer escrita', async () => {
    const { tenant, conversationId } = await lab('lab-apaga-inst');
    const message = await seedMessage({
      tenantId: tenant.id,
      conversationId,
      externalMessageId: 'APAGAR-INST',
      db,
    });
    await app.agent
      .post(`${WEBHOOK}/lab-apaga-inst`)
      .set('x-evolution-webhook-token', TOKEN)
      .send({ event: 'messages.delete', instance: 'tenant-outro', data: { id: 'APAGAR-INST' } })
      .expect(200, { received: true });
    expect((await rawRow(message.id))?.deleted_at).toBeNull();
  });
});

describe('editada pelo paciente (D-220) — texto novo, anterior guardado', () => {
  it('messages.edited com protocolMessage MESSAGE_EDIT', async () => {
    const { tenant, conversationId } = await lab('lab-edita');
    const message = await seedMessage({
      tenantId: tenant.id,
      conversationId,
      content: 'amanha as 8',
      externalMessageId: 'EDITAR-1',
      db,
    });

    await post('lab-edita', tenant, 'messages.edited', {
      key: { remoteJid: PATIENT_JID, fromMe: false, id: 'EDITAR-1' },
      type: 'MESSAGE_EDIT',
      editedMessage: { conversation: 'amanhã às 9' },
      timestampMs: '1759000000000',
    });

    const api = await messages.findById(tenant.id, message.id);
    expect(api?.content).toBe('amanhã às 9');
    expect(api?.editedAt).toEqual(expect.any(String));
    const edits = await db.withoutTenant((tx) =>
      tx.query<{ previous_content: string; edited_by: string }>(
        'SELECT previous_content, edited_by FROM message_edits WHERE message_id = $1',
        [message.id],
      ),
    );
    expect(edits.rows).toEqual([{ previous_content: 'amanha as 8', edited_by: 'patient' }]);
    const audit = await auditOf(tenant.id, 'message_edited_by_sender');
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]?.new_values)).not.toContain('amanha');
    expect(app.wsHub.eventsFor(tenant.id, 'conversation.message_updated')).toHaveLength(1);
  });

  it('upsert com editedMessage.message.protocolMessage (type 14) e extendedTextMessage', async () => {
    const { tenant, conversationId } = await lab('lab-edita-upsert');
    const message = await seedMessage({
      tenantId: tenant.id,
      conversationId,
      content: 'v1',
      externalMessageId: 'EDITAR-2',
      db,
    });
    await post('lab-edita-upsert', tenant, 'messages.upsert', {
      key: { remoteJid: PATIENT_JID, fromMe: false, id: 'WRAP-2' },
      messageType: 'editedMessage',
      message: {
        editedMessage: {
          message: {
            protocolMessage: {
              key: { id: 'EDITAR-2' },
              type: 14,
              editedMessage: { extendedTextMessage: { text: 'v2' } },
            },
          },
        },
      },
    });
    expect((await messages.findById(tenant.id, message.id))?.content).toBe('v2');
  });

  it('duas edições guardam as duas versões anteriores, em ordem', async () => {
    const { tenant, conversationId } = await lab('lab-edita-2x');
    const message = await seedMessage({
      tenantId: tenant.id,
      conversationId,
      content: 'a',
      externalMessageId: 'EDITAR-3',
      db,
    });
    for (const text of ['b', 'c']) {
      await post('lab-edita-2x', tenant, 'messages.edited', {
        key: { id: 'EDITAR-3' },
        type: 'MESSAGE_EDIT',
        editedMessage: { conversation: text },
      });
    }
    const edits = await db.withoutTenant((tx) =>
      tx.query<{ previous_content: string }>(
        'SELECT previous_content FROM message_edits WHERE message_id = $1 ORDER BY edited_at, id',
        [message.id],
      ),
    );
    expect(edits.rows.map((r) => r.previous_content).sort()).toEqual(['a', 'b']);
    expect((await messages.findById(tenant.id, message.id))?.content).toBe('c');
  });

  it('edição de mensagem já apagada é ignorada (continua escondida)', async () => {
    const { tenant, conversationId } = await lab('lab-edita-apagada');
    const message = await seedMessage({
      tenantId: tenant.id,
      conversationId,
      content: 'original',
      externalMessageId: 'EDITAR-4',
      db,
    });
    await post('lab-edita-apagada', tenant, 'messages.delete', { id: 'EDITAR-4' });
    await post('lab-edita-apagada', tenant, 'messages.edited', {
      key: { id: 'EDITAR-4' },
      type: 'MESSAGE_EDIT',
      editedMessage: { conversation: 'novo' },
    });
    expect((await rawRow(message.id))?.content).toBe('original');
    expect(await auditOf(tenant.id, 'message_edited_by_sender')).toHaveLength(0);
  });
});
