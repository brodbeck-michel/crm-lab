/**
 * D-273 (CRMLAB-108) — encerradas visiveis para todas as atendentes, e
 * responder uma encerrada reabre para quem enviou.
 *
 * O que NAO muda: conversa ATIVA de outra atendente continua 404, gestor e
 * admin seguem vendo tudo, e outro tenant nunca aparece (RLS).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { conversationModule } from '../../src/controllers/conversation.routes.js';
import { mediaModule } from '../../src/controllers/media.routes.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { readConversationRow, seedMessage, setUnreadCount } from './helpers.js';

describe('D-273: encerradas para todas', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ modules: [conversationModule, mediaModule] });
  });

  beforeEach(async () => {
    await resetDatabase();
    app.wsHub.clear();
  });

  async function scenario() {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    const bia = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Bia' });
    const encerradaDaBia = await createConversation({
      tenantId: tenant.id,
      assignedTo: bia.id,
      status: 'closed',
    });
    const ativaDaBia = await createConversation({ tenantId: tenant.id, assignedTo: bia.id });
    return { tenant, ana, bia, encerradaDaBia, ativaDaBia };
  }

  it('lista ?status=closed traz as encerradas de todas; a lista ativa segue recortada', async () => {
    const { ana, encerradaDaBia, ativaDaBia } = await scenario();
    const outro = await createTenant();
    const deOutroTenant = await createConversation({ tenantId: outro.id, status: 'closed' });

    const encerradas = await app.agent
      .get('/api/v1/conversations?status=closed')
      .set(app.auth(ana))
      .expect(200);
    const ids = encerradas.body.conversations.map((c: { id: string }) => c.id);
    expect(ids).toEqual([encerradaDaBia.id]);
    expect(ids).not.toContain(deOutroTenant.id);
    expect(encerradas.body.pagination.total).toBe(1);

    const ativas = await app.agent
      .get('/api/v1/conversations?status=active')
      .set(app.auth(ana))
      .expect(200);
    expect(ativas.body.conversations.map((c: { id: string }) => c.id)).not.toContain(ativaDaBia.id);

    // Sem status: a lista padrao NAO passa a incluir encerradas alheias.
    const padrao = await app.agent.get('/api/v1/conversations').set(app.auth(ana)).expect(200);
    expect(padrao.body.conversations).toHaveLength(0);
  });

  it('counts nao vazam: encerrada alheia com nao lida nao soma no unread', async () => {
    const { ana, encerradaDaBia } = await scenario();
    await setUnreadCount(encerradaDaBia.id, 3);

    const encerradas = await app.agent
      .get('/api/v1/conversations?status=closed')
      .set(app.auth(ana))
      .expect(200);
    expect(encerradas.body.conversations).toHaveLength(1);
    expect(encerradas.body.counts).toEqual({ mine: 0, unassigned: 0, unread: 0, participating: 0 });

    const ativas = await app.agent
      .get('/api/v1/conversations?status=active')
      .set(app.auth(ana))
      .expect(200);
    expect(ativas.body.counts).toEqual({ mine: 0, unassigned: 0, unread: 0, participating: 0 });
  });

  it('abre o detalhe, as mensagens e a busca dentro da encerrada de outra atendente', async () => {
    const { tenant, ana, encerradaDaBia } = await scenario();
    await seedMessage({
      tenantId: tenant.id,
      conversationId: encerradaDaBia.id,
      content: 'resultado da glicose',
    });

    const detalhe = await app.agent
      .get(`/api/v1/conversations/${encerradaDaBia.id}`)
      .set(app.auth(ana))
      .expect(200);
    expect(detalhe.body.conversation.id).toBe(encerradaDaBia.id);
    expect(detalhe.body.messages.map((m: { content: string }) => m.content)).toContain(
      'resultado da glicose',
    );

    // Busca dentro da conversa (D-228) e a busca geral acham a encerrada alheia.
    const naConversa = await app.agent
      .get(`/api/v1/conversations/${encerradaDaBia.id}/messages?q=glicose`)
      .set(app.auth(ana))
      .expect(200);
    expect(naConversa.body.results).toHaveLength(1);
    const geral = await app.agent
      .get('/api/v1/conversations/search/messages?q=glicose')
      .set(app.auth(ana))
      .expect(200);
    expect(geral.body.results.map((r: { conversationId: string }) => r.conversationId)).toEqual([
      encerradaDaBia.id,
    ]);
  });

  it('conversa ATIVA de outra atendente continua 404 (detalhe e envio)', async () => {
    const { ana, ativaDaBia } = await scenario();
    await app.agent.get(`/api/v1/conversations/${ativaDaBia.id}`).set(app.auth(ana)).expect(404);
    await app.agent
      .post(`/api/v1/conversations/${ativaDaBia.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'oi' })
      .expect(404);
  });

  it('responder a encerrada de outra atendente reabre e passa para quem enviou', async () => {
    const { ana, bia, encerradaDaBia } = await scenario();

    const response = await app.agent
      .post(`/api/v1/conversations/${encerradaDaBia.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'Oi, voltei com o seu resultado' })
      .expect(201);
    expect(response.body.senderId).toBe(ana.id);

    const row = await readConversationRow(encerradaDaBia.id);
    expect(row?.status).toBe('active');
    expect(row?.assigned_to).toBe(ana.id);

    // Evento de sistema "reaberto por Ana" antes da mensagem, e audit log.
    const detalhe = await app.agent
      .get(`/api/v1/conversations/${encerradaDaBia.id}`)
      .set(app.auth(ana))
      .expect(200);
    const contents = detalhe.body.messages.map((m: { content: string }) => m.content);
    expect(contents.slice(-2)).toEqual([
      'Atendimento reaberto por Ana',
      'Oi, voltei com o seu resultado',
    ]);
    const db = await getTestDb();
    const audit = await db.withoutTenant((tx) =>
      tx.query<{ action: string; old_values: { assignedTo: string } }>(
        `SELECT action, old_values FROM audit_logs
         WHERE entity_id = $1 AND action = 'update_conversation_status'`,
        [encerradaDaBia.id],
      ),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.old_values.assignedTo).toBe(bia.id);

    // Saiu das encerradas e entrou nas "Minhas" da Ana; a Bia deixa de ver.
    const minhas = await app.agent
      .get('/api/v1/conversations?status=active&scope=mine')
      .set(app.auth(ana))
      .expect(200);
    expect(minhas.body.conversations.map((c: { id: string }) => c.id)).toEqual([encerradaDaBia.id]);
    const encerradas = await app.agent
      .get('/api/v1/conversations?status=closed')
      .set(app.auth(ana))
      .expect(200);
    expect(encerradas.body.conversations).toHaveLength(0);
    await app.agent.get(`/api/v1/conversations/${encerradaDaBia.id}`).set(app.auth(bia)).expect(404);
  });

  it('anexo numa encerrada de outra atendente tambem reabre para quem enviou', async () => {
    const { ana, encerradaDaBia } = await scenario();
    const contentBase64 = Buffer.from('foto do pedido medico').toString('base64');

    await app.agent
      .post(`/api/v1/conversations/${encerradaDaBia.id}/attachments`)
      .set(app.auth(ana))
      .send({ fileName: 'pedido.jpg', mimeType: 'image/jpeg', contentBase64 })
      .expect(201);

    const row = await readConversationRow(encerradaDaBia.id);
    expect(row?.status).toBe('active');
    expect(row?.assigned_to).toBe(ana.id);
  });

  it('encerrada alheia e so leitura no resto: etiquetar -> FORBIDDEN, encerrar/reativar -> FORBIDDEN', async () => {
    const { ana, encerradaDaBia } = await scenario();
    await app.agent
      .patch(`/api/v1/conversations/${encerradaDaBia.id}`)
      .set(app.auth(ana))
      .send({ tags: ['vip'] })
      .expect(403);
    await app.agent
      .patch(`/api/v1/conversations/${encerradaDaBia.id}`)
      .set(app.auth(ana))
      .send({ status: 'active' })
      .expect(403);
    expect((await readConversationRow(encerradaDaBia.id))?.status).toBe('closed');
  });
  it('?status=closed&unread=true: lista e total seguem o count (encerrada alheia fora)', async () => {
    const { ana, encerradaDaBia } = await scenario();
    await setUnreadCount(encerradaDaBia.id, 2);

    const res = await app.agent
      .get('/api/v1/conversations?status=closed&unread=true')
      .set(app.auth(ana))
      .expect(200);
    expect(res.body.conversations).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
    expect(res.body.counts.unread).toBe(0);
  });

  it('so ler a encerrada alheia nao mexe na leitura da dona; pin e nao lida -> FORBIDDEN', async () => {
    const { ana, encerradaDaBia } = await scenario();
    await setUnreadCount(encerradaDaBia.id, 1);

    await app.agent.get(`/api/v1/conversations/${encerradaDaBia.id}`).set(app.auth(ana)).expect(200);
    expect((await readConversationRow(encerradaDaBia.id))?.unread_count).toBe(1);

    const pin = await app.agent
      .post(`/api/v1/conversations/${encerradaDaBia.id}/pin`)
      .set(app.auth(ana))
      .expect(403);
    expect(pin.body.error.code).toBe('FORBIDDEN');
    await app.agent
      .post(`/api/v1/conversations/${encerradaDaBia.id}/unread`)
      .set(app.auth(ana))
      .expect(403);
  });

  it('anexo recusado (MIME proibido) numa encerrada alheia nao reabre nem troca a dona', async () => {
    const { ana, bia, encerradaDaBia } = await scenario();

    const res = await app.agent
      .post(`/api/v1/conversations/${encerradaDaBia.id}/attachments`)
      .set(app.auth(ana))
      .send({
        fileName: 'virus.exe',
        mimeType: 'application/x-msdownload',
        contentBase64: Buffer.from('MZ').toString('base64'),
      })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    const row = await readConversationRow(encerradaDaBia.id);
    expect(row?.status).toBe('closed');
    expect(row?.assigned_to).toBe(bia.id);
  });

  it('citacao invalida numa encerrada alheia: 404 e a conversa continua encerrada', async () => {
    const { ana, bia, encerradaDaBia } = await scenario();
    await app.agent
      .post(`/api/v1/conversations/${encerradaDaBia.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'oi', quotedMessageId: '00000000-0000-4000-8000-000000000000' })
      .expect(404);
    const row = await readConversationRow(encerradaDaBia.id);
    expect(row?.status).toBe('closed');
    expect(row?.assigned_to).toBe(bia.id);
  });
});
