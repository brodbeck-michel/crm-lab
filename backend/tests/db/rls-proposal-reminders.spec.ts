/**
 * RLS fail-closed de `proposal_reminders` (migracao 056 — CRMLAB-102,
 * D-272). Mesmo padrao de `rls-auto-replies.spec.ts`.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { createProposal, createTenant, type TenantRecord } from '../helpers/factories.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

describe('RLS CRMLAB-102 — proposal_reminders', () => {
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

  async function seedReminder(tenantId: string): Promise<string> {
    const proposal = await createProposal({ tenantId, status: 'follow_up', db });
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO proposal_reminders (tenant_id, proposal_id, origin, due_date)
         VALUES ($1, $2, 'manual', '2026-10-20')`,
        [tenantId, proposal.id],
      ),
    );
    return proposal.id;
  }

  it('contexto de A so ve as proprias linhas', async () => {
    await seedReminder(tenantA.id);
    await seedReminder(tenantB.id);
    const visible = await db.withTenant(tenantA.id, (tx) =>
      tx.query<{ tenant_id: string }>('SELECT tenant_id FROM proposal_reminders'),
    );
    expect(visible.rows.map((r) => r.tenant_id)).toEqual([tenantA.id]);
  });

  it('INSERT com tenant_id alheio e rejeitado pela policy', async () => {
    const proposal = await createProposal({ tenantId: tenantB.id, db });
    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query(
          `INSERT INTO proposal_reminders (tenant_id, proposal_id, origin, due_date)
           VALUES ($1, $2, 'manual', '2026-10-20')`,
          [tenantB.id, proposal.id],
        ),
      ),
    ).rejects.toThrow();
  });

  it('UPDATE/DELETE nao atravessam tenant', async () => {
    await seedReminder(tenantB.id);
    await db.withTenant(tenantA.id, async (tx) => {
      await tx.query(`UPDATE proposal_reminders SET note = 'x'`);
      await tx.query('DELETE FROM proposal_reminders');
    });
    const left = await db.withoutTenant((tx) =>
      tx.query<{ n: string; note: string | null }>(
        'SELECT COUNT(*)::text AS n, MAX(note) AS note FROM proposal_reminders',
      ),
    );
    expect(left.rows[0]).toEqual({ n: '1', note: null });
  });

  it('travas: um aberto por proposta, um automatico por proposta, desfecho coerente', async () => {
    const id = await seedReminder(tenantA.id);
    await expect(
      db.withoutTenant((tx) =>
        tx.query(
          `INSERT INTO proposal_reminders (tenant_id, proposal_id, origin, due_date)
           VALUES ($1, $2, 'manual', '2026-10-21')`,
          [tenantA.id, id],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      db.withoutTenant((tx) =>
        tx.query(
          `INSERT INTO proposal_reminders (tenant_id, proposal_id, origin, due_date, resolved_at)
           VALUES ($1, $2, 'auto', '2026-10-21', NOW())`,
          [tenantA.id, id],
        ),
      ),
    ).rejects.toThrow();
    await db.withoutTenant(async (tx) => {
      await tx.query(
        `INSERT INTO proposal_reminders (tenant_id, proposal_id, origin, due_date, resolved_at, outcome)
         VALUES ($1, $2, 'auto', '2026-10-01', NOW(), 'auto_closed')`,
        [tenantA.id, id],
      );
    });
    await expect(
      db.withoutTenant((tx) =>
        tx.query(
          `INSERT INTO proposal_reminders (tenant_id, proposal_id, origin, due_date, resolved_at, outcome)
           VALUES ($1, $2, 'auto', '2026-10-02', NOW(), 'auto_closed')`,
          [tenantA.id, id],
        ),
      ),
    ).rejects.toThrow();
  });
});
