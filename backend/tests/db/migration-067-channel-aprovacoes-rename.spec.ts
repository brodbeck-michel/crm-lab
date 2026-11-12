/**
 * Migração 067 — o canal de chave `aprovacoes` passa a se chamar
 * `#avisos-gerais` (CRMLAB-146, D-318). Roda o próprio arquivo da migração e
 * confere: só o nome padrão antigo é trocado, a chave fica, `#geral` e canal
 * já renomeado à mão não mudam, e a segunda execução não faz nada.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, type TenantRecord } from '../helpers/factories.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const SQL_URL = new URL('../../migrations/067_channel_aprovacoes_rename.sql', import.meta.url);

let db: DbClient;
let tenantA: TenantRecord;
let tenantB: TenantRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
});

async function runMigration(): Promise<number> {
  const sql = await readFile(SQL_URL, 'utf8');
  const result = await db.withoutTenant((tx) => tx.query(sql));
  return result.rowCount ?? 0;
}

async function channel(tenantId: string, key: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO internal_channels (id, tenant_id, key, name, kind)
       VALUES ($1, $2, $3, $4, 'channel')`,
      [id, tenantId, key, name],
    ),
  );
  return id;
}

async function row(id: string): Promise<{ key: string; name: string } | undefined> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ key: string; name: string }>(
      'SELECT key, name FROM internal_channels WHERE id = $1',
      [id],
    ),
  );
  return result.rows[0];
}

describe('migração 067', () => {
  it('renomeia #aprovacoes em todos os tenants, mantém a chave e é idempotente', async () => {
    const aprovA = await channel(tenantA.id, 'aprovacoes', '#aprovacoes');
    const aprovB = await channel(tenantB.id, 'aprovacoes', '#aprovacoes');
    const geralA = await channel(tenantA.id, 'geral', '#geral');

    expect(await runMigration()).toBe(2);

    expect(await row(aprovA)).toEqual({ key: 'aprovacoes', name: '#avisos-gerais' });
    expect(await row(aprovB)).toEqual({ key: 'aprovacoes', name: '#avisos-gerais' });
    expect(await row(geralA)).toEqual({ key: 'geral', name: '#geral' });

    expect(await runMigration()).toBe(0);
  });

  it('não mexe em canal que já tem outro nome', async () => {
    const custom = await channel(tenantA.id, 'aprovacoes', '#decisoes');

    expect(await runMigration()).toBe(0);
    expect(await row(custom)).toEqual({ key: 'aprovacoes', name: '#decisoes' });
  });
});
