/**
 * Participantes da conversa (CRMLAB-93, D-263).
 *
 * O que os testes protegem:
 *   1. a dona chama uma colega: a participante ve a conversa (mesmo atendente),
 *      ela aparece em "Participando", com mensagem de sistema e audit;
 *   2. quem adiciona: dona, gestor, admin — fila livre e encerrada recusam;
 *   3. com participante, nao encerra nem volta para a fila; transferir para a
 *      participante a torna dona e tira da lista, e a antiga dona sai;
 *   4. sair sozinha e remover outra pessoa, com o texto certo;
 *   5. mensagem de participante sai com `*Nome*` para o paciente, a bolha fica
 *      sem prefixo e `attributed_to` guarda a dona do momento.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { conversationModule } from '../../src/controllers/conversation.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { ConversationRepository } from '../../src/repositories/conversation.repository.js';
import { MessageRepository } from '../../src/repositories/message.repository.js';
import { createAuditService } from '../../src/services/audit.service.js';
import { MessageService, withSenderName } from '../../src/services/message.service.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { FakeWsHub } from '../helpers/fake-ws.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { readConversationRow } from './helpers.js';

async function systemTexts(db: DbClient, conversationId: string): Promise<string[]> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ content: string }>(
      `SELECT content FROM messages WHERE conversation_id = $1 AND sender_type = 'system'
       ORDER BY created_at, id`,
      [conversationId],
    ),
  );
  return result.rows.map((row) => row.content);
}

async function audits(db: DbClient, conversationId: string): Promise<string[]> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE entity_id = $1 AND action LIKE '%participant%'
       ORDER BY timestamp, id`,
      [conversationId],
    ),
  );
  return result.rows.map((row) => row.action);
}

async function participantIds(db: DbClient, conversationId: string): Promise<string[]> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ user_id: string }>(
      'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
      [conversationId],
    ),
  );
  return result.rows.map((row) => row.user_id);
}

describe('participantes da conversa (D-263)', () => {
  let app: TestApp;
  let db: DbClient;

  beforeAll(async () => {
    db = await getTestDb();
    app = await createTestApp({ db, modules: [conversationModule] });
  });

  beforeEach(async () => {
    await resetDatabase(db);
    app.wsHub.clear();
  });

  async function scenario() {
    const tenant = await createTenant({ db });
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana', db });
    const bia = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Bia', db });
    const gestora = await createUser({ tenantId: tenant.id, role: 'manager', name: 'Gestora', db });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id, db });
    return { tenant, ana, bia, gestora, conversation };
  }

  function add(conversationId: string, actor: Parameters<TestApp['auth']>[0], userId: string) {
    return app.agent
      .post(`/api/v1/conversations/${conversationId}/participants`)
      .set(app.auth(actor))
      .send({ userId });
  }

  it('a dona chama uma colega: ela ve a conversa e a encontra em "Participando"', async () => {
    const { tenant, ana, bia, conversation } = await scenario();

    // Antes: conversa de outra atendente e invisivel.
    await app.agent.get(`/api/v1/conversations/${conversation.id}`).set(app.auth(bia)).expect(404);

    const added = await add(conversation.id, ana, bia.id).expect(200);
    expect(added.body.assignedTo).toBe(ana.id);
    expect(added.body.participants).toEqual([{ id: bia.id, name: 'Bia' }]);

    await app.agent.get(`/api/v1/conversations/${conversation.id}`).set(app.auth(bia)).expect(200);

    const list = await app.agent
      .get('/api/v1/conversations?scope=participating&status=active')
      .set(app.auth(bia))
      .expect(200);
    expect(list.body.conversations.map((c: { id: string }) => c.id)).toEqual([conversation.id]);
    expect(list.body.counts.participating).toBe(1);
    expect(list.body.counts.mine).toBe(0);

    expect(await systemTexts(db, conversation.id)).toEqual(['Ana adicionou Bia à conversa']);
    expect(await audits(db, conversation.id)).toEqual(['add_conversation_participant']);
    expect(app.wsHub.eventsFor(tenant.id, 'conversation.new_message')).toHaveLength(1);
  });

  it('adicionar de novo, ou a propria dona, e no-op sem evento', async () => {
    const { ana, bia, conversation } = await scenario();
    await add(conversation.id, ana, bia.id).expect(200);
    await add(conversation.id, ana, bia.id).expect(200);
    const self = await add(conversation.id, ana, ana.id).expect(200);
    expect(self.body.participants).toEqual([{ id: bia.id, name: 'Bia' }]);
    expect(await systemTexts(db, conversation.id)).toHaveLength(1);
  });

  it('quem adiciona: participante atendente nao (403); gestor sim; fila livre e encerrada recusam', async () => {
    const { tenant, ana, bia, gestora, conversation } = await scenario();
    const carla = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Carla', db });

    // Bia nem enxerga ainda: 404.
    await add(conversation.id, bia, carla.id).expect(404);
    await add(conversation.id, ana, bia.id).expect(200);
    // Participante enxerga, mas nao adiciona.
    const forbidden = await add(conversation.id, bia, carla.id).expect(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');
    // Gestor adiciona em conversa de qualquer um.
    await add(conversation.id, gestora, carla.id).expect(200);

    const free = await createConversation({ tenantId: tenant.id, assignedTo: null, db });
    const unassigned = await add(free.id, gestora, bia.id).expect(409);
    expect(unassigned.body.error.details.reason).toBe('unassigned');

    const closed = await createConversation({
      tenantId: tenant.id,
      assignedTo: ana.id,
      status: 'closed',
      db,
    });
    const closedRes = await add(closed.id, ana, bia.id).expect(409);
    expect(closedRes.body.error.details.reason).toBe('closed');
  });

  it('usuario de outro laboratorio ou inexistente e VALIDATION_ERROR', async () => {
    const { ana, conversation } = await scenario();
    const other = await createTenant({ db });
    const stranger = await createUser({ tenantId: other.id, role: 'attendant', db });
    const res = await add(conversation.id, ana, stranger.id).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('com participante nao encerra nem devolve para a fila — nem o gestor', async () => {
    const { ana, bia, gestora, conversation } = await scenario();
    await add(conversation.id, ana, bia.id).expect(200);

    for (const actor of [ana, gestora]) {
      const close = await app.agent
        .patch(`/api/v1/conversations/${conversation.id}`)
        .set(app.auth(actor))
        .send({ status: 'closed' })
        .expect(409);
      expect(close.body.error.details.reason).toBe('has_participants');
    }
    const release = await app.agent
      .patch(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(ana))
      .send({ assignedTo: null })
      .expect(409);
    expect(release.body.error.details.reason).toBe('has_participants');

    const row = await readConversationRow(conversation.id);
    expect(row).toMatchObject({ status: 'active', assigned_to: ana.id });
  });

  it('transferir para a participante: ela vira dona e sai da lista; a antiga dona sai', async () => {
    const { tenant, ana, bia, conversation } = await scenario();
    const carla = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Carla', db });
    await add(conversation.id, ana, bia.id).expect(200);
    await add(conversation.id, ana, carla.id).expect(200);

    await app.agent
      .patch(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(ana))
      .send({ assignedTo: bia.id })
      .expect(200);

    const detail = await app.agent
      .get(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(bia))
      .expect(200);
    expect(detail.body.conversation.assignedTo).toBe(bia.id);
    // A Carla continua; a Ana (antiga dona) nao vira participante.
    expect(detail.body.conversation.participants).toEqual([{ id: carla.id, name: 'Carla' }]);
    await app.agent.get(`/api/v1/conversations/${conversation.id}`).set(app.auth(ana)).expect(404);

    // A nova dona ainda tem participante: precisa transferir de novo antes de encerrar.
    await app.agent
      .patch(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(bia))
      .send({ status: 'closed' })
      .expect(409);
    await app.agent
      .delete(`/api/v1/conversations/${conversation.id}/participants/${carla.id}`)
      .set(app.auth(bia))
      .expect(204);
    await app.agent
      .patch(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(bia))
      .send({ status: 'closed' })
      .expect(200);
  });

  it('a participante sai sozinha e deixa de ver; remover outra pessoa e da dona', async () => {
    const { tenant, ana, bia, conversation } = await scenario();
    const carla = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Carla', db });
    await add(conversation.id, ana, bia.id).expect(200);
    await add(conversation.id, ana, carla.id).expect(200);

    // Participante nao remove a colega.
    await app.agent
      .delete(`/api/v1/conversations/${conversation.id}/participants/${carla.id}`)
      .set(app.auth(bia))
      .expect(403);

    await app.agent
      .delete(`/api/v1/conversations/${conversation.id}/participants/${bia.id}`)
      .set(app.auth(bia))
      .expect(204);
    await app.agent.get(`/api/v1/conversations/${conversation.id}`).set(app.auth(bia)).expect(404);

    await app.agent
      .delete(`/api/v1/conversations/${conversation.id}/participants/${carla.id}`)
      .set(app.auth(ana))
      .expect(204);
    // Quem nao participa: 404.
    await app.agent
      .delete(`/api/v1/conversations/${conversation.id}/participants/${carla.id}`)
      .set(app.auth(ana))
      .expect(404);

    expect(await participantIds(db, conversation.id)).toEqual([]);
    expect(await systemTexts(db, conversation.id)).toEqual([
      'Ana adicionou Bia à conversa',
      'Ana adicionou Carla à conversa',
      'Bia saiu da conversa',
      'Ana removeu Carla da conversa',
    ]);
    expect(await audits(db, conversation.id)).toEqual([
      'add_conversation_participant',
      'add_conversation_participant',
      'remove_conversation_participant',
      'remove_conversation_participant',
    ]);
  });

  it('isolamento: outro laboratorio nao ve nem mexe nos participantes', async () => {
    const { ana, bia, conversation } = await scenario();
    await add(conversation.id, ana, bia.id).expect(200);
    const other = await createTenant({ db });
    const intruder = await createUser({ tenantId: other.id, role: 'admin', db });

    await add(conversation.id, intruder, intruder.id).expect(404);
    await app.agent
      .delete(`/api/v1/conversations/${conversation.id}/participants/${bia.id}`)
      .set(app.auth(intruder))
      .expect(404);
    expect(await participantIds(db, conversation.id)).toEqual([bia.id]);
  });
});

describe('envio de participante (D-263 itens 5 e 6)', () => {
  let db: DbClient;
  let service: MessageService;
  let conversations: ConversationRepository;
  const sent: string[] = [];
  const captions: (string | null)[] = [];

  beforeEach(async () => {
    db = await getTestDb();
    await resetDatabase(db);
    sent.length = 0;
    captions.length = 0;
    conversations = new ConversationRepository(db);
    service = new MessageService({
      messages: new MessageRepository(db),
      conversations,
      wsHub: new FakeWsHub(),
      audit: createAuditService(db),
      whatsapp: {
        send: async (_tenantId: string, _phone: string, content: string) => {
          sent.push(content);
          return { externalId: `wamid.${sent.length}` };
        },
        sendMedia: async (_tenantId: string, _phone: string, media: { caption: string | null }) => {
          captions.push(media.caption);
          return { externalId: `wamid.media.${captions.length}` };
        },
      } as unknown as NonNullable<ConstructorParameters<typeof MessageService>[0]['whatsapp']>,
    });
  });

  async function rowOf(messageId: string) {
    const result = await db.withoutTenant((tx) =>
      tx.query<{ content: string; attributed_to: string | null }>(
        'SELECT content, attributed_to FROM messages WHERE id = $1',
        [messageId],
      ),
    );
    return result.rows[0];
  }

  it('participante: `*Nome*` para o paciente, bolha sem prefixo, tempo para a dona', async () => {
    const tenant = await createTenant({ db });
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana', db });
    const gestora = await createUser({ tenantId: tenant.id, role: 'manager', name: 'Gestora', db });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id, db });
    await conversations.addParticipant(tenant.id, conversation.id, gestora.id, ana.id);

    const fromGestora = await service.createFromAgent(tenant.id, conversation.id, gestora.id, {
      content: 'Consigo o desconto, sim.',
    });
    const fromAna = await service.createFromAgent(tenant.id, conversation.id, ana.id, {
      content: 'Obrigada!',
    });

    expect(sent).toEqual(['*Gestora*\nConsigo o desconto, sim.', 'Obrigada!']);
    expect(await rowOf(fromGestora.id)).toEqual({
      content: 'Consigo o desconto, sim.',
      attributed_to: ana.id,
    });
    expect(await rowOf(fromAna.id)).toEqual({ content: 'Obrigada!', attributed_to: null });
  });

  it('gestor que nao foi adicionado responde como hoje: sem nome, conta para ele', async () => {
    const tenant = await createTenant({ db });
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana', db });
    const gestora = await createUser({ tenantId: tenant.id, role: 'manager', name: 'Gestora', db });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id, db });

    const message = await service.createFromAgent(tenant.id, conversation.id, gestora.id, {
      content: 'Oi',
    });
    expect(sent).toEqual(['Oi']);
    expect((await rowOf(message.id))?.attributed_to).toBeNull();
  });

  it('anexo: o nome vai na legenda (sem legenda, so o nome); audio sai sem nome', async () => {
    const tenant = await createTenant({ db });
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana', db });
    const bia = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Bia', db });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id, db });
    await conversations.addParticipant(tenant.id, conversation.id, bia.id, ana.id);

    const base = { buffer: Buffer.from('x'), attachmentUrl: '/api/v1/media/x' };
    const image = await service.createAttachmentFromAgent(tenant.id, conversation.id, bia.id, {
      ...base,
      fileName: 'pedido.jpg',
      mimeType: 'image/jpeg',
      caption: 'Seu pedido',
    });
    await service.createAttachmentFromAgent(tenant.id, conversation.id, bia.id, {
      ...base,
      fileName: 'guia.pdf',
      mimeType: 'application/pdf',
    });
    await service.createAttachmentFromAgent(tenant.id, conversation.id, bia.id, {
      ...base,
      fileName: 'audio.ogg',
      mimeType: 'audio/ogg',
    });

    expect(captions).toEqual(['*Bia*\nSeu pedido', '*Bia*', null]);
    expect((await rowOf(image.id))?.content).toBe('Seu pedido');
  });

  it('withSenderName tira asterisco do nome', () => {
    expect(withSenderName('Ana *Gestora*', 'oi')).toBe('*Ana Gestora*\noi');
  });
});
