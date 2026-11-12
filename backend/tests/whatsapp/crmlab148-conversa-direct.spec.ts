/**
 * CRMLAB-148 (D-320): mensagem do WhatsApp num telefone que ja tinha conversa
 * `direct` entrava nessa conversa, e a resposta do atendente ficava `sent` sem
 * nunca sair para o paciente.
 *
 * O que os testes fixam: (1) a mensagem que chega pelo WhatsApp PROMOVE a
 * conversa para `whatsapp` (sem duplicar), e a resposta sai pelo canal;
 * (2) conversa de outro canal que ja tem mensagem do paciente vinda do
 * WhatsApp recusa a resposta com 409 `channel_not_whatsapp`, sem gravar nada;
 * (3) conversa `direct` de balcao, sem nada do WhatsApp, segue registrando
 * a resposta como antes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeConversationModule } from '../../src/controllers/conversation.routes.js';
import { makeWebhookModule } from '../../src/controllers/webhook.routes.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import {
  MockWhatsAppDriver,
  WhatsAppService,
  signWebhookBody,
} from '../../src/services/whatsapp.service.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { TEST_WEBHOOK_SECRET, testCredentialsResolver } from './fixtures.js';

const WEBHOOK = '/api/v1/webhooks/whatsapp';

function metaText(phone: string, text: string, externalId: string): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'numero-do-lab' },
              contacts: [{ wa_id: phone, profile: { name: 'Joana' } }],
              messages: [{ id: externalId, from: phone, timestamp: '1724425200', type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  });
}

async function rows<T>(sql: string, params: unknown[]): Promise<T[]> {
  const db = await getTestDb();
  const result = await db.withoutTenant((tx) => tx.query<T>(sql, params));
  return result.rows;
}

describe('CRMLAB-148: conversa direct x mensagem do WhatsApp (D-320)', () => {
  let app: TestApp;
  const driver = new MockWhatsAppDriver();
  const slugToId = new Map<string, string>();

  beforeEach(async () => {
    await resetDatabase();
    slugToId.clear();
    driver.clear();
    const db = await getTestDb();
    const whatsapp = new WhatsAppService({
      credentials: testCredentialsResolver(slugToId),
      driver,
      queue: createInMemoryQueue({ sleep: async () => undefined }),
      attempts: 1,
    });
    app = await createTestApp({
      db,
      modules: [makeWebhookModule({ whatsapp }), makeConversationModule({ whatsapp })],
    });
    app.wsHub.clear();
  });

  it('mensagem do WhatsApp promove a conversa direct; a resposta sai pelo canal', async () => {
    const tenant = await createTenant({ slug: 'lab-148' });
    slugToId.set('lab-148', tenant.id);
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const manual = await createConversation({
      tenantId: tenant.id,
      assignedTo: ana.id,
      patientPhone: '5548999991234',
      channel: 'direct',
    });

    const body = metaText('5548999991234', 'Oi, é a Joana', 'wamid.148A');
    await app.agent
      .post(`${WEBHOOK}/lab-148`)
      .set('x-hub-signature-256', signWebhookBody(body, TEST_WEBHOOK_SECRET))
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);

    const conversations = await rows<{ id: string; channel: string }>(
      'SELECT id, channel FROM conversations WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(conversations).toEqual([{ id: manual.id, channel: 'whatsapp' }]);
    const audit = await rows<{ action: string; old_values: unknown }>(
      `SELECT action, old_values FROM audit_logs WHERE entity_id = $1 AND action = 'update_conversation_channel'`,
      [manual.id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.old_values).toMatchObject({ channel: 'direct' });

    const reply = await app.agent
      .post(`/api/v1/conversations/${manual.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'Olá, Joana!' })
      .expect(201);
    expect(reply.body.status).toBe('sent');
    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0]).toMatchObject({ phone: '5548999991234', content: 'Olá, Joana!' });
  });

  it('direct com mensagem do paciente vinda do WhatsApp: 409 channel_not_whatsapp, nada gravado', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const stranded = await createConversation({
      tenantId: tenant.id,
      assignedTo: ana.id,
      patientPhone: '5548999995678',
      channel: 'direct',
    });
    // O estado que o card achou em prod: mensagem do WhatsApp gravada na direct.
    await rows(
      `INSERT INTO messages (tenant_id, conversation_id, sender_type, content, message_type, status, external_message_id)
       VALUES ($1, $2, 'patient', 'Oi', 'text', 'delivered', 'wamid.148B')`,
      [tenant.id, stranded.id],
    );

    const response = await app.agent
      .post(`/api/v1/conversations/${stranded.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'Resposta que não sairia' })
      .expect(409);
    expect(response.body.error).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'channel_not_whatsapp', channel: 'direct' },
    });
    const agentMessages = await rows<{ id: string }>(
      `SELECT id FROM messages WHERE conversation_id = $1 AND sender_type = 'agent'`,
      [stranded.id],
    );
    expect(agentMessages).toHaveLength(0);
    expect(driver.sent).toHaveLength(0);
  });

  it('direct de balcão, sem nada do WhatsApp: a resposta continua registrada como antes', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const balcao = await createConversation({
      tenantId: tenant.id,
      assignedTo: ana.id,
      channel: 'direct',
    });

    const response = await app.agent
      .post(`/api/v1/conversations/${balcao.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'Anotado no balcão' })
      .expect(201);
    expect(response.body.status).toBe('sent');
    expect(driver.sent).toHaveLength(0);
  });
});
