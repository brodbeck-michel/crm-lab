/**
 * RLS fail-closed de `conversation_reengagements` e `tenant_holidays`
 * (migracao 031 — CRMLAB-62, D-211/D-213). Mesmo padrao de
 * `rls-funnel-rules.spec.ts`.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { createConversation, createTenant, type TenantRecord } from '../helpers/factories.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

describe('RLS CRMLAB-62 — conversation_reengagements e tenant_holidays', () => {
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

  async function seedDecision(tenantId: string): Promise<void> {
    const conversation = await createConversation({ tenantId, db });
    await db.withoutTenant(async (tx) => {
      const anchor = await tx.query<{ id: string }>(
        `INSERT INTO messages (tenant_id, conversation_id, sender_type, content)
         VALUES ($1, $2, 'agent', 'oi') RETURNING id`,
        [tenantId, conversation.id],
      );
      await tx.query(
        `INSERT INTO conversation_reengagements (tenant_id, conversation_id, anchor_message_id, step, outcome)
         VALUES ($1, $2, $3, 'first', 'sent')`,
        [tenantId, conversation.id, anchor.rows[0]?.id],
      );
    });
  }

  async function seedHoliday(tenantId: string): Promise<void> {
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO tenant_holidays (tenant_id, holiday_date, description) VALUES ($1, '2026-03-19', 'x')`,
        [tenantId],
      ),
    );
  }

  it('contexto de A so ve as proprias linhas', async () => {
    await seedDecision(tenantA.id);
    await seedDecision(tenantB.id);
    await seedHoliday(tenantA.id);
    await seedHoliday(tenantB.id);
    for (const table of ['conversation_reengagements', 'tenant_holidays']) {
      const visible = await db.withTenant(tenantA.id, (tx) =>
        tx.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${table}`),
      );
      expect(visible.rows.map((r) => r.tenant_id)).toEqual([tenantA.id]);
    }
  });

  it('INSERT com tenant_id alheio e rejeitado pela policy', async () => {
    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query(
          `INSERT INTO tenant_holidays (tenant_id, holiday_date, description) VALUES ($1, '2026-03-19', 'x')`,
          [tenantB.id],
        ),
      ),
    ).rejects.toThrow();
  });

  it('DELETE nao atravessa tenant', async () => {
    await seedDecision(tenantB.id);
    await seedHoliday(tenantB.id);
    await db.withTenant(tenantA.id, async (tx) => {
      await tx.query('DELETE FROM conversation_reengagements');
      await tx.query('DELETE FROM tenant_holidays');
    });
    const left = await db.withoutTenant((tx) =>
      tx.query<{ n: number }>(
        `SELECT (SELECT COUNT(*)::int FROM conversation_reengagements) + (SELECT COUNT(*)::int FROM tenant_holidays) AS n`,
      ),
    );
    expect(left.rows[0]?.n).toBe(2);
  });

  it('o mesmo disparo nao entra duas vezes (UNIQUE anchor + step)', async () => {
    await seedDecision(tenantA.id);
    await expect(
      db.withoutTenant((tx) =>
        tx.query(
          `INSERT INTO conversation_reengagements (tenant_id, conversation_id, anchor_message_id, step, outcome)
           SELECT tenant_id, conversation_id, anchor_message_id, step, outcome FROM conversation_reengagements`,
        ),
      ),
    ).rejects.toThrow();
  });
});
