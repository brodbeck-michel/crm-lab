/**
 * Migração 063 — token da Meta muda para `cloud_api_token` (CRMLAB-138, D-308
 * item 3). Roda o próprio arquivo sobre linhas no estado de antes da 063 e
 * confere: `cloud_api` com token (ou revogado com `''`) muda de coluna e
 * `api_token` fica NULL; `qr` (a apikey do Evolution, caso do Santé) e os
 * outros canais não mudam; a segunda execução não mexe em nada.
 */
import { readFile } from 'node:fs/promises';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { createTenant } from '../helpers/factories.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const SQL_URL = new URL('../../migrations/063_channel_waba_id.sql', import.meta.url);

let db: DbClient;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
});

async function runMigration(): Promise<void> {
  const sql = await readFile(SQL_URL, 'utf8');
  // Um comando por chamada: o PGlite nao aceita varios num prepared statement.
  const statements = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  await db.withoutTenant(async (tx) => {
    for (const statement of statements) await tx.query(statement);
  });
}

/** Linha como estava antes da 063: tudo em `api_token`, `cloud_api_token` NULL. */
async function legacyRow(
  slug: string,
  channel: string,
  mode: 'cloud_api' | 'qr',
  apiToken: string | null,
): Promise<string> {
  const tenant = await createTenant({ slug, db });
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO tenant_channels (tenant_id, channel, connection_mode, api_token, cloud_api_token)
       VALUES ($1, $2, $3, $4, NULL)`,
      [tenant.id, channel, mode, apiToken],
    ),
  );
  return tenant.id;
}

async function tokensOf(tenantId: string, channel = 'whatsapp') {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ api_token: string | null; cloud_api_token: string | null }>(
      `SELECT api_token, cloud_api_token FROM tenant_channels WHERE tenant_id = $1 AND channel = $2`,
      [tenantId, channel],
    ),
  );
  return result.rows[0];
}

describe('migração 063', () => {
  it('move só o token da Meta das linhas cloud_api, e é idempotente', async () => {
    const cloud = await legacyRow('lab-cloud', 'whatsapp', 'cloud_api', 'enc:v1:token-da-meta');
    const revogado = await legacyRow('lab-revogado', 'whatsapp', 'cloud_api', '');
    const nunca = await legacyRow('lab-nunca', 'whatsapp', 'cloud_api', null);
    const qr = await legacyRow('lab-qr', 'whatsapp', 'qr', 'enc:v1:apikey-evolution');
    const sms = await legacyRow('lab-sms', 'sms', 'cloud_api', 'enc:v1:token-sms');

    await runMigration();

    expect(await tokensOf(cloud)).toEqual({ api_token: null, cloud_api_token: 'enc:v1:token-da-meta' });
    // Revogado continua revogado (`''`), só que na coluna nova.
    expect(await tokensOf(revogado)).toEqual({ api_token: null, cloud_api_token: '' });
    expect(await tokensOf(nunca)).toEqual({ api_token: null, cloud_api_token: null });
    expect(await tokensOf(qr)).toEqual({ api_token: 'enc:v1:apikey-evolution', cloud_api_token: null });
    expect(await tokensOf(sms, 'sms')).toEqual({ api_token: 'enc:v1:token-sms', cloud_api_token: null });

    await runMigration();
    expect(await tokensOf(cloud)).toEqual({ api_token: null, cloud_api_token: 'enc:v1:token-da-meta' });
    expect(await tokensOf(qr)).toEqual({ api_token: 'enc:v1:apikey-evolution', cloud_api_token: null });
  });
});
