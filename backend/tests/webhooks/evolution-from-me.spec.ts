/**
 * `MESSAGES_UPSERT` com `key.fromMe: true` (D-173, CRMLAB-46).
 *
 * Ate o CRMLAB-46 toda `fromMe` era descartada, e o atendimento feito pelo
 * celular do laboratorio sumia do CRM. Agora:
 * - `key.id` ja gravado (eco do que o CRM enviou, ou reentrega) -> nada muda;
 * - senao -> resposta do atendimento, sem autor, sem subir `unreadCount`.
 *
 * A corrida do eco chegando ANTES do envio gravar o id fica em
 * `tests/messages/from-phone.spec.ts`, onde a espera e injetavel.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeWebhookModule } from '../../src/controllers/webhook.routes.js';
import { evolutionInstanceName } from '../../src/lib/evolution-client.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import { MessageRepository, PHONE_SENDER_NAME } from '../../src/repositories/message.repository.js';
import {
  MockWhatsAppDriver,
  WhatsAppService,
  type WhatsAppCredentials,
  type WhatsAppCredentialsResolver,
} from '../../src/services/whatsapp.service.js';
import {
  countConversations,
  countMessages,
  readConversationRow,
  seedMessage,
} from '../conversations/helpers.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { FakeWsHub } from '../helpers/fake-ws.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const TOKEN = 'segredo-do-gateway-evolution-teste';
const WEBHOOK = '/api/v1/webhooks/evolution';

function credentialsResolver(slugToId: Map<string, string>): WhatsAppCredentialsResolver {
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

const slugToId = new Map<string, string>();
let app: TestApp;
let wsHub: FakeWsHub;

beforeEach(async () => {
  await resetDatabase();
  slugToId.clear();
  process.env.EVOLUTION_WEBHOOK_TOKEN = TOKEN;
  wsHub = new FakeWsHub();
  const whatsapp = new WhatsAppService({
    credentials: credentialsResolver(slugToId),
    driver: new MockWhatsAppDriver(),
    queue: createInMemoryQueue({ sleep: async () => undefined }),
  });
  app = await createTestApp({ wsHub, modules: [makeWebhookModule({ whatsapp })] });
});

async function tenantWithSlug(slug: string): Promise<{ id: string }> {
  const tenant = await createTenant({ slug });
  slugToId.set(slug, tenant.id);
  return tenant;
}

function postFromMe(
  slug: string,
  tenantId: string,
  data: { key: Record<string, unknown>; message: Record<string, unknown>; pushName?: string },
) {
  return app.agent
    .post(`${WEBHOOK}/${slug}`)
    .set('x-evolution-webhook-token', TOKEN)
    .send({ event: 'messages.upsert', instance: evolutionInstanceName(tenantId), data })
    .expect(200);
}

interface MessageRow {
  sender_type: string;
  sender_id: string | null;
  content: string;
  status: string;
  external_message_id: string | null;
  message_type: string;
  attachment_url: string | null;
}

async function messagesOf(conversationId: string): Promise<MessageRow[]> {
  const db = await getTestDb();
  const result = await db.withoutTenant((tx) =>
    tx.query<MessageRow>(
      `SELECT sender_type, sender_id, content, status, external_message_id, message_type,
              attachment_url
         FROM messages WHERE conversation_id = $1 ORDER BY created_at, id`,
      [conversationId],
    ),
  );
  return result.rows;
}

describe('POST /webhooks/evolution/:tenant — fromMe (D-173)', () => {
  it('mensagem digitada no celular entra como resposta do atendimento, sem subir unreadCount', async () => {
    const tenant = await tenantWithSlug('lab-cel');
    const conversation = await createConversation({
      tenantId: tenant.id,
      patientPhone: '+5548999997777',
    });

    await postFromMe('lab-cel', tenant.id, {
      key: { remoteJid: '5548999997777@s.whatsapp.net', id: 'EVO-CEL-1', fromMe: true },
      message: { conversation: 'Resultado sai amanha' },
      pushName: 'Laboratorio Vida',
    });

    const rows = await messagesOf(conversation.id);
    expect(rows).toEqual([
      expect.objectContaining({
        sender_type: 'agent',
        sender_id: null,
        content: 'Resultado sai amanha',
        status: 'sent',
        external_message_id: 'EVO-CEL-1',
      }),
    ]);
    expect((await readConversationRow(conversation.id))?.unread_count).toBe(0);
    expect(wsHub.eventsFor(tenant.id, 'conversation.new_message')).toHaveLength(1);
  });

  it('senderName da mensagem do celular e "Enviada pelo celular"', async () => {
    const tenant = await tenantWithSlug('lab-cel-nome');
    const conversation = await createConversation({
      tenantId: tenant.id,
      patientPhone: '+5548999997777',
    });

    await postFromMe('lab-cel-nome', tenant.id, {
      key: { remoteJid: '5548999997777@s.whatsapp.net', id: 'EVO-CEL-N', fromMe: true },
      message: { conversation: 'oi' },
    });

    const db = await getTestDb();
    const found = await new MessageRepository(db).findByExternalId(tenant.id, 'EVO-CEL-N');
    expect(found?.conversationId).toBe(conversation.id);
    expect(found?.senderName).toBe(PHONE_SENDER_NAME);
  });

  it('eco de mensagem enviada pelo CRM (key.id ja gravado) nao duplica', async () => {
    const tenant = await tenantWithSlug('lab-eco');
    const agent = await createUser({ tenantId: tenant.id });
    const conversation = await createConversation({
      tenantId: tenant.id,
      patientPhone: '+5548999997777',
    });
    await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      senderType: 'agent',
      senderId: agent.id,
      content: 'Enviado pelo CRM',
      status: 'sent',
      externalMessageId: 'EVO-CRM-1',
    });

    await postFromMe('lab-eco', tenant.id, {
      key: { remoteJid: '5548999997777@s.whatsapp.net', id: 'EVO-CRM-1', fromMe: true },
      message: { conversation: 'Enviado pelo CRM' },
    });

    expect(await countMessages(tenant.id)).toBe(1);
    expect(wsHub.eventsFor(tenant.id, 'conversation.new_message')).toHaveLength(0);
  });

  it('reentrega da mesma mensagem do celular nao duplica', async () => {
    const tenant = await tenantWithSlug('lab-reentrega');
    await createConversation({ tenantId: tenant.id, patientPhone: '+5548999997777' });
    const data = {
      key: { remoteJid: '5548999997777@s.whatsapp.net', id: 'EVO-CEL-R', fromMe: true },
      message: { conversation: 'uma vez so' },
    };

    await postFromMe('lab-reentrega', tenant.id, data);
    // Corpo diferente (timestamp novo) para passar pela guarda anti-replay e
    // chegar ao dedupe por `externalId`, que e o que este teste prova.
    await postFromMe('lab-reentrega', tenant.id, { ...data, pushName: 'reentrega' });

    expect(await countMessages(tenant.id)).toBe(1);
  });

  it('numero sem conversa cria a conversa, sem usar o pushName (que e o nome do laboratorio)', async () => {
    const tenant = await tenantWithSlug('lab-novo');

    await postFromMe('lab-novo', tenant.id, {
      key: { remoteJid: '5548988887777@s.whatsapp.net', id: 'EVO-CEL-NOVO', fromMe: true },
      message: { conversation: 'Ola, aqui e o laboratorio' },
      pushName: 'Laboratorio Vida',
    });

    expect(await countConversations(tenant.id)).toBe(1);
    const db = await getTestDb();
    const conv = await db.withoutTenant((tx) =>
      tx.query<{ id: string; patient_name: string | null; unread_count: number }>(
        'SELECT id, patient_name, unread_count FROM conversations WHERE tenant_id = $1',
        [tenant.id],
      ),
    );
    const row = conv.rows[0];
    expect(row?.patient_name).toBeNull();
    expect(row?.unread_count).toBe(0);
    const rows = await messagesOf(row?.id ?? '');
    expect(rows).toEqual([expect.objectContaining({ sender_type: 'agent', sender_id: null })]);
  });

  it('@lid do celular usa remoteJidAlt como telefone do paciente', async () => {
    const tenant = await tenantWithSlug('lab-cel-lid');
    const conversation = await createConversation({
      tenantId: tenant.id,
      patientPhone: '+5548999997777',
    });

    await postFromMe('lab-cel-lid', tenant.id, {
      key: {
        remoteJid: '128999376343081@lid',
        remoteJidAlt: '5548999997777@s.whatsapp.net',
        id: 'EVO-CEL-LID',
        fromMe: true,
      },
      message: { conversation: 'pelo lid' },
    });

    expect(await countConversations(tenant.id)).toBe(1);
    expect(await messagesOf(conversation.id)).toHaveLength(1);
  });

  it('fromMe em grupo continua ignorada', async () => {
    const tenant = await tenantWithSlug('lab-cel-grupo');

    await postFromMe('lab-cel-grupo', tenant.id, {
      key: { remoteJid: '120363423909747775@g.us', id: 'EVO-CEL-G', fromMe: true },
      message: { conversation: 'no grupo' },
    });

    expect(await countConversations(tenant.id)).toBe(0);
    expect(await countMessages(tenant.id)).toBe(0);
  });

  it('imagem com legenda enviada pelo celular vira anexo do lado do atendimento', async () => {
    const tenant = await tenantWithSlug('lab-cel-midia');
    const conversation = await createConversation({
      tenantId: tenant.id,
      patientPhone: '+5548999997777',
    });
    const conteudo = Buffer.from('laudo em jpeg').toString('base64');

    await postFromMe('lab-cel-midia', tenant.id, {
      key: { remoteJid: '5548999997777@s.whatsapp.net', id: 'EVO-CEL-IMG', fromMe: true },
      message: { imageMessage: { mimetype: 'image/jpeg', base64: conteudo, caption: 'seu laudo' } },
    });

    const rows = await messagesOf(conversation.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({ sender_type: 'agent', sender_id: null, content: 'seu laudo' }),
    );
    expect(rows[0]?.attachment_url).toMatch(/^\/api\/v1\/media\//);
  });

  it('eco de anexo enviado pelo CRM nao grava o arquivo de novo', async () => {
    const tenant = await tenantWithSlug('lab-eco-midia');
    const agent = await createUser({ tenantId: tenant.id });
    const conversation = await createConversation({
      tenantId: tenant.id,
      patientPhone: '+5548999997777',
    });
    await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      senderType: 'agent',
      senderId: agent.id,
      content: 'laudo.pdf',
      status: 'sent',
      externalMessageId: 'EVO-CRM-DOC',
    });

    await postFromMe('lab-eco-midia', tenant.id, {
      key: { remoteJid: '5548999997777@s.whatsapp.net', id: 'EVO-CRM-DOC', fromMe: true },
      message: {
        documentMessage: {
          mimetype: 'application/pdf',
          fileName: 'laudo.pdf',
          base64: Buffer.from('%PDF-1.4 laudo').toString('base64'),
        },
      },
    });

    const db = await getTestDb();
    const media = await db.withoutTenant((tx) =>
      tx.query<{ total: number }>(
        'SELECT COUNT(*)::int AS total FROM message_media WHERE tenant_id = $1',
        [tenant.id],
      ),
    );
    expect(Number(media.rows[0]?.total)).toBe(0);
    expect(await countMessages(tenant.id)).toBe(1);
  });
});
