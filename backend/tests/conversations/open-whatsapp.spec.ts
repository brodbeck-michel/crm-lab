/**
 * POST /conversations/whatsapp/open — "Conversar" do cartão de contato
 * (CRMLAB-70, D-236 item 7): abre a conversa que JÁ existe com o número, sem
 * enviar mensagem e sem criar nada. Número sem conversa → 404 (a tela cai na
 * Nova conversa). Encerrada reabre para quem pediu (precedente de
 * `POST /conversations` e da Nova conversa, D-174); de outra atendente → 409.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeConversationModule } from '../../src/controllers/conversation.routes.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { countConversations, countMessages } from './helpers.js';

const URL = '/api/v1/conversations/whatsapp/open';
let app: TestApp;

beforeAll(async () => {
  const db = await getTestDb();
  app = await createTestApp({ db, modules: [makeConversationModule()] });
});

beforeEach(async () => {
  await resetDatabase();
  app.wsHub.clear();
});

describe('POST /conversations/whatsapp/open (CRMLAB-70, D-236)', () => {
  it('número com conversa: 200 com a ConversationDetail, sem mensagem nova', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const existing = await createConversation({
      tenantId: tenant.id,
      assignedTo: ana.id,
      patientPhone: '+5548988887777',
    });

    const response = await app.agent
      .post(URL)
      .set(app.auth(ana))
      .send({ phone: '(48) 98888-7777' })
      .expect(200);

    expect(response.body.id).toBe(existing.id);
    expect(response.body).toHaveProperty('customFields');
    expect(await countMessages(tenant.id)).toBe(0);
  });

  it('reconhece o número sem o nono dígito (D-176)', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const existing = await createConversation({
      tenantId: tenant.id,
      assignedTo: ana.id,
      patientPhone: '554888887777',
    });
    const response = await app.agent
      .post(URL)
      .set(app.auth(ana))
      .send({ phone: '+5548988887777' })
      .expect(200);
    expect(response.body.id).toBe(existing.id);
  });

  it('número sem conversa: 404 e nada é criado', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const response = await app.agent
      .post(URL)
      .set(app.auth(ana))
      .send({ phone: '(48) 98888-7777' })
      .expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(await countConversations(tenant.id)).toBe(0);
  });

  it('número que só tem conversa em OUTRO laboratório: 404 (isolamento)', async () => {
    const other = await createTenant();
    await createConversation({ tenantId: other.id, patientPhone: '+5548988887777' });
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });

    const response = await app.agent
      .post(URL)
      .set(app.auth(ana))
      .send({ phone: '+5548988887777' })
      .expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(response.body)).not.toContain(other.id);
  });

  it('encerrada reabre atribuída a quem clicou, com evento e audit', async () => {
    const tenant = await createTenant();
    const bia = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    const closed = await createConversation({
      tenantId: tenant.id,
      assignedTo: bia.id,
      status: 'closed',
      patientPhone: '+5548988887777',
    });

    const response = await app.agent
      .post(URL)
      .set(app.auth(ana))
      .send({ phone: '+5548988887777' })
      .expect(200);

    expect(response.body.id).toBe(closed.id);
    expect(response.body.status).toBe('active');
    expect(response.body.assignedTo).toBe(ana.id);
    const events = await app.db.withoutTenant((tx) =>
      tx.query<{ content: string }>(
        `SELECT content FROM messages WHERE conversation_id = $1 AND sender_type = 'system'`,
        [closed.id],
      ),
    );
    expect(events.rows.map((row) => row.content)).toEqual(['Atendimento reaberto por Ana']);
    const audits = await app.db.withoutTenant((tx) =>
      tx.query<{ action: string }>('SELECT action FROM audit_logs WHERE entity_id = $1', [closed.id]),
    );
    expect(audits.rows.map((row) => row.action)).toContain('update_conversation_status');
  });

  it('ativa de outra atendente: 409 com o nome, sem mudar de dona', async () => {
    const tenant = await createTenant();
    const bia = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Bia' });
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const hers = await createConversation({
      tenantId: tenant.id,
      assignedTo: bia.id,
      patientPhone: '+5548988887777',
    });

    const response = await app.agent
      .post(URL)
      .set(app.auth(ana))
      .send({ phone: '+5548988887777' })
      .expect(409);
    expect(response.body.error.code).toBe('CONVERSATION_ALREADY_ASSIGNED');
    expect(response.body.error.details.assignedToName).toBe('Bia');

    const row = await app.db.withoutTenant((tx) =>
      tx.query<{ assigned_to: string }>('SELECT assigned_to FROM conversations WHERE id = $1', [hers.id]),
    );
    expect(row.rows[0]?.assigned_to).toBe(bia.id);
  });

  it('gestor vê a de outra atendente: 200', async () => {
    const tenant = await createTenant();
    const bia = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const gestor = await createUser({ tenantId: tenant.id, role: 'manager' });
    const hers = await createConversation({
      tenantId: tenant.id,
      assignedTo: bia.id,
      patientPhone: '+5548988887777',
    });
    const response = await app.agent
      .post(URL)
      .set(app.auth(gestor))
      .send({ phone: '+5548988887777' })
      .expect(200);
    expect(response.body.id).toBe(hers.id);
  });

  it('fila livre abre sem mudar de dona', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const free = await createConversation({
      tenantId: tenant.id,
      assignedTo: null,
      patientPhone: '+5548988887777',
    });
    const response = await app.agent
      .post(URL)
      .set(app.auth(ana))
      .send({ phone: '+5548988887777' })
      .expect(200);
    expect(response.body.id).toBe(free.id);
    expect(response.body.assignedTo).toBeNull();
  });

  it('telefone inválido: 400 no campo phone', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const response = await app.agent
      .post(URL)
      .set(app.auth(ana))
      .send({ phone: '+1 415 555 0100' })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});
