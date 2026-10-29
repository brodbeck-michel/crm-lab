/**
 * Anexo de arquivo no chat interno — CRMLAB-101, D-271, API_CONTRACTS §3b.
 *
 * O que os testes protegem:
 *   1. o upload cria a mensagem com `attachment`, grava a linha e o arquivo em
 *      disco com o `id` da linha (nunca o nome enviado), e o download devolve os
 *      bytes com o nome original;
 *   2. o evento WS sai só com ids, e a listagem já traz o anexo;
 *   3. mesmos limites do atendimento: tipo fora da allow-list e conteúdo
 *      divergente são 400; acima de `MAX_MEDIA_BYTES` é 413 — nada gravado;
 *   4. acesso = ver o canal: DM alheia e outro tenant são 404 (nunca 403), no
 *      upload e no download; anexo de outro canal também é 404.
 */
import { existsSync, readFileSync } from 'node:fs';
import sharp from 'sharp';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_MEDIA_BYTES } from '@crm-lab/shared';
import type {
  ApiErrorBody,
  Channel,
  InternalMessage,
  ListChannelsResponse,
  ListInternalMessagesResponse,
} from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { internalChatModule } from '../../src/controllers/internal-chat.routes.js';
import { mediaFilePath } from '../../src/lib/media-storage.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

/** Cabeçalho PDF real — o sniff (`file-type`) reconhece como `application/pdf`. */
const PDF = Buffer.from('%PDF-1.4\n%sonda do chat interno\n');
/** Assinatura PNG — usada como "PDF" declarado para provar a recusa por divergência. */
const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
  Buffer.alloc(32),
]);

describe('anexo no chat interno (CRMLAB-101)', () => {
  let db: DbClient;
  let app: TestApp;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    app = await createTestApp({ db, modules: [internalChatModule] });
  });

  async function geralOf(user: Parameters<TestApp['auth']>[0]): Promise<Channel> {
    const response = await app.agent
      .get('/api/v1/internal-chat/channels')
      .set(app.auth(user))
      .expect(200);
    const geral = (response.body as ListChannelsResponse).channels.find((c) => c.key === 'geral');
    if (!geral) throw new Error('#geral nao criado');
    return geral;
  }

  function upload(user: Parameters<TestApp['auth']>[0], channelId: string, body: object) {
    return app.agent
      .post(`/api/v1/internal-chat/channels/${channelId}/attachments`)
      .set(app.auth(user))
      .send(body);
  }

  async function attachmentRows(): Promise<number> {
    const result = await db.withoutTenant((tx) =>
      tx.query<{ total: number }>('SELECT COUNT(*)::int AS total FROM internal_message_attachments'),
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  async function messageRows(): Promise<number> {
    const result = await db.withoutTenant((tx) =>
      tx.query<{ total: number }>('SELECT COUNT(*)::int AS total FROM internal_messages'),
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  it('a tabela nasce sob RLS, com policy (migração 055)', async () => {
    const rows = await db.query<{ rowsecurity: boolean; policies: number }>(
      `SELECT t.rowsecurity,
              (SELECT COUNT(*)::int FROM pg_policies p
                WHERE p.schemaname = 'public' AND p.tablename = t.tablename) AS policies
         FROM pg_tables t
        WHERE t.schemaname = 'public' AND t.tablename = 'internal_message_attachments'`,
    );
    expect(rows.rows[0]?.rowsecurity).toBe(true);
    expect(rows.rows[0]?.policies).toBeGreaterThan(0);
  });

  it('imagem PNG real vira JPEG ao gravar (CRMLAB-128, D-291)', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    const geral = await geralOf(ana);
    const png = await sharp({ create: { width: 20, height: 10, channels: 4, background: 'red' } }).png().toBuffer();

    const created = await upload(ana, geral.id, {
      fileName: 'print.png',
      mimeType: 'image/png',
      contentBase64: png.toString('base64'),
    }).expect(201);

    const attachment = (created.body as InternalMessage).attachment;
    if (!attachment) throw new Error('sem anexo');
    const onDisk = readFileSync(mediaFilePath(attachment.id));
    expect(attachment).toMatchObject({ fileName: 'print.jpg', mimeType: 'image/jpeg', byteSize: onDisk.byteLength });
    expect((await sharp(onDisk).metadata()).format).toBe('jpeg');
  });

  it('grava mensagem + anexo, arquivo com o id da linha, e o download devolve o nome original', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    const bia = await createUser({ tenantId: tenant.id, role: 'manager', name: 'Bia' });
    const geral = await geralOf(ana);

    const created = await upload(ana, geral.id, {
      fileName: '../../pedido médico.pdf',
      mimeType: 'application/pdf',
      contentBase64: PDF.toString('base64'),
      content: '  Pedido da sala 2  ',
    }).expect(201);

    const message = created.body as InternalMessage;
    expect(message.content).toBe('Pedido da sala 2');
    expect(message.senderName).toBe('Ana');
    expect(message.attachment).toMatchObject({
      fileName: '../../pedido médico.pdf',
      mimeType: 'application/pdf',
      byteSize: PDF.byteLength,
    });
    const attachment = message.attachment;
    if (!attachment) throw new Error('sem anexo');
    expect(attachment.url).toBe(
      `/api/v1/internal-chat/channels/${geral.id}/attachments/${attachment.id}`,
    );
    // Em disco, o nome é o UUID da linha — nunca o `fileName` enviado.
    expect(existsSync(mediaFilePath(attachment.id))).toBe(true);

    // Só ids no WS (D-271 item 6).
    const eventos = app.wsHub.eventsFor(tenant.id, 'internal_chat.new_message');
    expect(eventos.at(-1)?.data).toEqual({ channelId: geral.id, messageId: message.id });

    // Outro membro do canal lista a mensagem já com o anexo e baixa o arquivo.
    const listed = await app.agent
      .get(`/api/v1/internal-chat/channels/${geral.id}/messages`)
      .set(app.auth(bia))
      .expect(200);
    const found = (listed.body as ListInternalMessagesResponse).messages.find((m) => m.id === message.id);
    expect(found?.attachment).toEqual(attachment);

    const download = await app.agent
      .get(attachment.url)
      .set(app.auth(bia))
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(download.headers['content-type']).toBe('application/pdf');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(download.headers['content-disposition']).toBe(
      `attachment; filename="${encodeURIComponent('../../pedido médico.pdf')}"`,
    );
    expect((download.body as Buffer).equals(PDF)).toBe(true);
  });

  it('só o arquivo, sem texto: mensagem nasce com content vazio', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const geral = await geralOf(ana);

    const created = await upload(ana, geral.id, {
      fileName: 'foto.png',
      mimeType: 'image/png',
      contentBase64: PNG.toString('base64'),
    }).expect(201);

    expect((created.body as InternalMessage).content).toBe('');
    expect((created.body as InternalMessage).attachment?.mimeType).toBe('image/png');
  });

  it('recado de voz do navegador (ogg/opus e webm/opus) é aceito e gravado como áudio (CRMLAB-109)', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const geral = await geralOf(ana);
    // Página Ogg com cabeçalho Opus no offset 28 — o que o Firefox grava.
    const ogg = Buffer.concat([
      Buffer.from('OggS'),
      Buffer.from([0x00, 0x02]),
      Buffer.alloc(22),
      Buffer.from('OpusHead'),
      Buffer.alloc(64),
    ]);
    // Cabeçalho EBML de WebM — o que o Chrome grava (o `file-type` lê como vídeo).
    const webm = Buffer.concat([
      Buffer.from(
        '1a45dfa39f4286810142f7810142f2810442f381084282847765626d42878104428581021853806701ffffffffffffff',
        'hex',
      ),
      Buffer.alloc(64),
    ]);

    for (const [mimeType, buffer, stored] of [
      ['audio/ogg;codecs=opus', ogg, 'audio/ogg'],
      ['audio/webm;codecs=opus', webm, 'audio/webm'],
    ] as const) {
      const created = await upload(ana, geral.id, {
        fileName: `recado-de-voz.${stored.split('/')[1] ?? 'bin'}`,
        mimeType,
        contentBase64: buffer.toString('base64'),
      }).expect(201);
      expect((created.body as InternalMessage).attachment?.mimeType).toBe(stored);
    }
  });

  it('tipo fora da allow-list é 400 e não grava nada', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const geral = await geralOf(ana);

    const response = await upload(ana, geral.id, {
      fileName: 'pagina.html',
      mimeType: 'text/html',
      contentBase64: Buffer.from('<script>alert(1)</script>').toString('base64'),
    }).expect(400);

    expect((response.body as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
    expect(await attachmentRows()).toBe(0);
    expect(await messageRows()).toBe(0);
  });

  it('conteúdo divergente do tipo declarado é 400 (não rebaixa em silêncio)', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const geral = await geralOf(ana);

    const response = await upload(ana, geral.id, {
      fileName: 'falso.pdf',
      mimeType: 'application/pdf',
      contentBase64: PNG.toString('base64'),
    }).expect(400);

    expect((response.body as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
    expect(await attachmentRows()).toBe(0);
  });

  it('acima de MAX_MEDIA_BYTES é 413 MEDIA_TOO_LARGE e não grava nada', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const geral = await geralOf(ana);

    const big = Buffer.alloc(MAX_MEDIA_BYTES + 1, 0x41);
    const response = await upload(ana, geral.id, {
      fileName: 'grande.txt',
      mimeType: 'text/plain',
      contentBase64: big.toString('base64'),
    }).expect(413);

    expect((response.body as ApiErrorBody).error.code).toBe('MEDIA_TOO_LARGE');
    expect(await attachmentRows()).toBe(0);
    expect(await messageRows()).toBe(0);
  });

  it('DM alheia: quem não participa recebe 404 no upload e no download', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const bia = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const caio = await createUser({ tenantId: tenant.id, role: 'admin' });

    const dm = await app.agent
      .post('/api/v1/internal-chat/dms')
      .set(app.auth(ana))
      .send({ userId: bia.id })
      .expect(200);
    const dmId = (dm.body as Channel).id;

    const created = await upload(ana, dmId, {
      fileName: 'particular.pdf',
      mimeType: 'application/pdf',
      contentBase64: PDF.toString('base64'),
    }).expect(201);
    const url = (created.body as InternalMessage).attachment?.url ?? '';

    // Participante baixa; terceiro do MESMO tenant, mesmo admin, não.
    await app.agent.get(url).set(app.auth(bia)).expect(200);
    const denied = await app.agent.get(url).set(app.auth(caio)).expect(404);
    expect((denied.body as ApiErrorBody).error.code).toBe('NOT_FOUND');

    const deniedUpload = await upload(caio, dmId, {
      fileName: 'intruso.pdf',
      mimeType: 'application/pdf',
      contentBase64: PDF.toString('base64'),
    }).expect(404);
    expect((deniedUpload.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
  });

  it('anexo de uma DM não sai pelo :id de outro canal visível', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const bia = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const caio = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const geral = await geralOf(caio);

    const dm = await app.agent
      .post('/api/v1/internal-chat/dms')
      .set(app.auth(ana))
      .send({ userId: bia.id })
      .expect(200);
    const created = await upload(ana, (dm.body as Channel).id, {
      fileName: 'particular.pdf',
      mimeType: 'application/pdf',
      contentBase64: PDF.toString('base64'),
    }).expect(201);
    const attachmentId = (created.body as InternalMessage).attachment?.id ?? '';

    await app.agent
      .get(`/api/v1/internal-chat/channels/${geral.id}/attachments/${attachmentId}`)
      .set(app.auth(caio))
      .expect(404);
  });

  it('outro tenant: 404 no upload e no download', async () => {
    const alfa = await createTenant({ name: 'Alfa' });
    const beta = await createTenant({ name: 'Beta' });
    const ana = await createUser({ tenantId: alfa.id, role: 'admin' });
    const bruno = await createUser({ tenantId: beta.id, role: 'admin' });
    const geralAlfa = await geralOf(ana);

    const created = await upload(ana, geralAlfa.id, {
      fileName: 'interno.pdf',
      mimeType: 'application/pdf',
      contentBase64: PDF.toString('base64'),
    }).expect(201);
    const url = (created.body as InternalMessage).attachment?.url ?? '';

    const download = await app.agent.get(url).set(app.auth(bruno)).expect(404);
    expect((download.body as ApiErrorBody).error.code).toBe('NOT_FOUND');

    const uploadBeta = await upload(bruno, geralAlfa.id, {
      fileName: 'intruso.pdf',
      mimeType: 'application/pdf',
      contentBase64: PDF.toString('base64'),
    }).expect(404);
    expect((uploadBeta.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
    expect(await attachmentRows()).toBe(1);
  });
});
