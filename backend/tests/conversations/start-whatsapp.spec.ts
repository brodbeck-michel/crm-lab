/**
 * POST /conversations/whatsapp — botao "Nova conversa" (CRMLAB-50, D-175/D-176).
 *
 * O que os testes fixam: numero novo cria conversa + paciente e envia pelo
 * canal; numero conhecido NUNCA duplica (nem digitado com mascara, nem no JID
 * antigo sem o nono digito); o recorte por tenant e por atendente vale aqui
 * tambem; e falha do canal deixa a conversa criada com `conversationId` no 502.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { normalizeBrazilianPhone } from '@crm-lab/shared';
import { makeConversationModule } from '../../src/controllers/conversation.routes.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import {
  ConversationRepository,
  phoneMatchKeys,
} from '../../src/repositories/conversation.repository.js';
import {
  MockWhatsAppDriver,
  WhatsAppService,
  type WhatsAppDriver,
} from '../../src/services/whatsapp.service.js';
import { testCredentialsResolver } from '../whatsapp/fixtures.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { countConversations, countMessages } from './helpers.js';

/** Mock que ecoa, ou falha sempre quando `failing` esta ligado. */
class SwitchableDriver implements WhatsAppDriver {
  readonly name = 'switchable';
  readonly mock = new MockWhatsAppDriver();
  failing = false;

  async send(...args: Parameters<MockWhatsAppDriver['send']>): Promise<{ externalId: string }> {
    if (this.failing) throw new Error('canal sem credencial');
    return this.mock.send(...args);
  }

  async sendMedia(
    ...args: Parameters<MockWhatsAppDriver['sendMedia']>
  ): Promise<{ externalId: string }> {
    return this.mock.sendMedia(...args);
  }
}

const URL = '/api/v1/conversations/whatsapp';

async function countPatients(app: TestApp, tenantId: string): Promise<number> {
  const result = await app.db.withoutTenant((tx) =>
    tx.query<{ total: number }>(
      'SELECT COUNT(*)::int AS total FROM patients WHERE tenant_id = $1',
      [tenantId],
    ),
  );
  return Number(result.rows[0]?.total ?? 0);
}

async function auditActions(app: TestApp, entityId: string): Promise<string[]> {
  const result = await app.db.withoutTenant((tx) =>
    tx.query<{ action: string }>(
      'SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY timestamp ASC',
      [entityId],
    ),
  );
  return result.rows.map((row) => row.action);
}

describe('normalizeBrazilianPhone (D-175)', () => {
  it.each([
    ['(48) 99999-1234', '+5548999991234'],
    ['48999991234', '+5548999991234'],
    ['+55 48 99999-1234', '+5548999991234'],
    ['(48) 3222-1234', '+554832221234'],
    ['5548999991234', '+5548999991234'],
    ['(55) 99999-1234', '+5555999991234'],
  ])('aceita %s -> %s', (input, expected) => {
    expect(normalizeBrazilianPhone(input)).toBe(expected);
  });

  it.each([
    ['99999-1234'], // sem DDD
    ['(48) 89999-1234'], // 9 digitos sem comecar por 9
    ['(01) 99999-1234'], // DDD com zero
    ['(48) 1222-1234'], // fixo comecando por 1
    ['+1 415 555 2671'], // fora do Brasil
    [''],
  ])('recusa %s', (input) => {
    expect(normalizeBrazilianPhone(input)).toBeNull();
  });
});

describe('phoneMatchKeys (D-176)', () => {
  it('celular com o nono digito tambem procura a forma antiga, e vice-versa', () => {
    expect(phoneMatchKeys('+5548999991234')).toEqual(['5548999991234', '554899991234']);
    expect(phoneMatchKeys('554899991234')).toEqual(['554899991234', '5548999991234']);
  });

  it('fixo nao ganha variante', () => {
    expect(phoneMatchKeys('+554832221234')).toEqual(['554832221234']);
  });
});

describe('POST /conversations/whatsapp', () => {
  let app: TestApp;
  const driver = new SwitchableDriver();

  beforeAll(async () => {
    const db = await getTestDb();
    const whatsapp = new WhatsAppService({
      credentials: testCredentialsResolver(new Map()),
      driver,
      queue: createInMemoryQueue({ sleep: async () => undefined, defaults: { backoffMs: 1 } }),
      attempts: 1,
    });
    app = await createTestApp({ db, modules: [makeConversationModule({ whatsapp })] });
  });

  beforeEach(async () => {
    await resetDatabase();
    app.wsHub.clear();
    driver.failing = false;
    driver.mock.clear();
  });

  it('numero novo: cria conversa whatsapp atribuida a quem enviou, com paciente sem nome, e envia', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });

    const response = await app.agent
      .post(URL)
      .set(app.auth(ana))
      .send({ phone: '(48) 99999-1234', content: 'Olá! Aqui é do laboratório.' })
      .expect(201);

    expect(response.body.conversation).toMatchObject({
      patientPhone: '+5548999991234',
      patientName: null,
      channel: 'whatsapp',
      status: 'active',
      assignedTo: ana.id,
      lastMessagePreview: 'Olá! Aqui é do laboratório.',
    });
    expect(response.body.conversation.patientId).not.toBeNull();
    expect(response.body.message).toMatchObject({
      conversationId: response.body.conversation.id,
      senderType: 'agent',
      senderId: ana.id,
      content: 'Olá! Aqui é do laboratório.',
      status: 'sent',
    });

    expect(driver.mock.sent).toHaveLength(1);
    expect(driver.mock.sent[0]).toMatchObject({
      tenantId: tenant.id,
      phone: '+5548999991234',
      content: 'Olá! Aqui é do laboratório.',
    });
    expect(await countPatients(app, tenant.id)).toBe(1);
    expect(await auditActions(app, response.body.conversation.id)).toContain('create_conversation');
  });

  it('numero que ja tem conversa: reaproveita a conversa e o paciente, sem duplicar', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const existing = await createConversation({
      tenantId: tenant.id,
      assignedTo: ana.id,
      patientPhone: '5548999991234',
      patientName: 'Joana Webhook',
    });

    const response = await app.agent
      .post(URL)
      .set(app.auth(ana))
      .send({ phone: '(48) 99999-1234', content: 'Oi, Joana!' })
      .expect(201);

    expect(response.body.conversation.id).toBe(existing.id);
    expect(response.body.conversation.patientName).toBe('Joana Webhook');
    expect(await countConversations(tenant.id)).toBe(1);
    expect(await countPatients(app, tenant.id)).toBe(1);
    // O telefone de envio e o da conversa, nao o digitado.
    expect(driver.mock.sent[0]?.phone).toBe('5548999991234');
  });

  it('D-176: reconhece a conversa gravada no JID antigo, sem o nono digito', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const existing = await createConversation({
      tenantId: tenant.id,
      assignedTo: null,
      patientPhone: '554899991234',
    });

    const response = await app.agent
      .post(URL)
      .set(app.auth(ana))
      .send({ phone: '48 99999-1234', content: 'Bom dia' })
      .expect(201);

    expect(response.body.conversation.id).toBe(existing.id);
    // Fila livre continua livre: enviar nao assume.
    expect(response.body.conversation.assignedTo).toBeNull();
    expect(await countConversations(tenant.id)).toBe(1);
  });

  it('D-176: a resposta do paciente pelo JID antigo cai na conversa aberta pela Nova conversa', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const started = await app.agent
      .post(URL)
      .set(app.auth(ana))
      .send({ phone: '(48) 99999-1234', content: 'Oi' })
      .expect(201);

    // O webhook grava o telefone do JID: `554899991234@s.whatsapp.net`.
    const reply = await new ConversationRepository(app.db).findOrCreateByPhone(tenant.id, {
      patientPhone: '554899991234',
      channel: 'whatsapp',
    });

    expect(reply.created).toBe(false);
    expect(reply.conversation.id).toBe(started.body.conversation.id);
    expect(await countPatients(app, tenant.id)).toBe(1);
  });

  it('telefone invalido devolve VALIDATION_ERROR em fields.phone e nao cria nada', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });

    for (const phone of ['99999', '(48) 89999-1234', '(01) 99999-1234']) {
      const response = await app.agent
        .post(URL)
        .set(app.auth(ana))
        .send({ phone, content: 'Oi' })
        .expect(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details.fields).toHaveProperty('phone');
    }
    expect(await countConversations(tenant.id)).toBe(0);
    expect(driver.mock.sent).toHaveLength(0);
  });

  it('mensagem vazia devolve VALIDATION_ERROR', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });

    const response = await app.agent
      .post(URL)
      .set(app.auth(ana))
      .send({ phone: '(48) 99999-1234', content: '   ' })
      .expect(400);
    expect(response.body.error.details.fields).toHaveProperty('content');
  });

  it('isolamento: conversa do mesmo numero em OUTRO tenant nao e tocada nem reaproveitada', async () => {
    const other = await createTenant();
    const otherAttendant = await createUser({ tenantId: other.id, role: 'attendant' });
    const foreign = await createConversation({
      tenantId: other.id,
      assignedTo: otherAttendant.id,
      patientPhone: '+5548999991234',
    });

    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });

    const response = await app.agent
      .post(URL)
      .set(app.auth(ana))
      .send({ phone: '(48) 99999-1234', content: 'Oi' })
      .expect(201);

    expect(response.body.conversation.id).not.toBe(foreign.id);
    expect(response.body.conversation.assignedTo).toBe(ana.id);
    expect(await countMessages(other.id)).toBe(0);
    expect(await countConversations(tenant.id)).toBe(1);
    expect(driver.mock.sent[0]?.tenantId).toBe(tenant.id);
  });

  it('conversa ativa de OUTRO atendente devolve 409 com o dono e nao envia', async () => {
    const tenant = await createTenant();
    const owner = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Bia' });
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    await createConversation({
      tenantId: tenant.id,
      assignedTo: owner.id,
      patientPhone: '+5548999991234',
    });

    const response = await app.agent
      .post(URL)
      .set(app.auth(ana))
      .send({ phone: '(48) 99999-1234', content: 'Oi' })
      .expect(409);

    expect(response.body.error.code).toBe('CONVERSATION_ALREADY_ASSIGNED');
    expect(response.body.error.details).toMatchObject({
      assignedTo: owner.id,
      assignedToName: 'Bia',
    });
    expect(driver.mock.sent).toHaveLength(0);
    expect(await countMessages(tenant.id)).toBe(0);
  });

  it('gestor envia mesmo em conversa de outro atendente (enxerga todas)', async () => {
    const tenant = await createTenant();
    const owner = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const manager = await createUser({ tenantId: tenant.id, role: 'manager' });
    const existing = await createConversation({
      tenantId: tenant.id,
      assignedTo: owner.id,
      patientPhone: '+5548999991234',
    });

    const response = await app.agent
      .post(URL)
      .set(app.auth(manager))
      .send({ phone: '(48) 99999-1234', content: 'Oi' })
      .expect(201);

    expect(response.body.conversation.id).toBe(existing.id);
    expect(response.body.conversation.assignedTo).toBe(owner.id);
  });

  it('D-174: conversa encerrada reabre para quem enviou e a mensagem sai', async () => {
    const tenant = await createTenant();
    const owner = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    const closed = await createConversation({
      tenantId: tenant.id,
      assignedTo: owner.id,
      patientPhone: '+5548999991234',
      status: 'closed',
    });

    const response = await app.agent
      .post(URL)
      .set(app.auth(ana))
      .send({ phone: '(48) 99999-1234', content: 'Voltando a falar' })
      .expect(201);

    expect(response.body.conversation).toMatchObject({
      id: closed.id,
      status: 'active',
      assignedTo: ana.id,
    });
    expect(driver.mock.sent).toHaveLength(1);
  });

  it('conversa manual (direct) passa a whatsapp para a mensagem sair pelo canal', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const manual = await createConversation({
      tenantId: tenant.id,
      assignedTo: ana.id,
      patientPhone: '+5548999991234',
      channel: 'direct',
    });

    const response = await app.agent
      .post(URL)
      .set(app.auth(ana))
      .send({ phone: '(48) 99999-1234', content: 'Oi pelo WhatsApp' })
      .expect(201);

    expect(response.body.conversation).toMatchObject({ id: manual.id, channel: 'whatsapp' });
    expect(driver.mock.sent).toHaveLength(1);
    expect(await auditActions(app, manual.id)).toContain('update_conversation_channel');
  });

  it('canal fora do ar: 502 com conversationId, conversa criada e mensagem failed', async () => {
    driver.failing = true;
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });

    const response = await app.agent
      .post(URL)
      .set(app.auth(ana))
      .send({ phone: '(48) 99999-1234', content: 'Oi' })
      .expect(502);

    expect(response.body.error.code).toBe('MESSAGE_SEND_FAILED');
    const { conversationId, messageId } = response.body.error.details as {
      conversationId: string;
      messageId: string;
    };
    expect(conversationId).toEqual(expect.any(String));

    const detail = await app.agent
      .get(`/api/v1/conversations/${conversationId}`)
      .set(app.auth(ana))
      .expect(200);
    const failed = detail.body.messages.find((m: { id: string }) => m.id === messageId);
    expect(failed).toMatchObject({ status: 'failed', content: 'Oi' });
  });
});
