/**
 * Confirmacao de leitura do chat interno — CRMLAB-123 (D-300, D-301).
 *
 * "Lida" e derivado de `channel_reads` (sem tabela por mensagem): o GET das
 * mensagens devolve `readState` por canal e a tela compara `createdAt`.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  internalMessageReadStatus,
  internalMessageReaders,
  type Channel,
  type InternalMessage,
  type ListChannelsResponse,
  type ListInternalMessagesResponse,
} from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { internalChatModule } from '../../src/controllers/internal-chat.routes.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

type User = Parameters<TestApp['auth']>[0];

describe('chat interno — confirmacao de leitura (CRMLAB-123)', () => {
  let db: DbClient;
  let app: TestApp;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    app = await createTestApp({ db, modules: [internalChatModule] });
  });

  async function openDm(from: User, to: { id: string }): Promise<Channel> {
    const response = await app.agent
      .post('/api/v1/internal-chat/dms')
      .set(app.auth(from))
      .send({ userId: to.id })
      .expect(200);
    return response.body as Channel;
  }

  async function geralOf(user: User): Promise<Channel> {
    const response = await app.agent
      .get('/api/v1/internal-chat/channels')
      .set(app.auth(user))
      .expect(200);
    const geral = (response.body as ListChannelsResponse).channels.find((c) => c.key === 'geral');
    if (!geral) throw new Error('#geral ausente');
    return geral;
  }

  async function send(user: User, channelId: string, content: string): Promise<InternalMessage> {
    const response = await app.agent
      .post(`/api/v1/internal-chat/channels/${channelId}/messages`)
      .set(app.auth(user))
      .send({ content })
      .expect(201);
    return response.body as InternalMessage;
  }

  async function read(user: User, channelId: string): Promise<void> {
    await app.agent
      .post(`/api/v1/internal-chat/channels/${channelId}/read`)
      .set(app.auth(user))
      .expect(204);
  }

  async function listAs(user: User, channelId: string): Promise<ListInternalMessagesResponse> {
    const response = await app.agent
      .get(`/api/v1/internal-chat/channels/${channelId}/messages`)
      .set(app.auth(user))
      .expect(200);
    return response.body as ListInternalMessagesResponse;
  }

  async function statusOf(user: User, channelId: string, messageId: string): Promise<string> {
    const body = await listAs(user, channelId);
    const message = body.messages.find((m) => m.id === messageId);
    if (!message) throw new Error('mensagem ausente');
    return internalMessageReadStatus(message, body.readState);
  }

  describe('DM', () => {
    it('A envia, B nao abriu: ✓; B abre: ✓✓ e A recebe o evento', async () => {
      const tenant = await createTenant();
      const a = await createUser({ tenantId: tenant.id, name: 'Ana' });
      const b = await createUser({ tenantId: tenant.id, name: 'Bruno' });
      const dm = await openDm(a, b);
      const message = await send(a, dm.id, 'oi');

      const before = await listAs(a, dm.id);
      expect(before.readState).toEqual({
        readUpTo: null,
        readers: [{ userId: b.id, name: 'Bruno', readUpTo: null, lastReadAt: null }],
      });
      expect(await statusOf(a, dm.id, message.id)).toBe('sent');

      await read(b, dm.id);

      expect(await statusOf(a, dm.id, message.id)).toBe('read');
      const after = await listAs(a, dm.id);
      expect(after.readState?.readUpTo).toBe(message.createdAt);
      expect(after.readState?.readers[0]?.lastReadAt).not.toBeNull();

      // Evento so para o outro participante da DM, so ids.
      const events = app.wsHub.eventsFor(tenant.id, 'internal_chat.channel_read');
      expect(events).toHaveLength(1);
      expect(events[0]?.userId).toBe(a.id);
      expect(events[0]?.data).toEqual({ channelId: dm.id, userId: b.id });
    });

    it('mensagem enviada DEPOIS da leitura volta a ser ✓', async () => {
      const tenant = await createTenant();
      const a = await createUser({ tenantId: tenant.id });
      const b = await createUser({ tenantId: tenant.id });
      const dm = await openDm(a, b);
      const first = await send(a, dm.id, 'primeira');
      await read(b, dm.id);
      const second = await send(a, dm.id, 'segunda');

      expect(await statusOf(a, dm.id, first.id)).toBe('read');
      expect(await statusOf(a, dm.id, second.id)).toBe('sent');
    });

    it('reabrir sem mensagem nova de outra pessoa nao gera evento', async () => {
      const tenant = await createTenant();
      const a = await createUser({ tenantId: tenant.id });
      const b = await createUser({ tenantId: tenant.id });
      const dm = await openDm(a, b);
      await send(a, dm.id, 'oi');
      await read(b, dm.id);
      await read(b, dm.id);
      // A propria mensagem de B tambem nao conta.
      await send(b, dm.id, 'resposta');
      await read(b, dm.id);

      expect(app.wsHub.eventsFor(tenant.id, 'internal_chat.channel_read')).toHaveLength(1);
    });

    it('editada continua lida; apagada nao sai no evento, mas a leitura segue valendo', async () => {
      const tenant = await createTenant();
      const a = await createUser({ tenantId: tenant.id });
      const b = await createUser({ tenantId: tenant.id });
      const dm = await openDm(a, b);
      const edited = await send(a, dm.id, 'texto errado');
      await app.agent
        .patch(`/api/v1/internal-chat/channels/${dm.id}/messages/${edited.id}`)
        .set(app.auth(a))
        .send({ content: 'texto certo' })
        .expect(200);
      await read(b, dm.id);
      // Editar depois de lida nao "desle" (o horario de referencia e o createdAt).
      expect(await statusOf(a, dm.id, edited.id)).toBe('read');

      const deleted = await send(a, dm.id, 'ops');
      await app.agent
        .delete(`/api/v1/internal-chat/channels/${dm.id}/messages/${deleted.id}`)
        .set(app.auth(a))
        .expect(204);
      await read(b, dm.id);
      // So a apagada era nova: sem evento (ninguem tem ✓✓ a ganhar).
      expect(app.wsHub.eventsFor(tenant.id, 'internal_chat.channel_read')).toHaveLength(1);
    });
  });

  describe('canal', () => {
    it('✓✓ so depois de TODOS os membros ativos lerem; inativo nao trava', async () => {
      const tenant = await createTenant();
      const a = await createUser({ tenantId: tenant.id, name: 'Ana' });
      const b = await createUser({ tenantId: tenant.id, name: 'Bruno' });
      const c = await createUser({ tenantId: tenant.id, name: 'Carla' });
      await createUser({ tenantId: tenant.id, name: 'Inativa', isActive: false });
      await createUser({ tenantId: tenant.id, name: 'Operador', role: 'platform_operator' });
      const geral = await geralOf(a);
      const message = await send(a, geral.id, 'bom dia');

      await read(b, geral.id);
      expect(await statusOf(a, geral.id, message.id)).toBe('sent');
      const partial = await listAs(a, geral.id);
      const split = internalMessageReaders(message, partial.readState);
      expect(split.read.map((r) => r.name)).toEqual(['Bruno']);
      expect(split.unread.map((r) => r.name)).toEqual(['Carla']);
      // Membros: ativos do tenant, sem quem pergunta, sem inativo e sem operador.
      expect(partial.readState?.readers.map((r) => r.name)).toEqual(['Bruno', 'Carla']);

      await read(c, geral.id);
      expect(await statusOf(a, geral.id, message.id)).toBe('read');

      // Canal: evento para o tenant inteiro, uma vez por leitura que avancou.
      const events = app.wsHub.eventsFor(tenant.id, 'internal_chat.channel_read');
      expect(events.map((e) => e.userId)).toEqual([null, null]);
      expect(events.map((e) => (e.data as { userId: string }).userId)).toEqual([b.id, c.id]);
    });

    it('"todos leram ate" e o MENOR entre os membros', async () => {
      const tenant = await createTenant();
      const a = await createUser({ tenantId: tenant.id });
      const b = await createUser({ tenantId: tenant.id });
      const c = await createUser({ tenantId: tenant.id });
      const geral = await geralOf(a);
      const first = await send(a, geral.id, 'um');
      await read(b, geral.id);
      await read(c, geral.id);
      const second = await send(a, geral.id, 'dois');
      await read(c, geral.id);

      const body = await listAs(a, geral.id);
      expect(body.readState?.readUpTo).toBe(first.createdAt);
      expect(internalMessageReadStatus(first, body.readState)).toBe('read');
      expect(internalMessageReadStatus(second, body.readState)).toBe('sent');
    });

    it('isolamento: membro e leitura de outro tenant nunca entram', async () => {
      const t1 = await createTenant();
      const t2 = await createTenant();
      const a = await createUser({ tenantId: t1.id, name: 'Ana' });
      const b = await createUser({ tenantId: t1.id, name: 'Bruno' });
      const x = await createUser({ tenantId: t2.id, name: 'Xavier' });
      const geral = await geralOf(a);
      await geralOf(x);
      const message = await send(a, geral.id, 'so do tenant 1');

      // Ler o canal de outro tenant pelo id -> 404 e nada muda.
      await app.agent
        .post(`/api/v1/internal-chat/channels/${geral.id}/read`)
        .set(app.auth(x))
        .expect(404);

      const body = await listAs(a, geral.id);
      expect(body.readState?.readers.map((r) => r.name)).toEqual(['Bruno']);
      expect(internalMessageReadStatus(message, body.readState)).toBe('sent');
      expect(app.wsHub.eventsFor(t2.id, 'internal_chat.channel_read')).toHaveLength(0);

      await read(b, geral.id);
      expect(await statusOf(a, geral.id, message.id)).toBe('read');
    });

    it('canal sem outro membro nunca mostra ✓✓', async () => {
      const tenant = await createTenant();
      const a = await createUser({ tenantId: tenant.id });
      const geral = await geralOf(a);
      const message = await send(a, geral.id, 'sozinha');
      const body = await listAs(a, geral.id);
      expect(body.readState).toEqual({ readUpTo: null, readers: [] });
      expect(internalMessageReadStatus(message, body.readState)).toBe('sent');
    });
  });
});
