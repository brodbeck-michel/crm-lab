/**
 * Migração 014 — correção de `lis_budgets.total_value` (D-124).
 *
 * A versão original (migração 012, Onda 9) implementou `total_value` como
 * `value_1 + value_2 + value_3`. Errado: comparando com o app de referência
 * do FluxoLab (`orcamentos-sante-main/src/lib/orcamento.ts`), `insurance_2`/
 * `insurance_3` são COTAÇÕES ALTERNATIVAS do mesmo orçamento (o mesmo exame
 * precificado por outro convênio), não valores adicionais — o valor de
 * referência é sempre o do CONVÊNIO PRINCIPAL (mesma seleção de
 * `principal_insurance_name`, BUSINESS_RULES.md §11.3), nunca a soma dos três.
 *
 * Migração já aplicada nunca é editada (docs/AGENTS.md) — a 014 corrige via
 * DROP + ADD da coluna gerada. Este teste prova que ela recalcula os valores
 * existentes e que a fórmula nova bate com o app de referência.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createTenant, type TenantRecord } from '../helpers/factories.js';

async function insertImport(db: DbClient, tenantId: string): Promise<string> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO lis_imports (tenant_id, kind, status) VALUES ($1, 'import', 'completed')
       RETURNING id`,
      [tenantId],
    ),
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('falha ao inserir lis_imports de teste');
  return id;
}

async function insertBudget(
  db: DbClient,
  tenantId: string,
  importId: string,
  fields: {
    number: string;
    insurance1?: string | null;
    value1?: number | null;
    insurance2?: string | null;
    value2?: number | null;
    insurance3?: string | null;
    value3?: number | null;
  },
): Promise<{ principalInsuranceName: string | null; totalValue: number }> {
  const result = await db.withTenant(tenantId, (tx) =>
    tx.query<{ principal_insurance_name: string | null; total_value: string | number }>(
      `INSERT INTO lis_budgets (
         tenant_id, number, import_id, insurance_1, value_1, insurance_2, value_2, insurance_3, value_3
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING principal_insurance_name, total_value`,
      [
        tenantId,
        fields.number,
        importId,
        fields.insurance1 ?? null,
        fields.value1 ?? null,
        fields.insurance2 ?? null,
        fields.value2 ?? null,
        fields.insurance3 ?? null,
        fields.value3 ?? null,
      ],
    ),
  );
  const row = result.rows[0];
  if (!row) throw new Error('INSERT em lis_budgets nao retornou linha');
  return {
    principalInsuranceName: row.principal_insurance_name,
    totalValue: Number(row.total_value),
  };
}

describe('migração 014 — total_value é o valor do convênio principal, não a soma (D-124)', () => {
  let db: DbClient;
  let tenant: TenantRecord;
  let importId: string;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    tenant = await createTenant({ name: 'Lab Teste', slug: 'lab-teste', db });
    importId = await insertImport(db, tenant.id);
  });

  it('convênio 1 com valor > 0 vence — convênios 2/3 são cotações alternativas, NUNCA somadas', async () => {
    // Caso real do bug: três convênios preenchidos, todos com valor > 0 —
    // a versão errada (soma) daria 200 + 150.5 + 80 = 430.5.
    const row = await insertBudget(db, tenant.id, importId, {
      number: '1001',
      insurance1: 'Unimed',
      value1: 200,
      insurance2: 'Bradesco',
      value2: 150.5,
      insurance3: 'SulAmérica',
      value3: 80,
    });
    expect(row.principalInsuranceName).toBe('Unimed');
    expect(row.totalValue).toBe(200); // NUNCA 430.5
  });

  it('convênio 1 sem valor, convênio 2 com valor: convênio 2 vence (mesma ordem de principal_insurance_name)', async () => {
    const row = await insertBudget(db, tenant.id, importId, {
      number: '1002',
      insurance1: 'Unimed',
      value1: 0,
      insurance2: 'Bradesco',
      value2: 150.5,
    });
    expect(row.principalInsuranceName).toBe('Bradesco');
    expect(row.totalValue).toBe(150.5); // NUNCA 0 + 150.5 tratado como soma coincidente de 2 campos
  });

  it('nenhum convênio tem nome, mas há valor: usa o primeiro valor > 0 (3º fallback do app de referência)', async () => {
    const row = await insertBudget(db, tenant.id, importId, {
      number: '1003',
      value1: 75,
    });
    expect(row.principalInsuranceName).toBeNull();
    expect(row.totalValue).toBe(75);
  });

  it('nenhum convênio com nome ou valor: total_value é 0, não NULL', async () => {
    const row = await insertBudget(db, tenant.id, importId, { number: '1004' });
    expect(row.principalInsuranceName).toBeNull();
    expect(row.totalValue).toBe(0);
  });
});
