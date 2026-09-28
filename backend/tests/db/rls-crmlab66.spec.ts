/**
 * RLS fail-closed de `message_reactions` e `message_edits` (migração 040 —
 * CRMLAB-66). Mesmo padrão de `rls-funnel-rules.spec.ts`: sem a policy, o GRANT
 * de `ALTER DEFAULT PRIVILEGES` da 002 faria reação e versão anterior de
 * mensagem VAZAREM entre laboratórios.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { seedMessage } from '../conversations/helpers.js';
import { createConversation, createTenant, type TenantRecord } from '../helpers/factories.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

describe('RLS CRMLAB-66 — message_reactions e message_edits', () => {
  let db: DbClient;
  let tenantA: TenantRecord;
  let tenantB: TenantRecord;
  let messageA: string;
  let messageB: string;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    tenantA = await createTenant({ name: 'Lab A' });
    tenantB = await createTenant({ name: 'Lab B' });
    const convA = await createConversation({ tenantId: tenantA.id, db });
    const convB = await createConversation({ tenantId: tenantB.id, db });
    messageA = (await seedMessage({ tenantId: tenantA.id, conversationId: convA.id, db })).id;
    messageB = (await seedMessage({ tenantId: tenantB.id, conversationId: convB.id, db })).id;
    await db.withoutTenant(async (tx) => {
      for (const [tenantId, messageId] of [
        [tenantA.id, messageA],
        [tenantB.id, messageB],
      ] as const) {
        await tx.query(
          `INSERT INTO message_reactions (tenant_id, message_id, reactor_type, emoji)
           VALUES ($1, $2, 'patient', '👍')`,
          [tenantId, messageId],
        );
        await tx.query(
          `INSERT INTO message_edits (tenant_id, message_id, previous_content, edited_by)
           VALUES ($1, $2, 'versao antiga', 'patient')`,
          [tenantId, messageId],
        );
      }
    });
  });

  for (const table of ['message_reactions', 'message_edits'] as const) {
    it(`${table}: contexto de A só vê a própria linha`, async () => {
      const visible = await db.withTenant(tenantA.id, (tx) =>
        tx.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${table}`),
      );
      expect(visible.rows.map((r) => r.tenant_id)).toEqual([tenantA.id]);
    });

    it(`${table}: RLS ligado e com policy`, async () => {
      const rows = await db.withoutTenant((tx) =>
        tx.query<{ rowsecurity: boolean; policies: number }>(
          `SELECT t.rowsecurity,
                  (SELECT COUNT(*)::int FROM pg_policies p
                    WHERE p.schemaname = 'public' AND p.tablename = t.tablename) AS policies
             FROM pg_tables t
            WHERE t.schemaname = 'public' AND t.tablename = $1`,
          [table],
        ),
      );
      expect(rows.rows[0]).toEqual({ rowsecurity: true, policies: 1 });
    });

    it(`${table}: DELETE não atravessa tenant`, async () => {
      await db.withTenant(tenantA.id, (tx) => tx.query(`DELETE FROM ${table}`));
      const b = await db.withoutTenant((tx) =>
        tx.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1`, [tenantB.id]),
      );
      expect(b.rows).toHaveLength(1);
    });
  }

  it('INSERT com tenant_id alheio é rejeitado pela policy', async () => {
    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query(
          `INSERT INTO message_reactions (tenant_id, message_id, reactor_type, emoji)
           VALUES ($1, $2, 'agent', '❤️')`,
          [tenantB.id, messageB],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query(
          `INSERT INTO message_edits (tenant_id, message_id, previous_content, edited_by)
           VALUES ($1, $2, 'x', 'agent')`,
          [tenantB.id, messageB],
        ),
      ),
    ).rejects.toThrow();
  });

  it('uma reação por lado: segunda do mesmo lado viola a unicidade', async () => {
    await expect(
      db.withoutTenant((tx) =>
        tx.query(
          `INSERT INTO message_reactions (tenant_id, message_id, reactor_type, emoji)
           VALUES ($1, $2, 'patient', '❤️')`,
          [tenantA.id, messageA],
        ),
      ),
    ).rejects.toThrow();
  });
});
