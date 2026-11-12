/**
 * CRMLAB-140 (D-314) — anexos pela Cloud API, de ponta a ponta.
 *
 * - envio: formato que a Meta não aceita (ou foto acima de 5 MB) é recusado
 *   ANTES de gravar, com o motivo; no QR nada muda;
 * - recebimento: a mídia é baixada da Meta e vira anexo de verdade; se o
 *   download não dá certo, entra o aviso de texto e a mensagem não se perde;
 *   reentrega não baixa de novo;
 * - ffmpeg real (só onde o binário existe): WebM vira OGG.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConversationModule } from '../../src/controllers/conversation.routes.js';
import { makeWebhookModule } from '../../src/controllers/webhook.routes.js';
import { convertAudioToOgg, FFMPEG_OGG_ARGS } from '../../src/lib/audio-to-ogg.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import {
  MediaDownloadError,
  MockWhatsAppDriver,
  WhatsAppService,
  signWebhookBody,
  type DownloadedMedia,
  type OutboundMedia,
  type WhatsAppCredentials,
  type WhatsAppCredentialsResolver,
} from '../../src/services/whatsapp.service.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { TEST_WEBHOOK_SECRET } from './fixtures.js';

/** Mock com download: o teste decide o que a "Meta" devolve. */
class DownloadingDriver extends MockWhatsAppDriver {
  downloads: string[] = [];
  next: () => Promise<DownloadedMedia> = async () => ({ buffer: Buffer.from('%PDF-1.4 laudo'), mimeType: 'application/pdf' });

  async downloadMedia(_credentials: WhatsAppCredentials, mediaId: string): Promise<DownloadedMedia> {
    this.downloads.push(mediaId);
    return this.next();
  }
}

let app: TestApp;
let driver: DownloadingDriver;
let modes: Map<string, 'qr' | 'cloud_api'>;
let slugToId: Map<string, string>;

function resolver(): WhatsAppCredentialsResolver {
  const build = (tenantId: string): WhatsAppCredentials => {
    const mode = modes.get(tenantId) ?? 'cloud_api';
    return {
      tenantId,
      phoneNumberId: 'numero-do-lab',
      // URL "real" da Meta: o webhook baixa a mídia (sem URL = mock, aviso de texto).
      apiUrl: 'https://graph.test/v21.0',
      wabaId: 'WABA',
      apiToken: 'token',
      webhookSecret: TEST_WEBHOOK_SECRET,
      isActive: true,
      apiTokenRevoked: false,
      connectionMode: mode,
      qrInstanceApiKey: mode === 'qr' ? 'apikey' : null,
    };
  };
  return {
    forTenant: async (id) => build(id),
    byWebhookIdentity: async (identity) => {
      const id = slugToId.get(identity);
      return id ? build(id) : null;
    },
  };
}

async function exec(sql: string, params: unknown[]): Promise<void> {
  const db = await getTestDb();
  await db.withoutTenant((tx) => tx.query(sql, params));
}

async function query<T>(sql: string, params: unknown[]): Promise<T[]> {
  const db = await getTestDb();
  const result = await db.withoutTenant((tx) => tx.query<T & Record<string, unknown>>(sql, params));
  return result.rows as T[];
}

async function lab(mode: 'qr' | 'cloud_api' = 'cloud_api') {
  const slug = `lab-${randomUUID().slice(0, 8)}`;
  const tenant = await createTenant({ slug });
  slugToId.set(slug, tenant.id);
  modes.set(tenant.id, mode);
  const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
  await exec(
    `INSERT INTO tenant_channels (tenant_id, channel, is_active, connection_mode, cloud_api_since)
     VALUES ($1, 'whatsapp', TRUE, $2, NOW() - interval '30 days')`,
    [tenant.id, mode],
  );
  const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
  await exec(
    `INSERT INTO messages (id, tenant_id, conversation_id, sender_type, content, received_via, external_message_id)
     VALUES ($1, $2, $3, 'patient', 'oi', 'cloud_api', $4)`,
    [randomUUID(), tenant.id, conversation.id, `wamid.${randomUUID()}`],
  );
  return { tenant, slug, ana, conversation };
}

function attach(conversationId: string, user: { id: string }, file: { name: string; type: string; bytes: Buffer }) {
  return app.agent
    .post(`/api/v1/conversations/${conversationId}/attachments`)
    .set(app.auth(user as Parameters<TestApp['auth']>[0]))
    .send({ fileName: file.name, mimeType: file.type, contentBase64: file.bytes.toString('base64') });
}

async function agentMessages(conversationId: string) {
  return query<{ message_type: string }>(
    `SELECT message_type FROM messages WHERE conversation_id = $1 AND sender_type = 'agent'`,
    [conversationId],
  );
}

function mediaNotice(slug: string, message: Record<string, unknown>) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'numero-do-lab' },
              contacts: [{ wa_id: '5548999991234', profile: { name: 'Joao' } }],
              messages: [{ from: '5548999991234', timestamp: '1730880000', ...message }],
            },
          },
        ],
      },
    ],
  });
  return app.agent
    .post(`/api/v1/webhooks/whatsapp/${slug}`)
    .set('x-hub-signature-256', signWebhookBody(body, TEST_WEBHOOK_SECRET))
    .set('Content-Type', 'application/json')
    .send(body)
    .expect(200);
}

async function patientMessages(tenantId: string) {
  return query<{ content: string; message_type: string; attachment_url: string | null; received_via: string | null }>(
    `SELECT content, message_type, attachment_url, received_via FROM messages
      WHERE tenant_id = $1 AND sender_type = 'patient' AND content <> 'oi' ORDER BY created_at`,
    [tenantId],
  );
}

beforeEach(async () => {
  await resetDatabase();
  modes = new Map();
  slugToId = new Map();
  driver = new DownloadingDriver();
  const whatsapp = new WhatsAppService({
    credentials: resolver(),
    driver,
    evolutionDriver: new MockWhatsAppDriver(),
    queue: createInMemoryQueue({ sleep: async () => undefined }),
    attempts: 1,
  });
  app = await createTestApp({
    db: await getTestDb(),
    modules: [makeConversationModule({ whatsapp }), makeWebhookModule({ whatsapp })],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('envio pela fila: o que não muda fica fora dela (D-314 item 3)', () => {
  it('WebM é convertido UMA vez; upload/envio têm no máximo 2 tentativas', async () => {
    let conversions = 0;
    let attempts = 0;
    const failing = new MockWhatsAppDriver();
    failing.sendMedia = async () => {
      attempts += 1;
      throw new Error('Meta fora');
    };
    const whatsapp = new WhatsAppService({
      credentials: resolver(),
      driver: failing,
      queue: createInMemoryQueue({ sleep: async () => undefined }),
      attempts: 3,
      convertAudio: async () => {
        conversions += 1;
        return Buffer.from('OggS');
      },
    });
    const tenant = await createTenant();
    modes.set(tenant.id, 'cloud_api');
    await expect(
      whatsapp.sendMedia(tenant.id, '5548', { buffer: Buffer.from('webm'), mimeType: 'audio/webm', fileName: 'r.webm' }),
    ).rejects.toThrow();
    expect(conversions).toBe(1);
    expect(attempts).toBe(2);
  });

  it('WebM convertido chega ao driver como OGG marcado voice (CRMLAB-147)', async () => {
    const seen: OutboundMedia[] = [];
    const driver = new MockWhatsAppDriver();
    driver.sendMedia = async (_credentials, _phone, media) => {
      seen.push(media);
      return { externalId: 'wamid.V' };
    };
    const whatsapp = new WhatsAppService({
      credentials: resolver(),
      driver,
      queue: createInMemoryQueue({ sleep: async () => undefined }),
      convertAudio: async () => Buffer.from('OggS'),
    });
    const tenant = await createTenant();
    modes.set(tenant.id, 'cloud_api');
    await whatsapp.sendMedia(tenant.id, '5548', { buffer: Buffer.from('webm'), mimeType: 'audio/webm', fileName: 'r.webm' });
    await whatsapp.sendMedia(tenant.id, '5548', { buffer: Buffer.from('mp3'), mimeType: 'audio/mpeg', fileName: 'a.mp3' });
    expect(seen.map((m) => [m.mimeType, m.fileName, m.voice])).toEqual([
      ['audio/ogg', 'r.ogg', true],
      ['audio/mpeg', 'a.mp3', undefined],
    ]);
  });

  it('formato recusado nem entra na fila', async () => {
    let attempts = 0;
    const counting = new MockWhatsAppDriver();
    counting.sendMedia = async () => {
      attempts += 1;
      return { externalId: 'x' };
    };
    const whatsapp = new WhatsAppService({
      credentials: resolver(),
      driver: counting,
      queue: createInMemoryQueue({ sleep: async () => undefined }),
    });
    const tenant = await createTenant();
    await expect(
      whatsapp.sendMedia(tenant.id, '5548', { buffer: Buffer.from('x'), mimeType: 'video/quicktime', fileName: 'a.mov' }),
    ).rejects.toThrow(/nao aceito/);
    expect(attempts).toBe(0);
  });
});

describe('envio de anexo pela Cloud API (D-314 item 2)', () => {
  it('formato que a Meta não aceita: 400 com o motivo, nada gravado; PDF passa', async () => {
    const { ana, conversation } = await lab();
    const csv = await attach(conversation.id, ana, { name: 'lista.csv', type: 'text/csv', bytes: Buffer.from('a,b\n1,2') }).expect(400);
    expect(csv.body.error.code).toBe('VALIDATION_ERROR');
    expect(csv.body.error.details.reason).toBe('cloud_api_media_type');
    expect(csv.body.error.details.fields.mimeType).toMatch(/API oficial/);
    expect(await agentMessages(conversation.id)).toHaveLength(0);

    await attach(conversation.id, ana, { name: 'laudo.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF-1.4 x') }).expect(201);
    expect(await agentMessages(conversation.id)).toEqual([{ message_type: 'pdf' }]);
  });

  it('foto acima de 5 MB: 413 com o limite da Meta, nada gravado', async () => {
    const { ana, conversation } = await lab();
    const big = await sharp({
      create: {
        width: 2600,
        height: 2600,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
        noise: { type: 'gaussian', mean: 128, sigma: 60 },
      },
    })
      .jpeg({ quality: 100 })
      .toBuffer();
    expect(big.byteLength).toBeGreaterThan(5 * 1024 * 1024);
    const response = await attach(conversation.id, ana, { name: 'foto.jpg', type: 'image/jpeg', bytes: big }).expect(413);
    expect(response.body.error.code).toBe('MEDIA_TOO_LARGE');
    expect(response.body.error.details).toMatchObject({ reason: 'cloud_api_image_limit', max: 5 * 1024 * 1024 });
    expect(await agentMessages(conversation.id)).toHaveLength(0);
  }, 30_000);

  it('GIF e PNG animados: recusados na API oficial (a Meta só aceita imagem parada)', async () => {
    const { ana, conversation } = await lab();
    const frame = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const idat = frame.indexOf('IDAT', 8, 'latin1') - 4;
    const actl = Buffer.alloc(20);
    actl.writeUInt32BE(8, 0);
    actl.write('acTL', 4, 'latin1');
    actl.writeUInt32BE(2, 8);
    const apng = Buffer.concat([frame.subarray(0, idat), actl, frame.subarray(idat)]);
    const png = await attach(conversation.id, ana, { name: 'anim.png', type: 'image/png', bytes: apng }).expect(400);
    expect(png.body.error.details.reason).toBe('cloud_api_media_type');

    // GIF89a 1x1 com dois quadros e laço NETSCAPE (o sharp le 2 páginas).
    const gifFrame = '21f904000a0000002c00000000010001000002024401' + '00';
    const animated = Buffer.from(
      '4749463839610100010080000000' + '0000ffffff' + '21ff0b' + Buffer.from('NETSCAPE2.0').toString('hex') +
        '0301000000' + gifFrame + gifFrame + '3b',
      'hex',
    );
    const response = await attach(conversation.id, ana, { name: 'anim.gif', type: 'image/gif', bytes: animated }).expect(400);
    expect(response.body.error.details.reason).toBe('cloud_api_media_type');
    expect(await agentMessages(conversation.id)).toHaveLength(0);
  });

  it('janela fechada + formato recusado: o aviso é o do formato (vem antes da janela)', async () => {
    const { tenant, ana } = await lab();
    // Conversa sem fala do paciente: janela fechada (D-310).
    const fechada = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
    const response = await attach(fechada.id, ana, { name: 'lista.csv', type: 'text/csv', bytes: Buffer.from('a,b') }).expect(400);
    expect(response.body.error.details.reason).toBe('cloud_api_media_type');
    const pdf = await attach(fechada.id, ana, { name: 'a.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF-1.4 x') });
    expect(pdf.body.error.code).toBe('WHATSAPP_WINDOW_CLOSED');
  });

  it('"tentar de novo" de anexo gravado no QR e reenviado na API oficial: 400 com o motivo', async () => {
    const { tenant, ana, conversation } = await lab('qr');
    vi.spyOn(driver, 'sendMedia').mockRejectedValueOnce(new Error('gateway fora'));
    const failed = await attach(conversation.id, ana, { name: 'lista.csv', type: 'text/csv', bytes: Buffer.from('a,b') });
    const messageId = (failed.body.id ?? failed.body.error?.details?.messageId) as string;
    await exec(`UPDATE messages SET status = 'failed' WHERE id = $1`, [messageId]);
    modes.set(tenant.id, 'cloud_api');
    const retry = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages/${messageId}/retry`)
      .set(app.auth(ana))
      .expect(400);
    expect(retry.body.error.details.reason).toBe('cloud_api_media_type');
    const [row] = await query<{ status: string }>('SELECT status FROM messages WHERE id = $1', [messageId]);
    expect(row?.status).toBe('failed');
  });

  it('no QR o mesmo CSV continua saindo', async () => {
    const { ana, conversation } = await lab('qr');
    await attach(conversation.id, ana, { name: 'lista.csv', type: 'text/csv', bytes: Buffer.from('a,b\n1,2') }).expect(201);
  });
});

describe('mídia recebida pela Cloud API (D-314 itens 4 e 5)', () => {
  it('documento baixado vira anexo de verdade; reentrega não baixa de novo', async () => {
    const { tenant, slug } = await lab();
    const message = {
      id: 'wamid.DOC1',
      type: 'document',
      document: { id: 'MID-DOC', mime_type: 'application/pdf', filename: 'pedido.pdf' },
    };
    await mediaNotice(slug, message);
    await mediaNotice(slug, message);
    expect(driver.downloads).toEqual(['MID-DOC']);
    const rows = await patientMessages(tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ content: 'pedido.pdf', message_type: 'pdf', received_via: 'cloud_api' });
    expect(rows[0]?.attachment_url).toMatch(/^\/api\/v1\/media\/[0-9a-f-]{36}$/);
    const media = await query<{ message_id: string | null; mime_type: string }>(
      `SELECT message_id, mime_type FROM message_media WHERE tenant_id = $1`,
      [tenant.id],
    );
    expect(media).toHaveLength(1);
    expect(media[0]?.message_id).not.toBeNull();
  });

  it('foto com legenda: imagem gravada em JPEG, conteúdo = legenda', async () => {
    const { tenant, slug } = await lab();
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 10, b: 10 } } })
      .png()
      .toBuffer();
    driver.next = async () => ({ buffer: png, mimeType: 'image/png' });
    await mediaNotice(slug, { id: 'wamid.IMG1', type: 'image', image: { id: 'MID-IMG', mime_type: 'image/png', caption: 'Meu pedido' } });
    const [row] = await patientMessages(tenant.id);
    expect(row).toMatchObject({ content: 'Meu pedido', message_type: 'image' });
  });

  it('figurinha mantém o WebP e vira sticker; recado de voz recebido vira áudio', async () => {
    const { tenant, slug } = await lab();
    const webp = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 200, b: 0, alpha: 1 } } })
      .webp()
      .toBuffer();
    driver.next = async () => ({ buffer: webp, mimeType: 'image/webp' });
    await mediaNotice(slug, { id: 'wamid.STK1', type: 'sticker', sticker: { id: 'MID-STK', mime_type: 'image/webp' } });
    const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24), Buffer.from('OpusHead'), Buffer.alloc(64)]);
    driver.next = async () => ({ buffer: ogg, mimeType: 'audio/ogg; codecs=opus' });
    await mediaNotice(slug, { id: 'wamid.VOZ1', type: 'audio', audio: { id: 'MID-VOZ', mime_type: 'audio/ogg; codecs=opus', voice: true } });
    const rows = await patientMessages(tenant.id);
    expect(rows.map((r) => r.message_type)).toEqual(['sticker', 'audio']);
    const media = await query<{ mime_type: string }>(
      `SELECT mime_type FROM message_media WHERE tenant_id = $1 ORDER BY created_at`,
      [tenant.id],
    );
    expect(media[0]?.mime_type).toBe('image/webp');
  });

  it('download que falha: entra o aviso de texto, sem anexo', async () => {
    const { tenant, slug } = await lab();
    driver.next = async () => {
      throw new MediaDownloadError('timeout');
    };
    await mediaNotice(slug, { id: 'wamid.AUD1', type: 'audio', audio: { id: 'MID-AUD', mime_type: 'audio/ogg' } });
    const [row] = await patientMessages(tenant.id);
    expect(row).toMatchObject({ message_type: 'text', attachment_url: null, received_via: 'cloud_api' });
    expect(row?.content).toContain('[Recebido pela API oficial: áudio');
  });
});

describe('argumentos do ffmpeg para o iPhone (CRMLAB-147, D-319)', () => {
  it('1 pacote Opus por página, mono 48 kHz, voip, sem metadados', () => {
    const args = FFMPEG_OGG_ARGS.join(' ');
    expect(args).toContain('-map_metadata -1 -fflags +bitexact -ac 1 -ar 48000');
    expect(args).toContain('-c:a libopus -b:a 32k -application voip -page_duration 20000 -f ogg pipe:1');
  });
});

/** Pacotes por página de um OGG: segmentos < 255 do segment table fecham pacote. */
function oggPacketsPerPage(ogg: Buffer): number[] {
  const pages: number[] = [];
  let pos = 0;
  while (pos + 27 <= ogg.length && ogg.subarray(pos, pos + 4).toString('latin1') === 'OggS') {
    const segments = ogg[pos + 26] ?? 0;
    const table = ogg.subarray(pos + 27, pos + 27 + segments);
    pages.push(table.filter((lace) => lace < 255).length);
    pos += 27 + segments + table.reduce((sum, lace) => sum + lace, 0);
  }
  return pages;
}

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)('conversão real do recado de voz (ffmpeg)', () => {
  it('WebM/Opus vira OGG (cabeçalho OggS)', async () => {
    const webm = execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:a', 'libopus', '-f', 'webm', 'pipe:1',
    ]);
    const ogg = await convertAudioToOgg(webm);
    expect(ogg.subarray(0, 4).toString('latin1')).toBe('OggS');
  });

  it('páginas curtas: nenhuma página de áudio com mais de 1 pacote (iPhone, CRMLAB-147)', async () => {
    const webm = execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:a', 'libopus', '-f', 'webm', 'pipe:1',
    ]);
    const pages = oggPacketsPerPage(await convertAudioToOgg(webm));
    // 2 páginas de cabeçalho (OpusHead, OpusTags) + ~150 de áudio de 20 ms.
    expect(pages.length).toBeGreaterThan(100);
    expect(Math.max(...pages.slice(2))).toBeLessThanOrEqual(1);
  });

  it('arquivo inválido: lança (o envio vira falha com "tentar de novo")', async () => {
    await expect(convertAudioToOgg(Buffer.from('isto nao e audio'))).rejects.toThrow(/ffmpeg/);
  });
});
