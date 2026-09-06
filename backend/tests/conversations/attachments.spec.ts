/**
 * POST /conversations/:id/attachments — anexo (Onda 8 §4.3).
 *
 * O que os testes protegem:
 *   1. o anexo grava a mídia, cria a mensagem com o `messageType` certo e o
 *      `attachmentUrl` aponta para `GET /media/:id` (que devolve os bytes);
 *   2. arquivo acima do teto e `MEDIA_TOO_LARGE`, sem gravar mensagem nenhuma;
 *   3. conversa de outro tenant é 404 e não grava mídia nenhuma;
 *   4. mídia de outro tenant é 404 no `GET /media/:id` (RLS).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { conversationModule } from '../../src/controllers/conversation.routes.js';
import { mediaModule } from '../../src/controllers/media.routes.js';
import { MAX_MEDIA_BYTES } from '../../src/services/media.service.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

describe('POST /conversations/:id/attachments', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ modules: [conversationModule, mediaModule] });
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('grava a mídia, cria a mensagem e o attachmentUrl serve os bytes de volta', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });

    const contentBase64 = Buffer.from('foto do pedido medico').toString('base64');
    const created = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/attachments`)
      .set(app.auth(ana))
      .send({ fileName: 'pedido.jpg', mimeType: 'image/jpeg', contentBase64 })
      .expect(201);

    expect(created.body.messageType).toBe('image');
    expect(created.body.attachmentUrl).toMatch(/^\/api\/v1\/media\/[0-9a-f-]{36}$/);

    const mediaId = created.body.attachmentUrl.split('/').pop();
    const media = await app.agent
      .get(`/api/v1/media/${mediaId}`)
      .set(app.auth(ana))
      .expect(200);
    expect(media.headers['content-type']).toBe('image/jpeg');
    expect(media.body.toString('utf8')).toBe('foto do pedido medico');

    const db = await getTestDb();
    const rows = await db.withoutTenant((tx) =>
      tx.query<{ message_id: string | null }>(
        'SELECT message_id FROM message_media WHERE id = $1',
        [mediaId],
      ),
    );
    expect(rows.rows[0]?.message_id).toBe(created.body.id);
  });

  it('arquivo acima do teto é MEDIA_TOO_LARGE e não grava mensagem', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });

    const oversized = Buffer.alloc(MAX_MEDIA_BYTES + 1).toString('base64');
    const response = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/attachments`)
      .set(app.auth(ana))
      .send({ fileName: 'grande.pdf', mimeType: 'application/pdf', contentBase64: oversized })
      .expect(413);
    expect(response.body.error.code).toBe('MEDIA_TOO_LARGE');

    const db = await getTestDb();
    const messages = await db.withoutTenant((tx) =>
      tx.query<{ total: number }>('SELECT COUNT(*)::int AS total FROM messages'),
    );
    expect(messages.rows[0]?.total).toBe(0);
  });

  it('conversa de OUTRO tenant é 404 e não grava mídia nenhuma', async () => {
    const alfa = await createTenant();
    const beta = await createTenant();
    const ana = await createUser({ tenantId: alfa.id, role: 'attendant', name: 'Ana' });
    const deBeta = await createConversation({ tenantId: beta.id, assignedTo: null });

    await app.agent
      .post(`/api/v1/conversations/${deBeta.id}/attachments`)
      .set(app.auth(ana))
      .send({ fileName: 'x.pdf', mimeType: 'application/pdf', contentBase64: 'eA==' })
      .expect(404);

    const db = await getTestDb();
    const rows = await db.withoutTenant((tx) =>
      tx.query<{ total: number }>('SELECT COUNT(*)::int AS total FROM message_media'),
    );
    expect(rows.rows[0]?.total).toBe(0);
  });

  it('mídia de OUTRO tenant é 404 no GET /media/:id', async () => {
    const alfa = await createTenant();
    const beta = await createTenant();
    const ana = await createUser({ tenantId: alfa.id, role: 'attendant', name: 'Ana' });
    const bia = await createUser({ tenantId: beta.id, role: 'attendant', name: 'Bia' });
    const conversationDeBeta = await createConversation({ tenantId: beta.id, assignedTo: bia.id });

    const created = await app.agent
      .post(`/api/v1/conversations/${conversationDeBeta.id}/attachments`)
      .set(app.auth(bia))
      .send({ fileName: 'x.pdf', mimeType: 'application/pdf', contentBase64: 'eA==' })
      .expect(201);
    const mediaId = created.body.attachmentUrl.split('/').pop();

    await app.agent.get(`/api/v1/media/${mediaId}`).set(app.auth(ana)).expect(404);
  });
});
