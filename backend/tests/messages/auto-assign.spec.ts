/**
 * Responder assume a conversa da fila livre (CRMLAB-75, D-215).
 *
 * O que os testes protegem:
 *   1. texto e anexo numa conversa sem dona a tornam de quem enviou, com o
 *      mesmo audit `assign_conversation` do botao "Assumir";
 *   2. CORRIDA: duas atendentes respondendo juntas — uma fica com a conversa, a
 *      outra recebe `CONVERSATION_ALREADY_ASSIGNED` e a mensagem dela NAO e
 *      gravada nem sai pelo canal;
 *   3. conversa ja atribuida (a quem envia ou a outra pessoa) nao muda de dona;
 *   4. mensagem automatica, de sistema, do paciente e eco do celular nao
 *      atribuem ninguem.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { conversationModule } from '../../src/controllers/conversation.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { ConversationRepository } from '../../src/repositories/conversation.repository.js';
import { MessageRepository } from '../../src/repositories/message.repository.js';
import { createAuditService } from '../../src/services/audit.service.js';
import { MessageService } from '../../src/services/message.service.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { FakeWsHub } from '../helpers/fake-ws.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { countMessages, readConversationRow } from '../conversations/helpers.js';

async function assignAudits(db: DbClient, conversationId: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ user_id: string | null; old_values: unknown; new_values: unknown }>(
      `SELECT user_id, old_values, new_values FROM audit_logs
       WHERE entity_id = $1 AND action = 'assign_conversation'`,
      [conversationId],
    ),
  );
  return result.rows;
}

describe('POST /conversations/:id/messages — responder assume a fila livre', () => {
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

  it('texto numa conversa sem dona a torna de quem enviou, com audit e WS', async () => {
    const tenant = await createTenant({ db });
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana', db });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: null, db });

    await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'Bom dia! Posso ajudar?' })
      .expect(201);

    expect((await readConversationRow(conversation.id))?.assigned_to).toBe(ana.id);
    const audits = await assignAudits(db, conversation.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      user_id: ana.id,
      old_values: { assignedTo: null },
      new_values: { assignedTo: ana.id },
    });
    // O `new_message` e o que tira a conversa de "Nao atribuidas" nas outras telas.
    expect(app.wsHub.eventsFor(tenant.id, 'conversation.new_message')).toHaveLength(1);

    // E a listagem ja conta a conversa em "Minhas", nao mais na fila.
    const list = await app.agent
      .get('/api/v1/conversations?status=active')
      .set(app.auth(ana))
      .expect(200);
    expect(list.body.counts).toMatchObject({ mine: 1, unassigned: 0 });
  });

  it('CORRIDA: duas atendentes respondendo juntas — uma fica, a outra recebe 409 e nada e gravado', async () => {
    const tenant = await createTenant({ db });
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana', db });
    const bia = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Bia', db });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: null, db });

    const [primeira, segunda] = await Promise.all([
      app.agent
        .post(`/api/v1/conversations/${conversation.id}/messages`)
        .set(app.auth(ana))
        .send({ content: 'da Ana' }),
      app.agent
        .post(`/api/v1/conversations/${conversation.id}/messages`)
        .set(app.auth(bia))
        .send({ content: 'da Bia' }),
    ]);

    // O recorte por papel pode barrar a perdedora antes do claim (404: a
    // conversa ja nao e visivel para ela) ou no claim (409). Nos dois casos, a
    // mensagem dela nao existe.
    const statuses = [primeira.status, segunda.status].sort();
    expect(statuses[0]).toBe(201);
    expect([404, 409]).toContain(statuses[1]);

    const vencedora = primeira.status === 201 ? primeira : segunda;
    const perdedora = primeira.status === 201 ? segunda : primeira;
    const donaEsperada = vencedora === primeira ? ana : bia;

    if (perdedora.status === 409) {
      expect(perdedora.body.error.code).toBe('CONVERSATION_ALREADY_ASSIGNED');
      expect(perdedora.body.error.details.assignedTo).toBe(donaEsperada.id);
      expect(perdedora.body.error.details.assignedToName).toBe(donaEsperada.name);
    }

    expect((await readConversationRow(conversation.id))?.assigned_to).toBe(donaEsperada.id);
    expect(await countMessages(tenant.id)).toBe(1);
    expect(await assignAudits(db, conversation.id)).toHaveLength(1);
  });

  it('conversa ja da propria atendente: nada muda, sem audit novo', async () => {
    const tenant = await createTenant({ db });
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', db });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id, db });

    await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'oi' })
      .expect(201);

    expect((await readConversationRow(conversation.id))?.assigned_to).toBe(ana.id);
    expect(await assignAudits(db, conversation.id)).toHaveLength(0);
  });

  it('gestor escrevendo na conversa de uma atendente NAO transfere', async () => {
    const tenant = await createTenant({ db });
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', db });
    const gestor = await createUser({ tenantId: tenant.id, role: 'manager', db });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id, db });

    await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(gestor))
      .send({ content: 'Complementando a colega' })
      .expect(201);

    expect((await readConversationRow(conversation.id))?.assigned_to).toBe(ana.id);
    expect(await assignAudits(db, conversation.id)).toHaveLength(0);
  });

  it('anexo numa conversa sem dona tambem assume', async () => {
    const tenant = await createTenant({ db });
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', db });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: null, db });

    await app.agent
      .post(`/api/v1/conversations/${conversation.id}/attachments`)
      .set(app.auth(ana))
      .send({
        fileName: 'preparo.pdf',
        mimeType: 'application/pdf',
        contentBase64: Buffer.from('%PDF-1.4 preparo').toString('base64'),
      })
      .expect(201);

    expect((await readConversationRow(conversation.id))?.assigned_to).toBe(ana.id);
    expect(await assignAudits(db, conversation.id)).toHaveLength(1);
  });

  it('gestor anexando na conversa de uma atendente NAO transfere', async () => {
    const tenant = await createTenant({ db });
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', db });
    const gestor = await createUser({ tenantId: tenant.id, role: 'manager', db });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id, db });

    await app.agent
      .post(`/api/v1/conversations/${conversation.id}/attachments`)
      .set(app.auth(gestor))
      .send({
        fileName: 'preparo.pdf',
        mimeType: 'application/pdf',
        contentBase64: Buffer.from('%PDF-1.4 preparo').toString('base64'),
      })
      .expect(201);

    expect((await readConversationRow(conversation.id))?.assigned_to).toBe(ana.id);
    expect(await assignAudits(db, conversation.id)).toHaveLength(0);
  });
});

describe('MessageService — quem assume e quem nao assume', () => {
  let db: DbClient;
  let service: MessageService;
  let conversations: ConversationRepository;
  const sent: string[] = [];

  beforeEach(async () => {
    db = await getTestDb();
    await resetDatabase(db);
    sent.length = 0;
    conversations = new ConversationRepository(db);
    service = new MessageService({
      messages: new MessageRepository(db),
      conversations,
      wsHub: new FakeWsHub(),
      audit: createAuditService(db),
      // So `send` e usado; o resto do WhatsAppService nao entra nestes testes.
      whatsapp: {
        send: async (_tenantId: string, _phone: string, content: string) => {
          sent.push(content);
          return { externalId: `wamid.${sent.length}` };
        },
      } as unknown as NonNullable<ConstructorParameters<typeof MessageService>[0]['whatsapp']>,
    });
  });

  it('perdeu a corrida no claim: 409 com o nome de quem ganhou, nada gravado, nada enviado', async () => {
    const tenant = await createTenant({ db });
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana', db });
    const bia = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Bia', db });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: null, db });

    // A Ana assume ENTRE a leitura da Bia e o UPDATE dela: o repositorio le a
    // conversa ainda livre, mas o claim ja encontra dona.
    const realFindById = conversations.findById.bind(conversations);
    let first = true;
    conversations.findById = async (tenantId, id) => {
      const read = await realFindById(tenantId, id);
      if (first) {
        first = false;
        await conversations.claimIfUnassigned(tenantId, id, ana.id);
      }
      return read;
    };

    await expect(
      service.createFromAgent(tenant.id, conversation.id, bia.id, { content: 'da Bia' }),
    ).rejects.toMatchObject({
      code: 'CONVERSATION_ALREADY_ASSIGNED',
      details: { assignedTo: ana.id, assignedToName: 'Ana' },
    });

    expect(sent).toEqual([]);
    expect(await countMessages(tenant.id)).toBe(0);
    expect((await readConversationRow(conversation.id))?.assigned_to).toBe(ana.id);
  });

  it('claimForAgent (chamado antes de gravar a midia do anexo) recusa quem perdeu', async () => {
    const tenant = await createTenant({ db });
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana', db });
    const bia = await createUser({ tenantId: tenant.id, role: 'attendant', db });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: null, db });

    await service.claimForAgent(tenant.id, conversation.id, ana.id);
    // Ja atribuida: para a Bia nao ha o que assumir, e nao transfere.
    await service.claimForAgent(tenant.id, conversation.id, bia.id);
    expect((await readConversationRow(conversation.id))?.assigned_to).toBe(ana.id);
    expect(await assignAudits(db, conversation.id)).toHaveLength(1);
  });

  it('dois envios da mesma pessoa disputando o claim nao viram conflito', async () => {
    const tenant = await createTenant({ db });
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', db });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: null, db });

    await Promise.all([
      service.createFromAgent(tenant.id, conversation.id, ana.id, { content: 'um' }),
      service.createFromAgent(tenant.id, conversation.id, ana.id, { content: 'dois' }),
    ]);

    expect(sent.sort()).toEqual(['dois', 'um']);
    expect((await readConversationRow(conversation.id))?.assigned_to).toBe(ana.id);
    expect(await assignAudits(db, conversation.id)).toHaveLength(1);
  });

  it('mensagem automatica, de sistema, do paciente e eco do celular nao atribuem', async () => {
    const tenant = await createTenant({ db });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: null, db });

    await service.createAutomated(tenant.id, conversation.id, 'Ainda precisa do orçamento?');
    await service.createSystemEvent(tenant.id, conversation.id, 'Orçamento enviado');
    await service.createFromPatient(tenant.id, conversation.id, {
      content: 'oi',
      externalId: 'in.1',
    });
    await service.createFromPhone(
      tenant.id,
      conversation.id,
      { content: 'do celular', externalId: 'phone.1' },
      { echoChecked: true },
    );

    expect(await countMessages(tenant.id)).toBe(4);
    expect((await readConversationRow(conversation.id))?.assigned_to).toBeNull();
    expect(await assignAudits(db, conversation.id)).toHaveLength(0);
  });
});
