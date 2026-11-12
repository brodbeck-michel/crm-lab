/**
 * CRMLAB-140 (D-314) — anexos no driver REAL da Cloud API contra uma Graph API
 * falsa (servidor HTTP local).
 *
 * Envio: upload multipart em `/{phone_number_id}/media`, depois a mensagem por
 * id (legenda menos em áudio, `filename` em documento, citação); WebM vira OGG
 * antes; formato que a Meta não aceita nem sai.
 * Recebimento: `GET /{media_id}` + `GET url` com Bearer; o token só vai para
 * host da Meta; acima do teto do CRM nem baixa.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_MEDIA_BYTES } from '@crm-lab/shared';
import {
  HttpWhatsAppDriver,
  MediaDownloadError,
  isMetaMediaHost,
  type WhatsAppCredentials,
} from '../../src/services/whatsapp.service.js';

interface Hit {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  raw: Buffer;
}

let server: Server;
let hits: Hit[];
let base: string;
let respond: (hit: Hit) => { status: number; body: unknown; headers?: Record<string, string>; chunked?: boolean };

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

beforeEach(async () => {
  hits = [];
  server = createServer((req, res) => {
    void readRaw(req).then((raw) => {
      const hit: Hit = {
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        raw,
      };
      hits.push(hit);
      const { status, body, headers, chunked } = respond(hit);
      if (Buffer.isBuffer(body) && chunked) {
        // Sem content-length: o corpo vem em pedaços (transfer-encoding chunked).
        res.writeHead(status, { 'Content-Type': 'application/octet-stream', ...headers });
        const piece = 1024 * 1024;
        for (let i = 0; i < body.byteLength; i += piece) res.write(body.subarray(i, i + piece));
        res.end();
      } else if (Buffer.isBuffer(body)) {
        res.writeHead(status, { 'Content-Type': 'application/octet-stream', ...headers });
        res.end(body);
      } else {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v21.0`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function creds(): WhatsAppCredentials {
  return {
    tenantId: 't1',
    phoneNumberId: 'PNID',
    apiUrl: base,
    wabaId: 'WABA1',
    apiToken: 'token-da-meta',
    webhookSecret: 's',
    isActive: true,
    apiTokenRevoked: false,
    connectionMode: 'cloud_api',
    qrInstanceApiKey: null,
  };
}

/** Upload devolve `MEDIA1`; envio devolve `wamid.M`. */
function metaOk(hit: Hit): { status: number; body: unknown } {
  if (hit.url.endsWith('/media')) return { status: 200, body: { id: 'MEDIA1' } };
  return { status: 200, body: { messages: [{ id: 'wamid.M' }] } };
}

function sentBody(): Record<string, unknown> {
  const send = hits.find((h) => h.url.endsWith('/messages'));
  return JSON.parse(send?.raw.toString('utf8') ?? '{}') as Record<string, unknown>;
}

describe('HttpWhatsAppDriver.sendMedia', () => {
  it('imagem: upload multipart com Bearer e envio por id com legenda e citação', async () => {
    respond = metaOk;
    const result = await new HttpWhatsAppDriver().sendMedia(
      creds(),
      '5548999991234',
      { buffer: Buffer.from('jpeg-bytes'), mimeType: 'image/jpeg', fileName: 'pedido.jpg', caption: 'Pedido' },
      { quoted: { externalId: 'wamid.Q', fromMe: false, content: 'oi' } },
    );
    expect(result.externalId).toBe('wamid.M');
    const upload = hits[0];
    expect(upload?.url).toBe('/v21.0/PNID/media');
    expect(upload?.authorization).toBe('Bearer token-da-meta');
    expect(upload?.contentType).toMatch(/^multipart\/form-data/);
    const form = upload?.raw.toString('latin1') ?? '';
    expect(form).toContain('name="messaging_product"');
    expect(form).toContain('image/jpeg');
    expect(form).toContain('filename="pedido.jpg"');
    expect(form).toContain('jpeg-bytes');
    expect(sentBody()).toEqual({
      messaging_product: 'whatsapp',
      to: '5548999991234',
      type: 'image',
      image: { id: 'MEDIA1', caption: 'Pedido' },
      context: { message_id: 'wamid.Q' },
    });
  });

  it('documento leva filename; áudio não leva legenda', async () => {
    respond = metaOk;
    const driver = new HttpWhatsAppDriver();
    await driver.sendMedia(creds(), '5548', {
      buffer: Buffer.from('%PDF-1.4'),
      mimeType: 'application/pdf',
      fileName: 'laudo.pdf',
      caption: 'Seu laudo',
    });
    expect(sentBody()).toMatchObject({ type: 'document', document: { id: 'MEDIA1', caption: 'Seu laudo', filename: 'laudo.pdf' } });
    hits = [];
    await driver.sendMedia(creds(), '5548', {
      buffer: Buffer.from('mp3'),
      mimeType: 'audio/mpeg',
      fileName: 'a.mp3',
      caption: 'ignorada',
    });
    expect(sentBody()).toMatchObject({ type: 'audio', audio: { id: 'MEDIA1' } });
    expect((sentBody().audio as Record<string, unknown>).caption).toBeUndefined();
  });

  it('recado de voz WebM é convertido para OGG antes do upload', async () => {
    respond = metaOk;
    const converted: Buffer[] = [];
    const driver = new HttpWhatsAppDriver({
      convertAudio: async (input) => {
        converted.push(input);
        return Buffer.from('OggS-convertido');
      },
    });
    await driver.sendMedia(creds(), '5548', {
      buffer: Buffer.from('webm-original'),
      mimeType: 'audio/webm;codecs=opus',
      fileName: 'recado.webm',
    });
    expect(converted.map((b) => b.toString())).toEqual(['webm-original']);
    const form = hits[0]?.raw.toString('latin1') ?? '';
    expect(form).toContain('audio/ogg');
    expect(form).toContain('filename="recado.ogg"');
    expect(form).toContain('OggS-convertido');
    expect(form).not.toContain('webm-original');
    // CRMLAB-147: o convertido sai como recado de voz.
    expect(sentBody()).toMatchObject({ type: 'audio', audio: { id: 'MEDIA1', voice: true } });
  });

  it('áudio anexado (MP3) não vira recado de voz; OGG já preparado pela fila mantém voice', async () => {
    respond = metaOk;
    const driver = new HttpWhatsAppDriver();
    await driver.sendMedia(creds(), '5548', { buffer: Buffer.from('mp3'), mimeType: 'audio/mpeg', fileName: 'a.mp3' });
    expect((sentBody().audio as Record<string, unknown>).voice).toBeUndefined();
    hits = [];
    await driver.sendMedia(creds(), '5548', {
      buffer: Buffer.from('OggS'),
      mimeType: 'audio/ogg',
      fileName: 'recado.ogg',
      voice: true,
    });
    expect(sentBody()).toMatchObject({ type: 'audio', audio: { id: 'MEDIA1', voice: true } });
  });

  it('formato que a Meta não aceita ou imagem acima de 5 MB: não chama a Meta', async () => {
    respond = metaOk;
    const driver = new HttpWhatsAppDriver();
    await expect(
      driver.sendMedia(creds(), '5548', { buffer: Buffer.from('x'), mimeType: 'video/quicktime', fileName: 'a.mov' }),
    ).rejects.toThrow(/nao aceito/);
    await expect(
      driver.sendMedia(creds(), '5548', {
        buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
        mimeType: 'image/jpeg',
        fileName: 'grande.jpg',
      }),
    ).rejects.toThrow(/limite/);
    expect(hits).toHaveLength(0);
  });

  it('upload recusado pela Meta vira exceção (falha de envio)', async () => {
    respond = () => ({ status: 400, body: { error: { message: 'bad' } } });
    await expect(
      new HttpWhatsAppDriver().sendMedia(creds(), '5548', {
        buffer: Buffer.from('%PDF'),
        mimeType: 'application/pdf',
        fileName: 'a.pdf',
      }),
    ).rejects.toThrow(/400/);
  });
});

describe('HttpWhatsAppDriver.downloadMedia', () => {
  it('busca a URL e baixa o arquivo, os dois com Bearer', async () => {
    respond = (hit) =>
      hit.url === '/v21.0/MID1'
        ? { status: 200, body: { url: `${base}/file/MID1`, mime_type: 'application/pdf', file_size: 8 } }
        : { status: 200, body: Buffer.from('%PDF-1.4') };
    const media = await new HttpWhatsAppDriver().downloadMedia(creds(), 'MID1');
    expect(media).toEqual({ buffer: Buffer.from('%PDF-1.4'), mimeType: 'application/pdf' });
    expect(hits.map((h) => [h.url, h.authorization])).toEqual([
      ['/v21.0/MID1', 'Bearer token-da-meta'],
      ['/v21.0/file/MID1', 'Bearer token-da-meta'],
    ]);
  });

  it('file_size acima do teto do CRM: nem baixa', async () => {
    respond = () => ({
      status: 200,
      body: { url: `${base}/file/X`, mime_type: 'video/mp4', file_size: MAX_MEDIA_BYTES + 1 },
    });
    const error = await new HttpWhatsAppDriver().downloadMedia(creds(), 'X').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MediaDownloadError);
    expect((error as MediaDownloadError).reason).toBe('too_large');
    expect(hits).toHaveLength(1);
  });

  it('sem content-length e acima do teto: para de ler e recusa', async () => {
    respond = (hit) =>
      hit.url === '/v21.0/BIG'
        ? { status: 200, body: { url: `${base}/file/BIG`, mime_type: 'video/mp4' } }
        : { status: 200, body: Buffer.alloc(MAX_MEDIA_BYTES + 1024 * 1024), chunked: true };
    const error = await new HttpWhatsAppDriver().downloadMedia(creds(), 'BIG').catch((err: unknown) => err);
    expect((error as MediaDownloadError).reason).toBe('too_large');
  });

  it('redirecionamento no arquivo: não segue (o token não sai) e falha', async () => {
    respond = (hit) =>
      hit.url === '/v21.0/R'
        ? { status: 200, body: { url: `${base}/file/R`, mime_type: 'image/jpeg', file_size: 10 } }
        : { status: 302, body: {}, headers: { Location: 'http://evil.example/x' } };
    const error = await new HttpWhatsAppDriver().downloadMedia(creds(), 'R').catch((err: unknown) => err);
    expect((error as MediaDownloadError).reason).toBe('http_error');
    expect(hits).toHaveLength(2);
  });

  it('URL fora da Meta: o token não sai', async () => {
    respond = () => ({
      status: 200,
      body: { url: 'http://evil.example/steal', mime_type: 'image/jpeg', file_size: 10 },
    });
    const error = await new HttpWhatsAppDriver().downloadMedia(creds(), 'X').catch((err: unknown) => err);
    expect((error as MediaDownloadError).reason).toBe('host_not_allowed');
    expect(hits).toHaveLength(1);
  });

  it('Meta responde erro ou JSON sem url: motivo no erro', async () => {
    respond = () => ({ status: 404, body: { error: {} } });
    const notFound = await new HttpWhatsAppDriver().downloadMedia(creds(), 'X').catch((err: unknown) => err);
    expect((notFound as MediaDownloadError).reason).toBe('http_error');
    respond = () => ({ status: 200, body: { id: 'X' } });
    const bad = await new HttpWhatsAppDriver().downloadMedia(creds(), 'X').catch((err: unknown) => err);
    expect((bad as MediaDownloadError).reason).toBe('bad_response');
  });

  it('isMetaMediaHost: https da Meta ou a origem configurada', () => {
    const api = 'https://graph.facebook.com/v21.0';
    expect(isMetaMediaHost('https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', api)).toBe(true);
    expect(isMetaMediaHost('https://graph.facebook.com/v21.0/x', api)).toBe(true);
    expect(isMetaMediaHost('https://mmg.whatsapp.net/x', api)).toBe(true);
    expect(isMetaMediaHost('http://lookaside.fbsbx.com/x', api)).toBe(false);
    expect(isMetaMediaHost('https://fbsbx.com.evil.example/x', api)).toBe(false);
    expect(isMetaMediaHost('https://evil.example/x', api)).toBe(false);
    expect(isMetaMediaHost('não é url', api)).toBe(false);
  });
});
