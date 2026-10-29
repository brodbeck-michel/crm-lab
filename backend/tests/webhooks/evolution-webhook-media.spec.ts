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
import { readFile, rm } from 'node:fs/promises';
import sharp from 'sharp';
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

  it('documentMessage com mimetype text/html e gravado e servido como application/octet-stream + attachment (CRMLAB-31)', async () => {
    // Ataque descrito no card: paciente manda um "documento" cujo mimetype
    // real e HTML/script. `text/html` nao esta na allow-list (só
    // `text/plain`) — o MIME gravado cai para `application/octet-stream` e a
    // rota nunca serve `inline`, entao o navegador nunca tenta renderizar.
    const tenant = await createTenant({ slug: 'lab-evo-html-disfarcado' });
    slugToId.set('lab-evo-html-disfarcado', tenant.id);
    const html = Buffer.from('<script>alert(document.cookie)</script>').toString('base64');

    const response = await app.agent
      .post(`${WEBHOOK}/lab-evo-html-disfarcado`)
      .set('x-evolution-webhook-token', TOKEN)
      .send({
        event: 'MESSAGES_UPSERT',
        instance: evolutionInstanceName(tenant.id),
        data: {
          key: { remoteJid: '5548999997777@s.whatsapp.net', id: 'EVO-MEDIA-HTML' },
          message: {
            documentMessage: { mimetype: 'text/html', fileName: 'laudo.html', base64: html },
          },
        },
      });

    expect(response.status).toBe(200);

    const db = await getTestDb();
    const row = await db.withoutTenant((tx) =>
      tx.query<{ message_type: string; attachment_url: string }>(
        `SELECT message_type, attachment_url FROM messages WHERE tenant_id = $1`,
        [tenant.id],
      ),
    );
    // MIME rebaixado -> nunca vira 'doc' generico pra frontend confundir com
    // pdf/imagem; messageType tambem reflete o rebaixamento (nao 'text/html').
    expect(row.rows[0]?.message_type).toBe('doc');

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
    expect(media.headers['content-type']).toBe('application/octet-stream');
    expect(media.headers['content-disposition']).toMatch(/^attachment; filename="laudo\.html"/);
    expect(media.headers['x-content-type-options']).toBe('nosniff');
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

/**
 * CRMLAB-128 (D-290): imagem recebida vira JPEG ao gravar; figurinha e GIF
 * animado ficam como chegaram; imagem quebrada nao derruba o webhook.
 */
describe('POST /webhooks/evolution/:tenant — imagem vira JPEG (CRMLAB-128)', () => {
  async function receive(slug: string, tenantId: string, id: string, message: Record<string, unknown>) {
    await app.agent
      .post(`${WEBHOOK}/${slug}`)
      .set('x-evolution-webhook-token', TOKEN)
      .send({
        event: 'MESSAGES_UPSERT',
        instance: evolutionInstanceName(tenantId),
        data: { key: { remoteJid: '5548999997777@s.whatsapp.net', id }, message, pushName: 'Maria' },
      })
      .expect(200);
  }

  async function storedMedia(tenantId: string) {
    const db = await getTestDb();
    const rows = await db.withoutTenant((tx) =>
      tx.query<{
        content: string;
        message_type: string;
        mime_type: string;
        file_name: string;
        byte_size: number;
        id: string;
      }>(
        `SELECT m.content, m.message_type, mm.mime_type, mm.file_name, mm.byte_size, mm.id
           FROM messages m JOIN message_media mm ON mm.message_id = m.id
          WHERE m.tenant_id = $1`,
        [tenantId],
      ),
    );
    return rows.rows;
  }

  async function setup(slug: string) {
    const tenant = await createTenant({ slug });
    slugToId.set(slug, tenant.id);
    return tenant;
  }

  it('PNG recebido vira image/jpeg com .jpg e o tamanho do arquivo convertido', async () => {
    const tenant = await setup('lab-jpeg-png');
    const png = await sharp({ create: { width: 30, height: 20, channels: 4, background: 'red' } })
      .png()
      .toBuffer();
    await receive('lab-jpeg-png', tenant.id, 'EVO-JPEG-1', {
      imageMessage: { mimetype: 'image/png', fileName: 'pedido.png', base64: png.toString('base64') },
    });

    const [row] = await storedMedia(tenant.id);
    expect(row?.message_type).toBe('image');
    expect(row?.mime_type).toBe('image/jpeg');
    expect(row?.file_name).toBe('pedido.jpg');
    // Sem legenda o content e o nome gravado — o balao nao mostra "pedido.png"
    // como legenda (D-236 item 8 compara content com media.fileName).
    expect(row?.content).toBe('pedido.jpg');
    const onDisk = await readFile(mediaFilePath(row!.id));
    expect(row?.byte_size).toBe(onDisk.length);
    expect((await sharp(onDisk).metadata()).format).toBe('jpeg');
  });

  it('legenda do paciente fica como veio, mesmo com o nome trocado para .jpg', async () => {
    const tenant = await setup('lab-jpeg-legenda');
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    await receive('lab-jpeg-legenda', tenant.id, 'EVO-JPEG-5', {
      imageMessage: {
        mimetype: 'image/png',
        fileName: 'pedido.png',
        caption: 'segue o pedido',
        base64: png.toString('base64'),
      },
    });
    const [row] = await storedMedia(tenant.id);
    expect(row?.file_name).toBe('pedido.jpg');
    expect(row?.content).toBe('segue o pedido');
  });

  it('figurinha WebP animada fica WebP e continua sticker', async () => {
    const tenant = await setup('lab-jpeg-sticker');
    const frame = (c: string) => sharp({ create: { width: 8, height: 8, channels: 4, background: c } }).png().toBuffer();
    const webp = await sharp([await frame('red'), await frame('blue')], { join: { animated: true } })
      .webp({ delay: [100, 100] })
      .toBuffer();
    await receive('lab-jpeg-sticker', tenant.id, 'EVO-JPEG-2', {
      stickerMessage: { mimetype: 'image/webp', base64: webp.toString('base64') },
    });

    const [row] = await storedMedia(tenant.id);
    expect(row?.message_type).toBe('sticker');
    expect(row?.mime_type).toBe('image/webp');
    expect(row?.byte_size).toBe(webp.length);
  });

  it('figurinha WebP estática também fica WebP', async () => {
    const tenant = await setup('lab-jpeg-sticker2');
    const webp = await sharp({ create: { width: 8, height: 8, channels: 4, background: 'red' } }).webp().toBuffer();
    await receive('lab-jpeg-sticker2', tenant.id, 'EVO-JPEG-3', {
      stickerMessage: { mimetype: 'image/webp', base64: webp.toString('base64') },
    });
    const [row] = await storedMedia(tenant.id);
    expect(row?.mime_type).toBe('image/webp');
  });

  it('imagem corrompida grava o original e o webhook responde 200', async () => {
    const tenant = await setup('lab-jpeg-quebrada');
    const png = await sharp({ create: { width: 30, height: 20, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    const truncated = png.subarray(0, 60);
    await receive('lab-jpeg-quebrada', tenant.id, 'EVO-JPEG-4', {
      imageMessage: { mimetype: 'image/png', fileName: 'quebrada.png', base64: truncated.toString('base64') },
    });
    const [row] = await storedMedia(tenant.id);
    expect(row?.mime_type).toBe('image/png');
    expect(row?.file_name).toBe('quebrada.png');
    expect(row?.content).toBe('quebrada.png');
    expect(row?.byte_size).toBe(truncated.length);
  });
});

describe('GET /media/:id — nome do download com extensão (CRMLAB-131)', () => {
  it('JPEG recebido sem nome sai como imagem.jpg — sem extensão o Chrome no Windows salvava .jfif', async () => {
    const tenant = await createTenant({ slug: 'lab-download-ext' });
    slugToId.set('lab-download-ext', tenant.id);
    const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'blue' } })
      .jpeg()
      .toBuffer();
    await app.agent
      .post(`${WEBHOOK}/lab-download-ext`)
      .set('x-evolution-webhook-token', TOKEN)
      .send({
        event: 'MESSAGES_UPSERT',
        instance: evolutionInstanceName(tenant.id),
        data: {
          key: { remoteJid: '5548999997777@s.whatsapp.net', id: 'EVO-DL-EXT' },
          message: { imageMessage: { mimetype: 'image/jpeg', base64: jpeg.toString('base64') } },
        },
      })
      .expect(200);

    const db = await getTestDb();
    const row = await db.withoutTenant((tx) =>
      tx.query<{ attachment_url: string }>(`SELECT attachment_url FROM messages WHERE tenant_id = $1`, [
        tenant.id,
      ]),
    );
    const admin = await createUser({ tenantId: tenant.id, role: 'admin', name: 'Admin' });
    const token = signAccessToken({
      userId: admin.id,
      tenantId: admin.tenantId,
      role: admin.role,
      discountLimit: admin.discountLimit,
    });
    const media = await app.agent
      .get(`/api/v1/media/${row.rows[0]!.attachment_url.split('/').pop()}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(media.headers['content-disposition']).toBe('inline; filename="imagem.jpg"');
  });
});
