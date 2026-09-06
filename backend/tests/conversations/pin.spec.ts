/**
 * POST/DELETE /conversations/:id/pin — fixar conversa (Onda 8 §2.3).
 *
 * O que os testes protegem:
 *   1. o pin e PESSOAL: o que Ana fixa nao aparece fixado para Bruno;
 *   2. e idempotente nos dois sentidos (204, nunca erro);
 *   3. fixada vem PRIMEIRO na listagem, sem mexer nos counts dos chips;
 *   4. conversa de outro tenant e 404, e o RLS nao deixa a linha atravessar.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { conversationModule } from '../../src/controllers/conversation.routes.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

describe('pin de conversa', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ modules: [conversationModule] });
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('fixar e desafixar sao idempotentes — sempre 204', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });

    await app.agent
      .post(`/api/v1/conversations/${conversation.id}/pin`)
      .set(app.auth(ana))
      .expect(204);
    // De novo: continua 204, nao 409.
    await app.agent
      .post(`/api/v1/conversations/${conversation.id}/pin`)
      .set(app.auth(ana))
      .expect(204);

    await app.agent
      .delete(`/api/v1/conversations/${conversation.id}/pin`)
      .set(app.auth(ana))
      .expect(204);
    // Desafixar o que nao esta fixado tambem e 204.
    await app.agent
      .delete(`/api/v1/conversations/${conversation.id}/pin`)
      .set(app.auth(ana))
      .expect(204);
  });

  it('o pin e PESSOAL: o que Ana fixa nao vem fixado para o gestor', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    const gestor = await createUser({ tenantId: tenant.id, role: 'manager', name: 'Bruno' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });

    await app.agent
      .post(`/api/v1/conversations/${conversation.id}/pin`)
      .set(app.auth(ana))
      .expect(204);

    const daAna = await app.agent
      .get('/api/v1/conversations?scope=all')
      .set(app.auth(ana))
      .expect(200);
    expect(daAna.body.conversations[0].pinned).toBe(true);

    const doGestor = await app.agent
      .get('/api/v1/conversations?scope=all')
      .set(app.auth(gestor))
      .expect(200);
    expect(doGestor.body.conversations[0].pinned).toBe(false);
  });

  it('fixada vem PRIMEIRO na lista, e os counts dos chips nao mudam', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    const db = await getTestDb();

    // `antiga` tem a mensagem mais velha: pela ordenacao padrao ela e a ultima.
    const antiga = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
    const recente = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
    await db.withoutTenant((tx) =>
      tx.query(
        `UPDATE conversations SET last_message_at = CASE id WHEN $1 THEN NOW() - INTERVAL '2 days'
                                                            ELSE NOW() END`,
        [antiga.id],
      ),
    );

    const antes = await app.agent
      .get('/api/v1/conversations?scope=mine')
      .set(app.auth(ana))
      .expect(200);
    expect(antes.body.conversations.map((c: { id: string }) => c.id)).toEqual([
      recente.id,
      antiga.id,
    ]);

    await app.agent.post(`/api/v1/conversations/${antiga.id}/pin`).set(app.auth(ana)).expect(204);

    const depois = await app.agent
      .get('/api/v1/conversations?scope=mine')
      .set(app.auth(ana))
      .expect(200);
    expect(depois.body.conversations.map((c: { id: string }) => c.id)).toEqual([
      antiga.id,
      recente.id,
    ]);
    expect(depois.body.counts).toEqual(antes.body.counts);
  });

  it('conversa de OUTRO tenant e 404 e nao grava pin nenhum', async () => {
    const alfa = await createTenant();
    const beta = await createTenant();
    const ana = await createUser({ tenantId: alfa.id, role: 'attendant', name: 'Ana' });
    const deBeta = await createConversation({ tenantId: beta.id, assignedTo: null });

    await app.agent
      .post(`/api/v1/conversations/${deBeta.id}/pin`)
      .set(app.auth(ana))
      .expect(404);

    const db = await getTestDb();
    const rows = await db.withoutTenant((tx) =>
      tx.query<{ total: number }>('SELECT COUNT(*)::int AS total FROM conversation_pins'),
    );
    expect(rows.rows[0]?.total).toBe(0);
  });
});
