/**
 * Webhook do Evolution — vídeo, figurinha, áudio/documento com metadados,
 * localização e contato estruturados (CRMLAB-70, D-234/D-235).
 *
 * De onde vêm os payloads: forma do `proto.Message` do Baileys (WAProto
 * `VideoMessage.seconds/jpegThumbnail`, `AudioMessage.seconds`,
 * `DocumentMessage.pageCount/fileName`, `LocationMessage.degreesLatitude/
 * degreesLongitude/name/address`, `LiveLocationMessage.caption`,
 * `ContactMessage.displayName/vcard`, `ContactsArrayMessage.contacts[]`), dentro
 * do envelope `messages.upsert` do Evolution v2 (`data.key`, `data.message`,
 * `data.pushName`) — o mesmo dos specs do CRMLAB-66/67. O base64 do arquivo em
 * `<tipo>Message.base64` é o formato que o parser já aceita (Onda 8 §4.2). O
 * vCard segue o que o WhatsApp gera (`TEL;type=CELL;waid=<digitos>:+55 ...`).
 * Não há payload capturado de gateway real: validar na hml.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '@crm-lab/shared';
import { makeWebhookModule } from '../../src/controllers/webhook.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { evolutionInstanceName } from '../../src/lib/evolution-client.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import { MessageRepository } from '../../src/repositories/message.repository.js';
import {
  MockWhatsAppDriver,
  WhatsAppService,
  type WhatsAppCredentials,
  type WhatsAppCredentialsResolver,
} from '../../src/services/whatsapp.service.js';
import { createTenant, type TenantRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const TOKEN = 'segredo-do-gateway-crmlab70';
const WEBHOOK = '/api/v1/webhooks/evolution';
const PATIENT_JID = '5548999991234@s.whatsapp.net';

/** JPEG mínimo (magic FF D8 FF E0 + JFIF) — a miniatura do vídeo. */
const JPEG_THUMB = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9,
]);

let db: DbClient;
let app: TestApp;
let messages: MessageRepository;
let tenant: TenantRecord;
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

let seq = 0;
async function upsert(message: Record<string, unknown>, fromMe = false): Promise<void> {
  seq += 1;
  await app.agent
    .post(`${WEBHOOK}/lab-crmlab70`)
    .set('x-evolution-webhook-token', TOKEN)
    .send({
      event: 'messages.upsert',
      instance: evolutionInstanceName(tenant.id),
      data: {
        key: { remoteJid: PATIENT_JID, id: `EVO70-${seq}`, fromMe },
        message,
        pushName: 'Maria',
      },
    })
    .expect(200);
}

async function lastMessage(): Promise<Message> {
  const row = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      `SELECT id FROM messages WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [tenant.id],
    ),
  );
  const id = row.rows[0]?.id;
  if (!id) throw new Error('nenhuma mensagem gravada');
  const message = await messages.findById(tenant.id, id);
  if (!message) throw new Error('mensagem sumiu');
  return message;
}

beforeEach(async () => {
  await resetDatabase();
  db = await getTestDb();
  messages = new MessageRepository(db);
  slugToId.clear();
  process.env.EVOLUTION_WEBHOOK_TOKEN = TOKEN;
  tenant = await createTenant({ slug: 'lab-crmlab70' });
  slugToId.set('lab-crmlab70', tenant.id);
  const whatsapp = new WhatsAppService({
    credentials: resolver(),
    driver: new MockWhatsAppDriver(),
    queue: createInMemoryQueue({ sleep: async () => undefined }),
  });
  app = await createTestApp({ modules: [makeWebhookModule({ whatsapp })] });
});

describe('mídia com metadados (D-235 itens 1–3)', () => {
  it('videoMessage vira video, com duração, miniatura, nome e tamanho', async () => {
    const bytes = Buffer.from('conteudo de video mp4 de teste');
    await upsert({
      videoMessage: {
        mimetype: 'video/mp4',
        base64: bytes.toString('base64'),
        seconds: 12,
        jpegThumbnail: JPEG_THUMB.toString('base64'),
        caption: 'olha o resultado',
      },
    });

    const message = await lastMessage();
    expect(message.messageType).toBe('video');
    expect(message.content).toBe('olha o resultado');
    expect(message.media).toEqual({
      fileName: 'video',
      fileSize: bytes.length,
      mimeType: 'video/mp4',
      durationSec: 12,
      pageCount: null,
      thumbnail: JPEG_THUMB.toString('base64'),
    });
    expect(message.location).toBeNull();
    expect(message.contacts).toEqual([]);
  });

  it('miniatura como Buffer serializado ({type, data}) também é aceita', async () => {
    await upsert({
      videoMessage: {
        mimetype: 'video/mp4',
        base64: Buffer.from('outro video').toString('base64'),
        jpegThumbnail: { type: 'Buffer', data: Array.from(JPEG_THUMB) },
      },
    });
    const message = await lastMessage();
    expect(message.media?.thumbnail).toBe(JPEG_THUMB.toString('base64'));
    expect(message.media?.durationSec).toBeNull();
  });

  it('miniatura que não é JPEG é descartada (o vídeo entra do mesmo jeito)', async () => {
    await upsert({
      videoMessage: {
        mimetype: 'video/mp4',
        base64: Buffer.from('video').toString('base64'),
        jpegThumbnail: Buffer.from('<svg onload=alert(1)>').toString('base64'),
      },
    });
    const message = await lastMessage();
    expect(message.messageType).toBe('video');
    expect(message.media?.thumbnail).toBeNull();
  });

  it('vídeo com MIME fora da allow-list continua doc (tipo sai do MIME gravado)', async () => {
    await upsert({
      videoMessage: { mimetype: 'video/3gpp', base64: Buffer.from('3gp').toString('base64') },
    });
    const message = await lastMessage();
    expect(message.messageType).toBe('doc');
    expect(message.media?.mimeType).toBe('application/octet-stream');
  });

  it('stickerMessage vira sticker, não image', async () => {
    await upsert({
      stickerMessage: { mimetype: 'image/webp', base64: Buffer.from('webp').toString('base64') },
    });
    const message = await lastMessage();
    expect(message.messageType).toBe('sticker');
    expect(message.content).toBe('Figurinha');
    expect(message.media?.fileName).toBe('Figurinha');
  });

  it('imageMessage continua image', async () => {
    await upsert({
      imageMessage: { mimetype: 'image/jpeg', base64: Buffer.from('jpg').toString('base64') },
    });
    expect((await lastMessage()).messageType).toBe('image');
  });

  it('audioMessage guarda a duração', async () => {
    await upsert({
      audioMessage: {
        mimetype: 'audio/ogg; codecs=opus',
        base64: Buffer.from('ogg').toString('base64'),
        seconds: 7,
        ptt: true,
      },
    });
    const message = await lastMessage();
    expect(message.messageType).toBe('audio');
    expect(message.media?.durationSec).toBe(7);
  });

  it('documentMessage (PDF) mostra nome, tamanho e páginas', async () => {
    const bytes = Buffer.from('%PDF-1.4 conteudo');
    await upsert({
      documentMessage: {
        mimetype: 'application/pdf',
        base64: bytes.toString('base64'),
        fileName: 'hemograma.pdf',
        pageCount: 3,
      },
    });
    const message = await lastMessage();
    expect(message.messageType).toBe('pdf');
    expect(message.content).toBe('hemograma.pdf');
    expect(message.media).toMatchObject({
      fileName: 'hemograma.pdf',
      fileSize: bytes.length,
      mimeType: 'application/pdf',
      pageCount: 3,
    });
  });
});

describe('localização (D-235 item 4)', () => {
  it('locationMessage vira location estruturada com texto de fallback', async () => {
    await upsert({
      locationMessage: {
        degreesLatitude: -28.4817,
        degreesLongitude: -49.0069,
        name: 'Laboratório Centro',
        address: 'Rua Lauro Müller, 100 - Tubarão',
      },
    });
    const message = await lastMessage();
    expect(message.messageType).toBe('location');
    expect(message.attachmentUrl).toBeNull();
    expect(message.media).toBeNull();
    expect(message.content).toBe('📍 Laboratório Centro');
    expect(message.location).toEqual({
      latitude: -28.4817,
      longitude: -49.0069,
      name: 'Laboratório Centro',
      address: 'Rua Lauro Müller, 100 - Tubarão',
    });
  });

  it('liveLocationMessage usa a caption como nome', async () => {
    await upsert({
      liveLocationMessage: { degreesLatitude: -27.6, degreesLongitude: -48.5, caption: 'Estou aqui' },
    });
    const message = await lastMessage();
    expect(message.messageType).toBe('location');
    expect(message.location).toEqual({
      latitude: -27.6,
      longitude: -48.5,
      name: 'Estou aqui',
      address: null,
    });
  });

  it('sem nome nem endereço, o fallback é "📍 Localização"', async () => {
    await upsert({ locationMessage: { degreesLatitude: 1, degreesLongitude: 2 } });
    expect((await lastMessage()).content).toBe('📍 Localização');
  });

  it('sem coordenada válida continua a linha de texto antiga', async () => {
    await upsert({ locationMessage: { degreesLatitude: 200, degreesLongitude: 'x', name: 'Casa' } });
    const message = await lastMessage();
    expect(message.messageType).toBe('text');
    expect(message.location).toBeNull();
    expect(message.content).toContain('[Localizacao] Casa');
  });

  it('localização enviada pelo celular do laboratório (fromMe) também estrutura', async () => {
    await upsert({ locationMessage: { degreesLatitude: -28, degreesLongitude: -49 } }, true);
    const message = await lastMessage();
    expect(message.senderType).toBe('agent');
    expect(message.messageType).toBe('location');
    expect(message.location?.latitude).toBe(-28);
  });
});

describe('contato (D-235 item 5)', () => {
  it('contactMessage com vCard do WhatsApp usa o waid', async () => {
    await upsert({
      contactMessage: {
        displayName: 'Dr. Silva',
        vcard:
          'BEGIN:VCARD\nVERSION:3.0\nN:Silva;Dr.;;;\nFN:Dr. Silva\n' +
          'item1.TEL;waid=5548988887777:+55 48 98888-7777\nitem1.X-ABLabel:Celular\nEND:VCARD',
      },
    });
    const message = await lastMessage();
    expect(message.messageType).toBe('contact');
    expect(message.content).toBe('👤 Dr. Silva');
    expect(message.contacts).toEqual([{ name: 'Dr. Silva', phone: '+5548988887777' }]);
  });

  it('contactsArrayMessage guarda todos, com fallback "e mais N"', async () => {
    await upsert({
      contactsArrayMessage: {
        displayName: '2 contatos',
        contacts: [
          { displayName: 'Ana', vcard: 'BEGIN:VCARD\nFN:Ana\nTEL;type=CELL:(48) 99999-1234\nEND:VCARD' },
          { displayName: 'Bruno', vcard: 'BEGIN:VCARD\nFN:Bruno\nEND:VCARD' },
        ],
      },
    });
    const message = await lastMessage();
    expect(message.messageType).toBe('contact');
    expect(message.content).toBe('👤 Ana e mais 1');
    expect(message.contacts).toEqual([
      { name: 'Ana', phone: '+5548999991234' },
      { name: 'Bruno', phone: null },
    ]);
  });

  it('contato sem nome continua a linha de texto antiga', async () => {
    await upsert({ contactMessage: { vcard: 'BEGIN:VCARD\nEND:VCARD' } });
    const message = await lastMessage();
    expect(message.messageType).toBe('text');
    expect(message.content).toBe('[Contato] sem nome');
  });
});

describe('mensagem antiga e anonimização', () => {
  it('mensagem antiga [Localizacao] (tipo text, sem metadata) lê sem erro', async () => {
    await upsert({ conversation: '[Localizacao] Casa (-28.4, -49.0)' });
    const message = await lastMessage();
    expect(message.messageType).toBe('text');
    expect(message.media).toBeNull();
    expect(message.location).toBeNull();
    expect(message.contacts).toEqual([]);
  });

  it('mensagem apagada sai sem media, location e contacts (D-220)', async () => {
    await upsert({ locationMessage: { degreesLatitude: 1, degreesLongitude: 2, name: 'X' } });
    const before = await lastMessage();
    await db.withoutTenant((tx) =>
      tx.query(`UPDATE messages SET deleted_at = NOW() WHERE id = $1`, [before.id]),
    );
    const after = await messages.findById(tenant.id, before.id);
    expect(after?.location).toBeNull();
    expect(after?.contacts).toEqual([]);
    expect(after?.media).toBeNull();
  });
});
