/**
 * RLS fail-closed de `conversation_pins` (migração 007, Onda 8 §2.3).
 *
 * Mesmo padrão de `rls-onda7.spec.ts`: dois tenants, um não vê linha do outro;
 * sem `withTenant()` a query não devolve nada (fail-closed); INSERT com
 * `tenant_id` alheio é rejeitado pela POLICY, não pela aplicação.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import {
  createConversation,
  createTenant,
  createUser,
  type TenantRecord,
  type UserRecord,
} from '../helpers/factories.js';

describe('RLS Onda 8 — conversation_pins', () => {
  let db: DbClient;
  let tenantA: TenantRecord;
  let tenantB: TenantRecord;
  let anaA: UserRecord;
  let anaB: UserRecord;
  let conversationA: { id: string };
  let conversationB: { id: string };

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    tenantA = await createTenant({ name: 'Lab A' });
    tenantB = await createTenant({ name: 'Lab B' });
    anaA = await createUser({ tenantId: tenantA.id, role: 'attendant', name: 'Ana A' });
    anaB = await createUser({ tenantId: tenantB.id, role: 'attendant', name: 'Ana B' });
    conversationA = await createConversation({ tenantId: tenantA.id, assignedTo: anaA.id });
    conversationB = await createConversation({ tenantId: tenantB.id, assignedTo: anaB.id });
  });

  async function pin(tenantId: string, userId: string, conversationId: string): Promise<void> {
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO conversation_pins (tenant_id, user_id, conversation_id)
         VALUES ($1, $2, $3)`,
        [tenantId, userId, conversationId],
      ),
    );
  }

  it('contexto de A não vê pin de B', async () => {
    await pin(tenantA.id, anaA.id, conversationA.id);
    await pin(tenantB.id, anaB.id, conversationB.id);

    const visibleToA = await db.withTenant(tenantA.id, (tx) =>
      tx.query<{ conversation_id: string }>('SELECT conversation_id FROM conversation_pins'),
    );

    expect(visibleToA.rows).toHaveLength(1);
    expect(visibleToA.rows[0]?.conversation_id).toBe(conversationA.id);
  });

  it('INSERT com tenant_id alheio é rejeitado pela policy', async () => {
    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query(
          `INSERT INTO conversation_pins (tenant_id, user_id, conversation_id)
           VALUES ($1, $2, $3)`,
          [tenantB.id, anaB.id, conversationB.id],
        ),
      ),
    ).rejects.toThrow();
  });

  it('DELETE não atravessa tenant: A não desafixa o pin de B', async () => {
    await pin(tenantB.id, anaB.id, conversationB.id);

    await db.withTenant(tenantA.id, (tx) =>
      tx.query('DELETE FROM conversation_pins WHERE conversation_id = $1', [conversationB.id]),
    );

    const survivors = await db.withoutTenant((tx) =>
      tx.query<{ total: number }>('SELECT COUNT(*)::int AS total FROM conversation_pins'),
    );
    expect(survivors.rows[0]?.total).toBe(1);
  });
});
