/**
 * RLS fail-closed de `conversation_auto_replies` (migracao 054 — CRMLAB-94,
 * D-264). Mesmo padrao de `rls-reengagement.spec.ts`.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { createConversation, createTenant, type TenantRecord } from '../helpers/factories.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

describe('RLS CRMLAB-94 — conversation_auto_replies', () => {
  let db: DbClient;
  let tenantA: TenantRecord;
  let tenantB: TenantRecord;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    tenantA = await createTenant({ name: 'Lab A' });
    tenantB = await createTenant({ name: 'Lab B' });
  });

  async function seedReply(tenantId: string): Promise<string> {
    const conversation = await createConversation({ tenantId, db });
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO conversation_auto_replies (tenant_id, conversation_id, kind, outcome)
         VALUES ($1, $2, 'greeting', 'sent')`,
        [tenantId, conversation.id],
      ),
    );
    return conversation.id;
  }

  it('contexto de A so ve as proprias linhas', async () => {
    await seedReply(tenantA.id);
    await seedReply(tenantB.id);
    const visible = await db.withTenant(tenantA.id, (tx) =>
      tx.query<{ tenant_id: string }>('SELECT tenant_id FROM conversation_auto_replies'),
    );
    expect(visible.rows.map((r) => r.tenant_id)).toEqual([tenantA.id]);
  });

  it('INSERT com tenant_id alheio e rejeitado pela policy', async () => {
    const conversation = await createConversation({ tenantId: tenantB.id, db });
    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query(
          `INSERT INTO conversation_auto_replies (tenant_id, conversation_id, kind, outcome)
           VALUES ($1, $2, 'greeting', 'sent')`,
          [tenantB.id, conversation.id],
        ),
      ),
    ).rejects.toThrow();
  });

  it('DELETE nao atravessa tenant', async () => {
    await seedReply(tenantB.id);
    await db.withTenant(tenantA.id, (tx) => tx.query('DELETE FROM conversation_auto_replies'));
    const left = await db.withoutTenant((tx) =>
      tx.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM conversation_auto_replies'),
    );
    expect(left.rows[0]?.n).toBe('1');
  });

  it('CHECKs: offhours exige reopens_at; greeting nao aceita; automation novo em messages', async () => {
    const conversation = await createConversation({ tenantId: tenantA.id, db });
    await expect(
      db.withoutTenant((tx) =>
        tx.query(
          `INSERT INTO conversation_auto_replies (tenant_id, conversation_id, kind, outcome)
           VALUES ($1, $2, 'offhours', 'sent')`,
          [tenantA.id, conversation.id],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      db.withoutTenant((tx) =>
        tx.query(
          `INSERT INTO messages (tenant_id, conversation_id, sender_type, content, automation)
           VALUES ($1, $2, 'agent', 'x', 'offhours'), ($1, $2, 'agent', 'y', 'greeting')`,
          [tenantA.id, conversation.id],
        ),
      ),
    ).resolves.toBeDefined();
    await expect(
      db.withoutTenant((tx) =>
        tx.query(
          `INSERT INTO messages (tenant_id, conversation_id, sender_type, content, automation)
           VALUES ($1, $2, 'agent', 'x', 'outra')`,
          [tenantA.id, conversation.id],
        ),
      ),
    ).rejects.toThrow();
  });
});
