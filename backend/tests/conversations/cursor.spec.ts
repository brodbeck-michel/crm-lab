/**
 * GET /conversations/:id?before=<messageId> — paginacao por cursor (D-237,
 * CRMLAB-71). API_CONTRACTS.md §2.
 *
 * O que importa aqui:
 *  - as paginas encadeadas por `cursors.before` cobrem a conversa inteira, sem
 *    buraco e sem repeticao, e param no comeco (`before: null`);
 *  - a ordem e `(created_at, id)`, lida no banco com microssegundos — o fio so
 *    tem milissegundos, e um cursor por `createdAt` pularia mensagens;
 *  - cursor de outra conversa/tenant -> 404, nunca lista vazia;
 *  - `page` continua funcionando (compatibilidade) e nao convive com `before`.
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

/** Grava com `created_at` explicito (texto sem fuso = UTC, como a coluna). */
async function seedAt(
  tenantId: string,
  conversationId: string,
  content: string,
  createdAt: string,
  id?: string,
): Promise<string> {
  const db = await getTestDb();
  const seeded = await seedMessage({ tenantId, conversationId, content });
  await db.withoutTenant((tx) =>
    tx.query('UPDATE messages SET created_at = $2::timestamp, id = COALESCE($3::uuid, id) WHERE id = $1', [
      seeded.id,
      createdAt,
      id ?? null,
    ]),
  );
  return id ?? seeded.id;
}

describe('GET /conversations/:id — cursor `before` (D-237)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ modules: [conversationModule] });
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  async function scenario(count: number) {
    const tenant = await createTenant();
    const attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: attendant.id });
    for (let i = 1; i <= count; i += 1) {
      const minute = String(i).padStart(2, '0');
      await seedAt(tenant.id, conversation.id, `m${i}`, `2026-09-20 10:${minute}:00`);
    }
    return { tenant, attendant, conversation };
  }

  it('encadeia as paginas pelo cursor ate o comeco da conversa, sem buraco nem repeticao', async () => {
    const { attendant, conversation } = await scenario(7);
    const url = `/api/v1/conversations/${conversation.id}`;

    const first = await app.agent.get(`${url}?messageLimit=3`).set(app.auth(attendant)).expect(200);
    expect(first.body.messages.map((m: WireMessage) => m.content)).toEqual(['m5', 'm6', 'm7']);
    expect(first.body.cursors).toEqual({ before: first.body.messages[0].id, after: null });
    expect(first.body.pagination).toEqual({ page: 1, limit: 3, total: 7, totalPages: 3 });

    const second = await app.agent
      .get(`${url}?messageLimit=3&before=${first.body.cursors.before}`)
      .set(app.auth(attendant))
      .expect(200);
    expect(second.body.messages.map((m: WireMessage) => m.content)).toEqual(['m2', 'm3', 'm4']);
    expect(second.body.pagination).toEqual({ page: 1, limit: 3, total: 7, totalPages: 3 });

    const third = await app.agent
      .get(`${url}?messageLimit=3&before=${second.body.cursors.before}`)
      .set(app.auth(attendant))
      .expect(200);
    expect(third.body.messages.map((m: WireMessage) => m.content)).toEqual(['m1']);
    // Comeco da conversa: nada mais para pedir.
    expect(third.body.cursors).toEqual({ before: null, after: null });
  });

  it('pagina que termina exatamente no comeco ja volta `before: null`', async () => {
    const { attendant, conversation } = await scenario(3);
    const response = await app.agent
      .get(`/api/v1/conversations/${conversation.id}?messageLimit=3`)
      .set(app.auth(attendant))
      .expect(200);
    expect(response.body.messages).toHaveLength(3);
    expect(response.body.cursors.before).toBeNull();
  });

  it('ordem por (created_at, id) com microssegundos: nada some no mesmo milissegundo', async () => {
    const tenant = await createTenant();
    const attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: attendant.id });
    // Tres mensagens no MESMO milissegundo (.123), duas no mesmo microssegundo
    // (desempate pelo id).
    await seedAt(tenant.id, conversation.id, 'a', '2026-09-20 10:00:00.123100');
    await seedAt(
      tenant.id,
      conversation.id,
      'b',
      '2026-09-20 10:00:00.123400',
      '00000000-0000-4000-8000-000000000001',
    );
    await seedAt(
      tenant.id,
      conversation.id,
      'c',
      '2026-09-20 10:00:00.123400',
      '00000000-0000-4000-8000-000000000002',
    );
    await seedAt(tenant.id, conversation.id, 'd', '2026-09-20 10:00:00.123900');

    const seen: string[] = [];
    let before: string | null = null;
    let first = true;
    while (first || before !== null) {
      first = false;
      const query: string = before === null ? '' : `&before=${before}`;
      const response = await app.agent
        .get(`/api/v1/conversations/${conversation.id}?messageLimit=1${query}`)
        .set(app.auth(attendant))
        .expect(200);
      seen.unshift(...response.body.messages.map((m: WireMessage) => m.content));
      before = response.body.cursors.before;
    }

    expect(seen).toEqual(['a', 'b', 'c', 'd']);
  });

  it('cursor de OUTRA conversa ou de outro tenant -> 404, nunca lista vazia', async () => {
    const { tenant, attendant, conversation } = await scenario(2);
    const other = await createConversation({ tenantId: tenant.id, assignedTo: attendant.id });
    const foreign = await seedAt(tenant.id, other.id, 'de outra conversa', '2026-09-20 11:00:00');

    const otherTenant = await createTenant();
    const otherConversation = await createConversation({ tenantId: otherTenant.id });
    const alien = await seedAt(otherTenant.id, otherConversation.id, 'segredo', '2026-09-20 11:00:00');

    for (const cursor of [foreign, alien, '00000000-0000-4000-8000-00000000ffff']) {
      const response = await app.agent
        .get(`/api/v1/conversations/${conversation.id}?before=${cursor}`)
        .set(app.auth(attendant))
        .expect(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    }
  });

  it('`before` + `page` juntos, ou `before` que nao e uuid -> VALIDATION_ERROR', async () => {
    const { attendant, conversation } = await scenario(2);
    const first = await app.agent
      .get(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(attendant))
      .expect(200);

    const both = await app.agent
      .get(`/api/v1/conversations/${conversation.id}?page=1&before=${first.body.messages[1].id}`)
      .set(app.auth(attendant))
      .expect(400);
    expect(both.body.error.code).toBe('VALIDATION_ERROR');

    const garbage = await app.agent
      .get(`/api/v1/conversations/${conversation.id}?before=2026-09-20T10:00:00Z,abc`)
      .set(app.auth(attendant))
      .expect(400);
    expect(garbage.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('`page` continua funcionando (compatibilidade) e tambem devolve cursores', async () => {
    const { attendant, conversation } = await scenario(5);
    const response = await app.agent
      .get(`/api/v1/conversations/${conversation.id}?messageLimit=2&page=2`)
      .set(app.auth(attendant))
      .expect(200);
    expect(response.body.messages.map((m: WireMessage) => m.content)).toEqual(['m2', 'm3']);
    expect(response.body.pagination).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
    expect(response.body.cursors).toEqual({ before: response.body.messages[0].id, after: null });
  });
});
