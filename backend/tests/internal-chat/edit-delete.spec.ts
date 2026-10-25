/**
 * Editar e apagar para todos no chat interno (CRMLAB-117, D-282):
 *
 *   PATCH  /internal-chat/channels/:id/messages/:messageId  { content }
 *   DELETE /internal-chat/channels/:id/messages/:messageId
 *
 * Só a autora, mesmos prazos do atendimento (15 min editar, 48 h apagar), sem
 * canal externo: grava direto. Nada é apagado de verdade; a versão anterior
 * fica em `internal_message_edits` e o audit leva o `userId`.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiErrorBody,
  Channel,
  InternalMessage,
  ListChannelsResponse,
  ListInternalMessagesResponse,
} from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { internalChatModule } from '../../src/controllers/internal-chat.routes.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

/** Assinatura PNG — o sniff reconhece como `image/png`. */
const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
  Buffer.alloc(32),
]);

/**
 * Folga de 1 dia nos recuos (mesmo motivo de `messages/edit-delete.spec.ts`):
 * `created_at` é `TIMESTAMP` sem fuso e o PGlite lê no fuso da máquina.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

type User = Parameters<TestApp['auth']>[0];

describe('editar / apagar para todos no chat interno (CRMLAB-117)', () => {
  let db: DbClient;
  let app: TestApp;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    app = await createTestApp({ db, modules: [internalChatModule] });
  });

  async function channelsOf(user: User): Promise<Channel[]> {
    const response = await app.agent
      .get('/api/v1/internal-chat/channels')
      .set(app.auth(user))
      .expect(200);
    return (response.body as ListChannelsResponse).channels;
  }

  async function geralOf(user: User): Promise<Channel> {
    const geral = (await channelsOf(user)).find((c) => c.key === 'geral');
    if (!geral) throw new Error('#geral nao criado');
    return geral;
  }

  async function post(user: User, channelId: string, content: string): Promise<InternalMessage> {
    const response = await app.agent
      .post(`/api/v1/internal-chat/channels/${channelId}/messages`)
      .set(app.auth(user))
      .send({ content })
      .expect(201);
    return response.body as InternalMessage;
  }

  const path = (channelId: string, messageId: string) =>
    `/api/v1/internal-chat/channels/${channelId}/messages/${messageId}`;

  async function scenario() {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    const bia = await createUser({ tenantId: tenant.id, role: 'admin', name: 'Bia' });
    const geral = await geralOf(ana);
    const message = await post(ana, geral.id, 'Reunião às 14h');
    return { tenant, ana, bia, geral, message };
  }

  async function backdate(messageId: string, ms: number): Promise<void> {
    const result = await db.withoutTenant((tx) =>
      tx.query(
        "UPDATE internal_messages SET created_at = now() - $2::int * interval '1 second' WHERE id = $1",
        [messageId, Math.ceil(ms / 1000)],
      ),
    );
    expect(result.rowCount ?? result.rows.length).not.toBe(0);
  }

  async function rawRow(id: string) {
    const result = await db.withoutTenant((tx) =>
      tx.query<{ content: string; edited_at: Date | null; deleted_at: Date | null }>(
        'SELECT content, edited_at, deleted_at FROM internal_messages WHERE id = $1',
        [id],
      ),
    );
    return result.rows[0];
  }

  async function editsOf(messageId: string) {
    const result = await db.withoutTenant((tx) =>
      tx.query<{ previous_content: string; edited_by: string | null }>(
        'SELECT previous_content, edited_by FROM internal_message_edits WHERE message_id = $1',
        [messageId],
      ),
    );
    return result.rows;
  }

  async function auditOf(tenantId: string, action: string) {
    const result = await db.withoutTenant((tx) =>
      tx.query<{
        user_id: string | null;
        entity_type: string;
        entity_id: string;
        old_values: Record<string, unknown> | null;
        new_values: Record<string, unknown> | null;
      }>(
        `SELECT user_id, entity_type, entity_id, old_values, new_values
           FROM audit_logs WHERE tenant_id = $1 AND action = $2`,
        [tenantId, action],
      ),
    );
    return result.rows;
  }

  async function listOf(user: User, channelId: string): Promise<InternalMessage[]> {
    const response = await app.agent
      .get(`/api/v1/internal-chat/channels/${channelId}/messages`)
      .set(app.auth(user))
      .expect(200);
    return (response.body as ListInternalMessagesResponse).messages;
  }

  it('a tabela de versões nasce sob RLS, com policy (migração 058)', async () => {
    const rows = await db.query<{ rowsecurity: boolean; policies: number }>(
      `SELECT t.rowsecurity,
              (SELECT COUNT(*)::int FROM pg_policies p
                WHERE p.schemaname = 'public' AND p.tablename = t.tablename) AS policies
         FROM pg_tables t
        WHERE t.schemaname = 'public' AND t.tablename = 'internal_message_edits'`,
    );
    expect(rows.rows[0]?.rowsecurity).toBe(true);
    expect(rows.rows[0]?.policies).toBeGreaterThan(0);
  });

  describe('editar', () => {
    it('a autora edita: guarda a versão anterior, marca editada, audit com userId e WS', async () => {
      const { tenant, ana, geral, message } = await scenario();
      expect(message.editedAt).toBeNull();
      expect(message.deletedAt).toBeNull();

      const response = await app.agent
        .patch(path(geral.id, message.id))
        .set(app.auth(ana))
        .send({ content: '  Reunião às 15h  ' })
        .expect(200);
      const body = response.body as InternalMessage;

      expect(body.content).toBe('Reunião às 15h');
      expect(body.editedAt).toEqual(expect.any(String));
      expect(await editsOf(message.id)).toEqual([
        { previous_content: 'Reunião às 14h', edited_by: ana.id },
      ]);
      const audit = await auditOf(tenant.id, 'edit_internal_message');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        user_id: ana.id,
        entity_type: 'internal_message',
        entity_id: message.id,
        old_values: { content: 'Reunião às 14h' },
        new_values: expect.objectContaining({ content: 'Reunião às 15h' }),
      });
      expect(app.wsHub.eventsFor(tenant.id, 'internal_chat.message_updated')).toEqual([
        expect.objectContaining({ data: { channelId: geral.id, messageId: message.id } }),
      ]);
      // Não é mensagem nova: só o `new_message` do envio original.
      expect(app.wsHub.eventsFor(tenant.id, 'internal_chat.new_message')).toHaveLength(1);

      const listed = (await listOf(ana, geral.id)).find((m) => m.id === message.id);
      expect(listed).toMatchObject({ content: 'Reunião às 15h', editedAt: expect.any(String) });
    });

    it('mesmo texto: 200 sem versão, sem audit e sem evento', async () => {
      const { tenant, ana, geral, message } = await scenario();
      await app.agent
        .patch(path(geral.id, message.id))
        .set(app.auth(ana))
        .send({ content: 'Reunião às 14h' })
        .expect(200);
      expect(await editsOf(message.id)).toHaveLength(0);
      expect(await auditOf(tenant.id, 'edit_internal_message')).toHaveLength(0);
      expect(app.wsHub.eventsFor(tenant.id, 'internal_chat.message_updated')).toHaveLength(0);
    });

    it('texto vazio: 400 e nada muda', async () => {
      const { ana, geral, message } = await scenario();
      const response = await app.agent
        .patch(path(geral.id, message.id))
        .set(app.auth(ana))
        .send({ content: '   ' })
        .expect(400);
      expect((response.body as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
      expect((await rawRow(message.id))?.content).toBe('Reunião às 14h');
    });

    it('admin não edita mensagem de colega: 403 not_author', async () => {
      const { bia, geral, message } = await scenario();
      const response = await app.agent
        .patch(path(geral.id, message.id))
        .set(app.auth(bia))
        .send({ content: 'Corrigido pela gestão' })
        .expect(403);
      const error = (response.body as ApiErrorBody).error;
      expect(error.code).toBe('FORBIDDEN');
      expect(error.details).toMatchObject({ reason: 'not_author' });
      expect(await editsOf(message.id)).toHaveLength(0);
    });

    it('depois de 15 min: 409 window_expired (apagar ainda vale)', async () => {
      const { ana, geral, message } = await scenario();
      await backdate(message.id, DAY_MS);
      const response = await app.agent
        .patch(path(geral.id, message.id))
        .set(app.auth(ana))
        .send({ content: 'Tarde demais' })
        .expect(409);
      expect((response.body as ApiErrorBody).error.details).toMatchObject({
        reason: 'window_expired',
      });
      await app.agent.delete(path(geral.id, message.id)).set(app.auth(ana)).expect(204);
    });

    it('mensagem com arquivo não edita: 409 not_editable', async () => {
      const { ana, geral } = await scenario();
      const created = await app.agent
        .post(`/api/v1/internal-chat/channels/${geral.id}/attachments`)
        .set(app.auth(ana))
        .send({
          fileName: 'foto.png',
          mimeType: 'image/png',
          contentBase64: PNG.toString('base64'),
          content: 'Legenda',
        })
        .expect(201);
      const withFile = created.body as InternalMessage;
      const response = await app.agent
        .patch(path(geral.id, withFile.id))
        .set(app.auth(ana))
        .send({ content: 'Outra legenda' })
        .expect(409);
      expect((response.body as ApiErrorBody).error.details).toMatchObject({
        reason: 'not_editable',
      });
    });

    it('mensagem de sistema fica de fora: 403 not_author', async () => {
      const { ana, geral } = await scenario();
      const inserted = await db.withoutTenant((tx) =>
        tx.query<{ id: string }>(
          `INSERT INTO internal_messages (tenant_id, channel_id, sender_id, content, is_system)
           SELECT tenant_id, id, NULL, 'Aviso do sistema', TRUE FROM internal_channels WHERE id = $1
           RETURNING id`,
          [geral.id],
        ),
      );
      const systemId = inserted.rows[0]?.id ?? '';
      await app.agent
        .patch(path(geral.id, systemId))
        .set(app.auth(ana))
        .send({ content: 'x' })
        .expect(403);
      await app.agent.delete(path(geral.id, systemId)).set(app.auth(ana)).expect(403);
    });
  });

  describe('apagar para todos', () => {
    it('esconde (nunca apaga), audit com userId e o texto, WS; a API não devolve o conteúdo', async () => {
      const { tenant, ana, bia, geral, message } = await scenario();

      await app.agent.delete(path(geral.id, message.id)).set(app.auth(ana)).expect(204);

      const row = await rawRow(message.id);
      expect(row?.content).toBe('Reunião às 14h');
      expect(row?.deleted_at).not.toBeNull();
      const audit = await auditOf(tenant.id, 'delete_internal_message');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        user_id: ana.id,
        entity_id: message.id,
        old_values: expect.objectContaining({ content: 'Reunião às 14h' }),
      });
      expect(app.wsHub.eventsFor(tenant.id, 'internal_chat.message_updated')).toHaveLength(1);

      const listed = (await listOf(bia, geral.id)).find((m) => m.id === message.id);
      expect(listed).toMatchObject({
        content: '',
        attachment: null,
        attachedProposalId: null,
        deletedAt: expect.any(String),
      });
    });

    it('apagada não conta como não lida', async () => {
      const { ana, bia, geral, message } = await scenario();
      expect((await geralOf(bia)).unreadCount).toBe(1);
      await app.agent.delete(path(geral.id, message.id)).set(app.auth(ana)).expect(204);
      expect((await geralOf(bia)).unreadCount).toBe(0);
    });

    it('anexo de mensagem apagada não sai mais no download', async () => {
      const { ana, geral } = await scenario();
      const created = await app.agent
        .post(`/api/v1/internal-chat/channels/${geral.id}/attachments`)
        .set(app.auth(ana))
        .send({ fileName: 'foto.png', mimeType: 'image/png', contentBase64: PNG.toString('base64') })
        .expect(201);
      const withFile = created.body as InternalMessage;
      const url = withFile.attachment?.url ?? '';
      await app.agent.get(url).set(app.auth(ana)).expect(200);

      await app.agent.delete(path(geral.id, withFile.id)).set(app.auth(ana)).expect(204);
      await app.agent.get(url).set(app.auth(ana)).expect(404);
    });

    it('apagar de novo: 409 already_deleted; editar apagada também', async () => {
      const { ana, geral, message } = await scenario();
      await app.agent.delete(path(geral.id, message.id)).set(app.auth(ana)).expect(204);
      const again = await app.agent.delete(path(geral.id, message.id)).set(app.auth(ana)).expect(409);
      expect((again.body as ApiErrorBody).error.details).toMatchObject({ reason: 'already_deleted' });
      await app.agent
        .patch(path(geral.id, message.id))
        .set(app.auth(ana))
        .send({ content: 'volta' })
        .expect(409);
    });

    it('depois de 48 h: 409 window_expired', async () => {
      const { ana, geral, message } = await scenario();
      await backdate(message.id, 3 * DAY_MS);
      const response = await app.agent.delete(path(geral.id, message.id)).set(app.auth(ana)).expect(409);
      expect((response.body as ApiErrorBody).error.details).toMatchObject({
        reason: 'window_expired',
      });
      expect((await rawRow(message.id))?.deleted_at).toBeNull();
    });

    it('colega não apaga: 403 not_author', async () => {
      const { bia, geral, message } = await scenario();
      const response = await app.agent.delete(path(geral.id, message.id)).set(app.auth(bia)).expect(403);
      expect((response.body as ApiErrorBody).error.details).toMatchObject({ reason: 'not_author' });
    });
  });

  describe('acesso', () => {
    it('outro tenant: 404, nunca 403', async () => {
      const { geral, message } = await scenario();
      const other = await createTenant();
      const intrusa = await createUser({ tenantId: other.id, role: 'admin' });
      const response = await app.agent
        .patch(path(geral.id, message.id))
        .set(app.auth(intrusa))
        .send({ content: 'x' })
        .expect(404);
      expect((response.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
      await app.agent.delete(path(geral.id, message.id)).set(app.auth(intrusa)).expect(404);
    });

    it('mensagem de outro canal pela URL de um canal que vejo: 404', async () => {
      const { ana, message } = await scenario();
      const aprovacoes = (await channelsOf(ana)).find((c) => c.key === 'aprovacoes');
      await app.agent
        .delete(path(aprovacoes?.id ?? '', message.id))
        .set(app.auth(ana))
        .expect(404);
    });

    it('DM alheia: quem não participa recebe 404', async () => {
      const { tenant, ana, bia } = await scenario();
      const cris = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Cris' });
      const dm = await app.agent
        .post('/api/v1/internal-chat/dms')
        .set(app.auth(ana))
        .send({ userId: bia.id })
        .expect(200);
      const dmId = (dm.body as Channel).id;
      const message = await post(ana, dmId, 'Só entre nós');
      await app.agent.delete(path(dmId, message.id)).set(app.auth(cris)).expect(404);
      await app.agent.delete(path(dmId, message.id)).set(app.auth(ana)).expect(204);
    });
  });
});
