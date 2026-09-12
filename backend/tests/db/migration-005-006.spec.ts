/**
 * Migracao 005/006 — insurances, exam_prices, exam_synonyms + colunas novas em
 * exam_catalog, proposals, proposal_items e tenant_channels (Onda 7).
 *
 * Roda sobre o banco de teste, que aplica TODAS as migracoes de
 * `backend/migrations/*.sql` (D-008). Se 005/006 nao existissem, a suite
 * inteira de `createTestDb()` falharia ao subir — por isso os testes abaixo
 * também servem de prova de que as migracoes aplicam sem erro.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createExam, createTenant, type TenantRecord } from '../helpers/factories.js';

async function columnsOf(db: DbClient, table: string): Promise<Set<string>> {
  const result = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table],
  );
  return new Set(result.rows.map((r) => r.column_name));
}

describe('migração 005/006 — insurances, exam_prices, exam_synonyms', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  it('cria a tabela insurances com as colunas esperadas', async () => {
    const names = await columnsOf(db, 'insurances');
    expect(names).toEqual(
      new Set([
        'id',
        'tenant_id',
        'name',
        'official_name',
        'ans_code',
        'type',
        'is_active',
        'created_at',
        'updated_at',
        'source', // migração 012 (Onda 9, D-114) — coluna nasce depois, banco de teste roda tudo
      ]),
    );
  });

  it('cria a tabela exam_prices com as colunas esperadas', async () => {
    const names = await columnsOf(db, 'exam_prices');
    expect(names).toEqual(
      new Set([
        'id',
        'tenant_id',
        'exam_id',
        'insurance_id',
        'price',
        'created_at',
        'updated_at',
      ]),
    );
  });

  it('cria a tabela exam_synonyms com as colunas esperadas', async () => {
    const names = await columnsOf(db, 'exam_synonyms');
    expect(names).toEqual(
      new Set(['id', 'tenant_id', 'exam_id', 'synonym', 'created_at']),
    );
  });

  it('exam_catalog ganha tuss_code, amb_code, material, source com default manual', async () => {
    const names = await columnsOf(db, 'exam_catalog');
    expect(names.has('tuss_code')).toBe(true);
    expect(names.has('amb_code')).toBe(true);
    expect(names.has('material')).toBe(true);
    expect(names.has('source')).toBe(true);

    const row = await db.query<{ column_default: string }>(
      `SELECT column_default FROM information_schema.columns
       WHERE table_name = 'exam_catalog' AND column_name = 'source'`,
    );
    expect(row.rows[0]?.column_default).toContain('manual');
  });

  it('proposals ganha insurance_id nullable', async () => {
    const names = await columnsOf(db, 'proposals');
    expect(names.has('insurance_id')).toBe(true);
  });

  it('proposal_items ganha price_source com default private', async () => {
    const row = await db.query<{ column_default: string }>(
      `SELECT column_default FROM information_schema.columns
       WHERE table_name = 'proposal_items' AND column_name = 'price_source'`,
    );
    expect(row.rows[0]?.column_default).toContain('private');
  });

  it('tenant_channels ganha connection_mode, accepted_terms_at, accepted_terms_by', async () => {
    const names = await columnsOf(db, 'tenant_channels');
    expect(names.has('connection_mode')).toBe(true);
    expect(names.has('accepted_terms_at')).toBe(true);
    expect(names.has('accepted_terms_by')).toBe(true);

    const row = await db.query<{ column_default: string }>(
      `SELECT column_default FROM information_schema.columns
       WHERE table_name = 'tenant_channels' AND column_name = 'connection_mode'`,
    );
    expect(row.rows[0]?.column_default).toContain('cloud_api');
  });

  it('rejeita insurances.type fora do CHECK', async () => {
    const tenant = await createTenant();
    await expect(
      db.withoutTenant((tx) =>
        tx.query(
          `INSERT INTO insurances (tenant_id, name, type) VALUES ($1, $2, $3)`,
          [tenant.id, 'Convênio Inválido', 'nao_existe'],
        ),
      ),
    ).rejects.toThrow(/check/i);
  });

  it('UNIQUE (tenant_id, name) em insurances impede convênio duplicado no mesmo tenant', async () => {
    const tenant = await createTenant();
    await db.withoutTenant((tx) =>
      tx.query(`INSERT INTO insurances (tenant_id, name, type) VALUES ($1, $2, $3)`, [
        tenant.id,
        'Unimed Tubarão',
        'cooperativa',
      ]),
    );

    await expect(
      db.withoutTenant((tx) =>
        tx.query(`INSERT INTO insurances (tenant_id, name, type) VALUES ($1, $2, $3)`, [
          tenant.id,
          'Unimed Tubarão',
          'cooperativa',
        ]),
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it('UNIQUE (tenant_id, exam_id, insurance_id) em exam_prices impede duplicata', async () => {
    const tenant: TenantRecord = await createTenant();
    const exam = await createExam({ tenantId: tenant.id });
    const insuranceId = randomUUID();
    await db.withoutTenant((tx) =>
      tx.query(`INSERT INTO insurances (id, tenant_id, name, type) VALUES ($1, $2, $3, $4)`, [
        insuranceId,
        tenant.id,
        'Bradesco Saúde',
        'seguradora',
      ]),
    );

    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO exam_prices (tenant_id, exam_id, insurance_id, price) VALUES ($1, $2, $3, $4)`,
        [tenant.id, exam.id, insuranceId, 50.0],
      ),
    );

    await expect(
      db.withoutTenant((tx) =>
        tx.query(
          `INSERT INTO exam_prices (tenant_id, exam_id, insurance_id, price) VALUES ($1, $2, $3, $4)`,
          [tenant.id, exam.id, insuranceId, 55.0],
        ),
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it('UNIQUE (tenant_id, exam_id, synonym) em exam_synonyms impede duplicata', async () => {
    const tenant: TenantRecord = await createTenant();
    const exam = await createExam({ tenantId: tenant.id });

    await db.withoutTenant((tx) =>
      tx.query(`INSERT INTO exam_synonyms (tenant_id, exam_id, synonym) VALUES ($1, $2, $3)`, [
        tenant.id,
        exam.id,
        'HMG',
      ]),
    );

    await expect(
      db.withoutTenant((tx) =>
        tx.query(`INSERT INTO exam_synonyms (tenant_id, exam_id, synonym) VALUES ($1, $2, $3)`, [
          tenant.id,
          exam.id,
          'HMG',
        ]),
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });
});
