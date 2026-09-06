/**
 * RLS fail-closed de `quick_replies` (migração 008, Onda 8 §3.2).
 *
 * Mesmo padrão de `rls-onda8.spec.ts`: dois tenants, um não vê linha do outro;
 * sem `withTenant()` a query não devolve nada (fail-closed); INSERT com
 * `tenant_id` alheio é rejeitado pela POLICY, não pela aplicação.
 *
 * A tabela nasce com GRANT de escrita a `crm_app` por causa do
 * `ALTER DEFAULT PRIVILEGES` da 002 — sem a policy ela não travaria, VAZARIA.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';

describe('RLS Onda 8 — quick_replies', () => {
  let db: DbClient;
  let tenantA: TenantRecord;
  let tenantB: TenantRecord;
  let anaA: UserRecord;
  let anaB: UserRecord;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    tenantA = await createTenant({ name: 'Lab A' });
    tenantB = await createTenant({ name: 'Lab B' });
    anaA = await createUser({ tenantId: tenantA.id, role: 'attendant', name: 'Ana A' });
    anaB = await createUser({ tenantId: tenantB.id, role: 'attendant', name: 'Ana B' });
  });

  async function seed(tenantId: string, userId: string, shortcut: string): Promise<void> {
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO quick_replies (tenant_id, shortcut, title, content, created_by)
         VALUES ($1, $2, 'Título', 'Conteúdo', $3)`,
        [tenantId, shortcut, userId],
      ),
    );
  }

  it('contexto de A não vê macro de B', async () => {
    await seed(tenantA.id, anaA.id, 'coleta-a');
    await seed(tenantB.id, anaB.id, 'coleta-b');

    const visibleToA = await db.withTenant(tenantA.id, (tx) =>
      tx.query<{ shortcut: string }>('SELECT shortcut FROM quick_replies'),
    );

    expect(visibleToA.rows.map((r) => r.shortcut)).toEqual(['coleta-a']);
  });

  it('sem contexto de tenant a policy não devolve nada (fail-closed)', async () => {
    await seed(tenantA.id, anaA.id, 'coleta-a');

    const semContexto = await db.withTenant('', (tx) =>
      tx.query<{ total: number }>('SELECT COUNT(*)::int AS total FROM quick_replies'),
    ).catch(() => null);

    // `withTenant('')` pode recusar antes de chegar ao SQL; o que não pode é
    // devolver linha. As duas saídas aceitáveis são erro ou zero.
    expect(semContexto === null || semContexto.rows[0]?.total === 0).toBe(true);
  });

  it('INSERT com tenant_id alheio é rejeitado pela policy', async () => {
    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query(
          `INSERT INTO quick_replies (tenant_id, shortcut, title, content)
           VALUES ($1, 'invasao', 'Título', 'Conteúdo')`,
          [tenantB.id],
        ),
      ),
    ).rejects.toThrow();
  });

  it('DELETE não atravessa tenant: A não apaga a macro de B', async () => {
    await seed(tenantB.id, anaB.id, 'coleta-b');

    await db.withTenant(tenantA.id, (tx) =>
      tx.query(`DELETE FROM quick_replies WHERE shortcut = 'coleta-b'`),
    );

    const survivors = await db.withoutTenant((tx) =>
      tx.query<{ total: number }>('SELECT COUNT(*)::int AS total FROM quick_replies'),
    );
    expect(survivors.rows[0]?.total).toBe(1);
  });

  it('o CHECK do banco recusa atalho com maiúscula, espaço ou acento', async () => {
    for (const invalido of ['Coleta', 'horario coleta', 'horário', 'a']) {
      await expect(seed(tenantA.id, anaA.id, invalido)).rejects.toThrow();
    }
  });

  it('remover a autora preserva a macro do laboratório (ON DELETE SET NULL)', async () => {
    await seed(tenantA.id, anaA.id, 'coleta-a');

    await db.withoutTenant((tx) => tx.query('DELETE FROM users WHERE id = $1', [anaA.id]));

    const sobrevivente = await db.withTenant(tenantA.id, (tx) =>
      tx.query<{ created_by: string | null }>('SELECT created_by FROM quick_replies'),
    );
    expect(sobrevivente.rows).toHaveLength(1);
    expect(sobrevivente.rows[0]?.created_by).toBeNull();
  });
});
