/**
 * `CHANNEL_CLOUD_API_NOT_CONFIGURED` e PRE-checagem (CRMLAB-138, D-308 item 4;
 * API_CONTRACTS §2, ordem NOT_CONFIGURED -> WHATSAPP_WINDOW_CLOSED ->
 * MESSAGE_SEND_FAILED): em `cloud_api` real sem credencial completa, texto,
 * anexo e "tentar de novo" recusam com 409 ANTES de gravar — nada fica
 * `failed`, nada chega ao driver, e `details` e so `{ missing }`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeConversationModule } from '../../src/controllers/conversation.routes.js';
import { mediaModule } from '../../src/controllers/media.routes.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import {
  MockWhatsAppDriver,
  WhatsAppService,
  type WhatsAppCredentials,
  type WhatsAppCredentialsResolver,
} from '../../src/services/whatsapp.service.js';
import { countMessages } from '../conversations/helpers.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

/** `cloud_api` com a API real configurada, mas o laboratorio sem WABA nem token. */
function incompleteResolver(): WhatsAppCredentialsResolver {
  const build = (tenantId: string): WhatsAppCredentials => ({
    tenantId,
    phoneNumberId: 'numero-do-lab',
    apiUrl: 'https://graph.test',
    wabaId: '',
    apiToken: '',
    webhookSecret: 'segredo',
    isActive: true,
    apiTokenRevoked: false,
    connectionMode: 'cloud_api',
    qrInstanceApiKey: null,
  });
  return {
    forTenant: async (tenantId) => build(tenantId),
    byWebhookIdentity: async () => null,
  };
}

let app: TestApp;
let driver: MockWhatsAppDriver;

beforeEach(async () => {
  await resetDatabase();
  const db = await getTestDb();
  driver = new MockWhatsAppDriver();
  const whatsapp = new WhatsAppService({
    credentials: incompleteResolver(),
    driver,
    queue: createInMemoryQueue({ sleep: async () => undefined }),
    attempts: 1,
  });
  app = await createTestApp({ db, modules: [makeConversationModule({ whatsapp }), mediaModule] });
});

async function scenario() {
  const tenant = await createTenant();
  const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
  const conversation = await createConversation({
    tenantId: tenant.id,
    assignedTo: ana.id,
    channel: 'whatsapp',
  });
  return { tenant, ana, conversation };
}

describe('cloud_api sem credencial completa — recusa antes de gravar', () => {
  it('texto: 409 com { missing }, nenhuma mensagem gravada, nada enviado', async () => {
    const { tenant, ana, conversation } = await scenario();
    const before = await countMessages(tenant.id);

    const res = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'Ola!' })
      .expect(409);

    expect(res.body.error.code).toBe('CHANNEL_CLOUD_API_NOT_CONFIGURED');
    expect(res.body.error.details).toEqual({ missing: ['wabaId', 'apiToken'] });
    expect(await countMessages(tenant.id)).toBe(before);
    expect(driver.sent).toHaveLength(0);
  });

  it('anexo: 409 com { missing }, nenhuma mensagem gravada', async () => {
    const { tenant, ana, conversation } = await scenario();
    const before = await countMessages(tenant.id);
    const contentBase64 = Buffer.from('%PDF-1.4 teste').toString('base64');

    const res = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/attachments`)
      .set(app.auth(ana))
      .send({ fileName: 'pedido.pdf', mimeType: 'application/pdf', contentBase64 })
      .expect(409);

    expect(res.body.error.code).toBe('CHANNEL_CLOUD_API_NOT_CONFIGURED');
    expect(res.body.error.details).toEqual({ missing: ['wabaId', 'apiToken'] });
    expect(await countMessages(tenant.id)).toBe(before);
  });

  it('tentar de novo: 409 e a mensagem continua failed (nao passa a pending)', async () => {
    const { tenant, ana, conversation } = await scenario();
    const db = await getTestDb();
    const inserted = await db.withoutTenant((tx) =>
      tx.query<{ id: string }>(
        `INSERT INTO messages (tenant_id, conversation_id, sender_type, sender_id, content, status)
         VALUES ($1, $2, 'agent', $3, 'nao saiu', 'failed') RETURNING id`,
        [tenant.id, conversation.id, ana.id],
      ),
    );
    const messageId = inserted.rows[0]!.id;

    const res = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages/${messageId}/retry`)
      .set(app.auth(ana))
      .expect(409);

    expect(res.body.error.code).toBe('CHANNEL_CLOUD_API_NOT_CONFIGURED');
    const status = await db.withoutTenant((tx) =>
      tx.query<{ status: string }>(`SELECT status FROM messages WHERE id = $1`, [messageId]),
    );
    expect(status.rows[0]?.status).toBe('failed');
    expect(driver.sent).toHaveLength(0);
  });
});
