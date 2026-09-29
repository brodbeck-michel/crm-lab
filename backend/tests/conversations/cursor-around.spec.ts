/**
 * GET /conversations/:id?around=<messageId> e ?after=<messageId> (CRMLAB-68,
 * D-230) — "ir ate a mensagem" da busca, reaproveitando o cursor por id do
 * CRMLAB-71 (D-237).
 *
 *  - `around`: ate floor(limit/2) mais novas; o resto com ela e as anteriores;
 *  - `after`: as `limit` imediatamente posteriores, crescente;
 *  - `cursors.after` = mais nova da pagina quando ha mais novas; `null` na ponta;
 *  - cursores excludentes entre si e com `page`; cursor alheio -> 404.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { conversationModule } from '../../src/controllers/conversation.routes.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { seedMessage } from './helpers.js';

interface WireMessage {
  id: string;
  content: string;
}

describe('GET /conversations/:id — `around` e `after` (D-230)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ modules: [conversationModule] });
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  /** m1..mN, um minuto de distancia. Devolve os ids em ordem. */
  async function scenario(count: number) {
    const tenant = await createTenant();
    const attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: attendant.id });
    const db = await getTestDb();
    const ids: string[] = [];
    for (let i = 1; i <= count; i += 1) {
      const seeded = await seedMessage({ tenantId: tenant.id, conversationId: conversation.id, content: `m${i}` });
      await db.withoutTenant((tx) =>
        tx.query('UPDATE messages SET created_at = $2::timestamp WHERE id = $1', [
          seeded.id,
          `2026-09-20 10:${String(i).padStart(2, '0')}:00`,
        ]),
      );
      ids.push(seeded.id);
    }
    const get = (query: string) =>
      app.agent.get(`/api/v1/conversations/${conversation.id}?${query}`).set(app.auth(attendant));
    return { tenant, attendant, conversation, ids, get };
  }

  const names = (body: { messages: WireMessage[] }) => body.messages.map((m) => m.content);

  it('`around` no meio: metade mais nova, o resto com ela e as anteriores, e os dois cursores', async () => {
    const { ids, get } = await scenario(20);
    const response = await get(`messageLimit=6&around=${ids[9]}`).expect(200);
    // floor(6/2) = 3 mais novas (m11..m13) + ela e 2 anteriores (m8..m10).
    expect(names(response.body)).toEqual(['m8', 'm9', 'm10', 'm11', 'm12', 'm13']);
    expect(response.body.cursors).toEqual({ before: ids[7], after: ids[12] });
    expect(response.body.pagination).toEqual({ page: 1, limit: 6, total: 20, totalPages: 4 });
  });

  it('`around` perto do fim completa com historico e `after` volta null; no comeco, `before` null', async () => {
    const { ids, get } = await scenario(10);
    const nearEnd = await get(`messageLimit=6&around=${ids[8]}`).expect(200);
    expect(names(nearEnd.body)).toEqual(['m5', 'm6', 'm7', 'm8', 'm9', 'm10']);
    expect(nearEnd.body.cursors).toEqual({ before: ids[4], after: null });

    const start = await get(`messageLimit=6&around=${ids[0]}`).expect(200);
    expect(names(start.body)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(start.body.cursors).toEqual({ before: null, after: ids[3] });
  });

  it('`after` encadeado a partir de uma janela antiga chega ao fim sem buraco nem repeticao', async () => {
    const { ids, get } = await scenario(9);
    const seen: string[] = [];
    let cursor: string | null = ids[1] ?? null;
    seen.push('m1', 'm2');
    while (cursor !== null) {
      const page = await get(`messageLimit=3&after=${cursor}`).expect(200);
      seen.push(...names(page.body));
      expect(page.body.cursors.before).toBe(page.body.messages[0].id);
      cursor = page.body.cursors.after;
    }
    expect(seen).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9']);
  });

  it('`after` da ultima mensagem devolve pagina vazia e nada mais a pedir', async () => {
    const { ids, get } = await scenario(3);
    const response = await get(`after=${ids[2]}`).expect(200);
    expect(response.body.messages).toEqual([]);
    expect(response.body.cursors.after).toBeNull();
  });

  it('cursores excludentes entre si e com `page`; cursor de outra conversa/tenant -> 404', async () => {
    const { tenant, ids, get } = await scenario(3);
    for (const query of [
      `around=${ids[0]}&before=${ids[1]}`,
      `around=${ids[0]}&after=${ids[1]}`,
      `after=${ids[0]}&page=1`,
      `around=${ids[0]}&page=2`,
      'around=nao-e-uuid',
    ]) {
      const response = await get(query).expect(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }

    const other = await createConversation({ tenantId: tenant.id });
    const foreign = await seedMessage({ tenantId: tenant.id, conversationId: other.id });
    const alienTenant = await createTenant();
    const alienConversation = await createConversation({ tenantId: alienTenant.id });
    const alien = await seedMessage({ tenantId: alienTenant.id, conversationId: alienConversation.id });
    for (const cursor of [foreign.id, alien.id]) {
      for (const mode of ['around', 'after']) {
        const response = await get(`${mode}=${cursor}`).expect(404);
        expect(response.body.error.code).toBe('NOT_FOUND');
        expect(response.body.error.details.resource).toBe('message');
      }
    }
  });
});
