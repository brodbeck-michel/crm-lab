/**
 * Migração 074 — comentários da linha do tempo do médico (CRMLAB-192, D-332).
 * Num banco isolado, volta o schema para antes da 074, roda o próprio arquivo
 * (duas vezes: é idempotente) e confere:
 *  - a referência polimórfica: exatamente um de `visit_id`/`interaction_id`;
 *  - o texto: não vazio, até 2000;
 *  - `ON DELETE CASCADE` do registro manual leva os comentários dele;
 *  - apagar o autor zera `author_id` (o comentário fica);
 *  - RLS: um tenant não enxerga (nem grava) comentário do outro.
 */
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createIsolatedTestDb } from '../helpers/test-db.js';

const SQL_URL = new URL('../../migrations/074_doctor_timeline_comments.sql', import.meta.url);

let db: DbClient;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let userA: UserRecord;
let userB: UserRecord;
let visitA: string;
let interactionA: string;
let visitB: string;

async function runMigration(): Promise<void> {
  const sql = await readFile(SQL_URL, 'utf8');
  await db.withoutTenant((tx) => tx.exec(sql));
}

async function seedItems(tenantId: string, userId: string): Promise<{ visit: string; interaction: string }> {
  return db.withoutTenant(async (tx) => {
    const doctor = await tx.query<{ id: string }>(
      `INSERT INTO doctors (tenant_id, name) VALUES ($1, 'Dra. Feed') RETURNING id`,
      [tenantId],
    );
    const doctorId = doctor.rows[0]?.id;
    const visit = await tx.query<{ id: string }>(
      `INSERT INTO doctor_visits (tenant_id, doctor_id, responsible_user_id, scheduled_at, type, purpose_id)
       VALUES ($1, $2, $3, '2026-10-06T13:00:00Z', 'presencial',
               (SELECT id FROM visit_purposes WHERE tenant_id = $1 AND name = 'Visita')) RETURNING id`,
      [tenantId, doctorId, userId],
    );
    const interaction = await tx.query<{ id: string }>(
      `INSERT INTO doctor_interactions (tenant_id, doctor_id, type, occurred_at, description, created_by)
       VALUES ($1, $2, 'ligacao', '2026-10-01T12:00:00Z', 'Ligou', $3) RETURNING id`,
      [tenantId, doctorId, userId],
    );
    return { visit: visit.rows[0]?.id as string, interaction: interaction.rows[0]?.id as string };
  });
}

function insertComment(values: {
  tenantId: string;
  visitId?: string | null;
  interactionId?: string | null;
  authorId?: string | null;
  body?: string;
}) {
  return db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO doctor_timeline_comments (tenant_id, visit_id, interaction_id, author_id, body)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [values.tenantId, values.visitId ?? null, values.interactionId ?? null, values.authorId ?? null, values.body ?? 'Comentário'],
    ),
  );
}

beforeAll(async () => {
  db = await createIsolatedTestDb();
  await db.withoutTenant((tx) => tx.exec('DROP TABLE IF EXISTS doctor_timeline_comments'));
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  userA = await createUser({ tenantId: tenantA.id, db });
  userB = await createUser({ tenantId: tenantB.id, db });
  const itemsA = await seedItems(tenantA.id, userA.id);
  visitA = itemsA.visit;
  interactionA = itemsA.interaction;
  visitB = (await seedItems(tenantB.id, userB.id)).visit;
  await runMigration();
  await runMigration();
}, 60_000);

describe('migração 074', () => {
  it('aceita comentário em visita e em registro manual', async () => {
    await expect(insertComment({ tenantId: tenantA.id, visitId: visitA, authorId: userA.id })).resolves.toBeDefined();
    await expect(
      insertComment({ tenantId: tenantA.id, interactionId: interactionA, authorId: userA.id }),
    ).resolves.toBeDefined();
  });

  it('recusa comentário sem alvo ou com os dois alvos', async () => {
    await expect(insertComment({ tenantId: tenantA.id })).rejects.toThrow();
    await expect(
      insertComment({ tenantId: tenantA.id, visitId: visitA, interactionId: interactionA }),
    ).rejects.toThrow();
  });

  it('recusa texto vazio ou acima de 2000', async () => {
    await expect(insertComment({ tenantId: tenantA.id, visitId: visitA, body: '   ' })).rejects.toThrow();
    await expect(insertComment({ tenantId: tenantA.id, visitId: visitA, body: 'x'.repeat(2001) })).rejects.toThrow();
    await expect(
      insertComment({ tenantId: tenantA.id, visitId: visitA, body: 'x'.repeat(2000) }),
    ).resolves.toBeDefined();
  });

  it('excluir o registro manual leva os comentários dele', async () => {
    const extra = await seedItems(tenantA.id, userA.id);
    const comment = await insertComment({ tenantId: tenantA.id, interactionId: extra.interaction });
    await db.withoutTenant((tx) => tx.query('DELETE FROM doctor_interactions WHERE id = $1', [extra.interaction]));
    const left = await db.withoutTenant((tx) =>
      tx.query('SELECT id FROM doctor_timeline_comments WHERE id = $1', [comment.rows[0]?.id]),
    );
    expect(left.rows).toHaveLength(0);
  });

  it('apagar o autor mantém o comentário sem autor', async () => {
    const author = await createUser({ tenantId: tenantA.id, db });
    const comment = await insertComment({ tenantId: tenantA.id, visitId: visitA, authorId: author.id });
    await db.withoutTenant((tx) => tx.query('DELETE FROM users WHERE id = $1', [author.id]));
    const row = await db.withoutTenant((tx) =>
      tx.query<{ author_id: string | null }>('SELECT author_id FROM doctor_timeline_comments WHERE id = $1', [
        comment.rows[0]?.id,
      ]),
    );
    expect(row.rows[0]?.author_id).toBeNull();
  });

  it('RLS: um tenant não enxerga nem grava comentário do outro', async () => {
    await insertComment({ tenantId: tenantB.id, visitId: visitB, authorId: userB.id, body: 'Segredo B' });
    const rows = await db.withTenant(tenantA.id, (tx) =>
      tx.query<{ tenant_id: string; body: string }>('SELECT tenant_id, body FROM doctor_timeline_comments'),
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows.every((r) => r.tenant_id === tenantA.id)).toBe(true);
    expect(rows.rows.some((r) => r.body === 'Segredo B')).toBe(false);

    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query(`INSERT INTO doctor_timeline_comments (tenant_id, visit_id, body) VALUES ($1, $2, 'x')`, [
          tenantB.id,
          visitB,
        ]),
      ),
    ).rejects.toThrow();
  });

  it('RLS ligado e com policy', async () => {
    const result = await db.withoutTenant((tx) =>
      tx.query<{ relrowsecurity: boolean; policies: number }>(
        `SELECT c.relrowsecurity,
                (SELECT COUNT(*)::int FROM pg_policies p WHERE p.tablename = c.relname) AS policies
           FROM pg_class c WHERE c.relname = 'doctor_timeline_comments'`,
      ),
    );
    expect(result.rows[0]?.relrowsecurity).toBe(true);
    expect(result.rows[0]?.policies).toBe(1);
  });
});
