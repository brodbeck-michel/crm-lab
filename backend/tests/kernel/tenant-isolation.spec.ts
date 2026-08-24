/**
 * Camada 3 do isolamento multitenant (docs/architecture/SECURITY.md).
 * Estes testes sao bloqueantes de release (TESTING.md).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import {
  createConversation,
  createExam,
  createTenant,
  createUser,
  type TenantRecord,
} from '../helpers/factories.js';

describe('withTenant — isolamento por RLS', () => {
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

  it('query dentro do contexto A nao ve dados de B', async () => {
    await createConversation({ tenantId: tenantA.id, patientName: 'Paciente A' });
    await createConversation({ tenantId: tenantB.id, patientName: 'Paciente B' });

    const visibleToA = await db.withTenant(tenantA.id, (tx) =>
      tx.query<{ patient_name: string }>('SELECT patient_name FROM conversations'),
    );

    expect(visibleToA.rows).toHaveLength(1);
    expect(visibleToA.rows[0]?.patient_name).toBe('Paciente A');
  });

  it('isola usuarios, exames e o proprio registro de tenant', async () => {
    await createUser({ tenantId: tenantA.id });
    await createUser({ tenantId: tenantB.id });
    await createExam({ tenantId: tenantA.id });
    await createExam({ tenantId: tenantB.id });
    await createExam({ tenantId: tenantB.id });

    const seen = await db.withTenant(tenantA.id, async (tx) => ({
      users: (await tx.query('SELECT id FROM users')).rows.length,
      exams: (await tx.query('SELECT id FROM exam_catalog')).rows.length,
      tenants: (await tx.query<{ id: string }>('SELECT id FROM tenants')).rows,
    }));

    expect(seen.users).toBe(1);
    expect(seen.exams).toBe(1);
    expect(seen.tenants).toHaveLength(1);
    expect(seen.tenants[0]?.id).toBe(tenantA.id);
  });

  it('busca por id de recurso de outro tenant volta vazia (vira 404 na API)', async () => {
    const conversationOfB = await createConversation({ tenantId: tenantB.id });

    const found = await db.withTenant(tenantA.id, (tx) =>
      tx.query('SELECT id FROM conversations WHERE id = $1', [conversationOfB.id]),
    );

    expect(found.rows).toHaveLength(0);
  });

  it('bloqueia INSERT com tenant_id alheio', async () => {
    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query(
          `INSERT INTO conversations (tenant_id, patient_phone, patient_name)
           VALUES ($1, $2, $3)`,
          [tenantB.id, '+5548999000111', 'Invasor'],
        ),
      ),
    ).rejects.toThrow(/row-level security|policy/i);

    const rowsOfB = await db.withoutTenant((tx) =>
      tx.query('SELECT id FROM conversations WHERE tenant_id = $1', [tenantB.id]),
    );
    expect(rowsOfB.rows).toHaveLength(0);
  });

  it('bloqueia UPDATE que tenta mover a linha para outro tenant', async () => {
    const conversation = await createConversation({ tenantId: tenantA.id });

    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query('UPDATE conversations SET tenant_id = $1 WHERE id = $2', [
          tenantB.id,
          conversation.id,
        ]),
      ),
    ).rejects.toThrow(/row-level security|policy/i);
  });

  it('DELETE nao alcanca linha de outro tenant', async () => {
    const conversationOfB = await createConversation({ tenantId: tenantB.id });

    const deleted = await db.withTenant(tenantA.id, (tx) =>
      tx.query('DELETE FROM conversations WHERE id = $1', [conversationOfB.id]),
    );
    expect(deleted.rowCount).toBe(0);

    const still = await db.withoutTenant((tx) =>
      tx.query('SELECT id FROM conversations WHERE id = $1', [conversationOfB.id]),
    );
    expect(still.rows).toHaveLength(1);
  });

  it('o contexto nao vaza entre transacoes consecutivas', async () => {
    await createConversation({ tenantId: tenantA.id });
    await createConversation({ tenantId: tenantB.id });

    const inA = await db.withTenant(tenantA.id, (tx) =>
      tx.query<{ tenant_id: string }>('SELECT tenant_id FROM conversations'),
    );
    const inB = await db.withTenant(tenantB.id, (tx) =>
      tx.query<{ tenant_id: string }>('SELECT tenant_id FROM conversations'),
    );

    expect(inA.rows.map((r) => r.tenant_id)).toEqual([tenantA.id]);
    expect(inB.rows.map((r) => r.tenant_id)).toEqual([tenantB.id]);

    // Fora de qualquer withTenant o GUC esta limpo (escopo era da transacao).
    const leaked = await db.query<{ value: string | null }>(
      `SELECT current_setting('app.tenant_id', true) AS value`,
    );
    expect(leaked.rows[0]?.value ?? '').toBe('');
  });

  it('o contexto tambem nao vaza quando a transacao anterior falha', async () => {
    await createConversation({ tenantId: tenantB.id });

    await expect(
      db.withTenant(tenantA.id, async (tx) => {
        await tx.query('SELECT 1');
        throw new Error('falha proposital');
      }),
    ).rejects.toThrow('falha proposital');

    const inB = await db.withTenant(tenantB.id, (tx) =>
      tx.query<{ tenant_id: string }>('SELECT tenant_id FROM conversations'),
    );
    expect(inB.rows.map((r) => r.tenant_id)).toEqual([tenantB.id]);
  });

  it('dentro de withTenant a role ativa e crm_app; fora, nao', async () => {
    const inside = await db.withTenant(tenantA.id, (tx) =>
      tx.query<{ role: string }>('SELECT current_user AS role'),
    );
    expect(inside.rows[0]?.role).toBe('crm_app');

    const outside = await db.query<{ role: string }>('SELECT current_user AS role');
    expect(outside.rows[0]?.role).not.toBe('crm_app');
  });

  it('withoutTenant e a excecao auditada: enxerga todos os tenants', async () => {
    await createConversation({ tenantId: tenantA.id });
    await createConversation({ tenantId: tenantB.id });

    const all = await db.withoutTenant((tx) => tx.query('SELECT id FROM conversations'));
    expect(all.rows).toHaveLength(2);
  });
});
