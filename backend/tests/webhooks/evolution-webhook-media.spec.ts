/**
 * `POST /webhooks/evolution/:tenant` com mídia (Onda 8 §4.2) —
 * `message.imageMessage`/`audioMessage`/`documentMessage`, base64 habilitado
 * no webhook (`evolution-client.ts`, `base64: true`).
 *
 * O campo exato onde o gateway v2.3.7 poe o base64 nao foi confirmado contra
 * um payload real (spec Onda 8 §7.4 exige essa verificacao antes de fechar a
 * onda) — este teste fixa o formato que o parser aceita hoje
 * (`message.imageMessage.base64`) como contrato, para pegar regressao no
 * parser mesmo antes dessa verificacao.
 */
import { rm } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeWebhookModule } from '../../src/controllers/webhook.routes.js';
import { mediaModule } from '../../src/controllers/media.routes.js';
import { evolutionInstanceName } from '../../src/lib/evolution-client.js';
import { mediaFilePath } from '../../src/lib/media-storage.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import { MAX_MEDIA_BYTES } from '../../src/services/media.service.js';
import {
  MockWhatsAppDriver,
  WhatsAppService,
  type WhatsAppCredentials,
  type WhatsAppCredentialsResolver,
} from '../../src/services/whatsapp.service.js';
import { countMessages } from '../conversations/helpers.js';
import { createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { signAccessToken } from '../../src/lib/tokens.js';

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

async function buildApp(): Promise<TestApp> {
  const whatsapp = new WhatsAppService({
    credentials: credentialsResolver(slugToId),
    driver: new MockWhatsAppDriver(),
    queue: createInMemoryQueue({ sleep: async () => undefined }),
  });
  return createTestApp({ modules: [makeWebhookModule({ whatsapp }), mediaModule] });
}

let app: TestApp;

beforeEach(async () => {
  await resetDatabase();
  slugToId.clear();
  process.env.EVOLUTION_WEBHOOK_TOKEN = TOKEN;
  app = await buildApp();
});

describe('POST /webhooks/evolution/:tenant — mídia de entrada (§4.2)', () => {
  it('imageMessage com base64 grava a mídia e a mensagem com messageType image', async () => {
    const tenant = await createTenant({ slug: 'lab-evo-midia' });
    slugToId.set('lab-evo-midia', tenant.id);
    const conteudo = Buffer.from('pedido medico em jpeg').toString('base64');

    const response = await app.agent
      .post(`${WEBHOOK}/lab-evo-midia`)
      .set('x-evolution-webhook-token', TOKEN)
      .send({
        event: 'MESSAGES_UPSERT',
        instance: evolutionInstanceName(tenant.id),
        data: {
          key: { remoteJid: '5548999997777@s.whatsapp.net', id: 'EVO-MEDIA-1' },
          message: { imageMessage: { mimetype: 'image/jpeg', base64: conteudo, caption: 'exame' } },
          pushName: 'Maria',
        },
      });

    expect(response.status).toBe(200);
    expect(await countMessages(tenant.id)).toBe(1);

    const db = await getTestDb();
    const row = await db.withoutTenant((tx) =>
      tx.query<{ message_type: string; attachment_url: string }>(
        `SELECT message_type, attachment_url FROM messages WHERE tenant_id = $1`,
        [tenant.id],
      ),
    );
    expect(row.rows[0]?.message_type).toBe('image');
    expect(row.rows[0]?.attachment_url).toMatch(/^\/api\/v1\/media\/[0-9a-f-]{36}$/);

    // O arquivo gravado é lido de volta pela rota autenticada.
    const admin = await createUser({ tenantId: tenant.id, role: 'admin', name: 'Admin' });
    const mediaId = row.rows[0]!.attachment_url.split('/').pop();
    const token = signAccessToken({
      userId: admin.id,
      tenantId: admin.tenantId,
      role: admin.role,
      discountLimit: admin.discountLimit,
    });
    const media = await app.agent
      .get(`/api/v1/media/${mediaId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(media.body.toString('utf8')).toBe('pedido medico em jpeg');
  });

  it('mídia acima do teto é recusada com log — a mensagem NAO é criada, mas o webhook responde 200', async () => {
    const tenant = await createTenant({ slug: 'lab-evo-midia-grande' });
    slugToId.set('lab-evo-midia-grande', tenant.id);
    const oversized = Buffer.alloc(MAX_MEDIA_BYTES + 1).toString('base64');

    const response = await app.agent
      .post(`${WEBHOOK}/lab-evo-midia-grande`)
      .set('x-evolution-webhook-token', TOKEN)
      .send({
        event: 'MESSAGES_UPSERT',
        instance: evolutionInstanceName(tenant.id),
        data: {
          key: { remoteJid: '5548999997777@s.whatsapp.net', id: 'EVO-MEDIA-2' },
          message: { documentMessage: { mimetype: 'application/pdf', base64: oversized } },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
    expect(await countMessages(tenant.id)).toBe(0);
  });

  it('linha no banco com arquivo fora do disco responde 404, nao 500', async () => {
    // Caso real de homologacao: o dump de producao traz `message_media`, mas
    // o volume de midia e proprio do ambiente e nao vem junto. Antes disso o
    // ENOENT subia como `http.unhandled_error` e virava 500 na cara do
    // atendente, com stack no log — quando o honesto e "esse arquivo sumiu".
    const tenant = await createTenant({ slug: 'lab-evo-midia-sumida' });
    slugToId.set('lab-evo-midia-sumida', tenant.id);

    await app.agent
      .post(`${WEBHOOK}/lab-evo-midia-sumida`)
      .set('x-evolution-webhook-token', TOKEN)
      .send({
        event: 'MESSAGES_UPSERT',
        instance: evolutionInstanceName(tenant.id),
        data: {
          key: { remoteJid: '5548999997777@s.whatsapp.net', id: 'EVO-MEDIA-3' },
          message: {
            imageMessage: {
              mimetype: 'image/jpeg',
              base64: Buffer.from('some para o teste').toString('base64'),
            },
          },
        },
      })
      .expect(200);

    const db = await getTestDb();
    const row = await db.withoutTenant((tx) =>
      tx.query<{ attachment_url: string }>(
        `SELECT attachment_url FROM messages WHERE tenant_id = $1`,
        [tenant.id],
      ),
    );
    const mediaId = row.rows[0]!.attachment_url.split('/').pop()!;
    await rm(mediaFilePath(mediaId));

    const admin = await createUser({ tenantId: tenant.id, role: 'admin', name: 'Admin' });
    const token = signAccessToken({
      userId: admin.id,
      tenantId: admin.tenantId,
      role: admin.role,
      discountLimit: admin.discountLimit,
    });

    await app.agent
      .get(`/api/v1/media/${mediaId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});
