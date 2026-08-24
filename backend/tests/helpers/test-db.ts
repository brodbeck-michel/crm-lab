/**
 * Banco de teste: PGlite em memoria com TODAS as migracoes aplicadas (D-008).
 *
 * Uso tipico:
 *
 *   import { getTestDb, resetDatabase } from '../helpers/test-db.js';
 *
 *   beforeAll(async () => { db = await getTestDb(); });
 *   beforeEach(async () => { await resetDatabase(); });
 *
 * A instancia e cacheada POR PROCESSO: subir o WASM e rodar as migracoes custa
 * alguns segundos, entao paga-se uma vez. `resetDatabase()` limpa os dados
 * (TRUNCATE ... CASCADE) mantendo o schema — e o que isola um teste do outro.
 */
import { PgliteDriver } from '../../src/db/pglite-driver.js';
import { runMigrations } from '../../src/db/migrator.js';
import { MIGRATIONS_TABLE } from '../../src/db/migrator.js';
import type { DbClient } from '../../src/db/types.js';

let instance: DbClient | null = null;
let booting: Promise<DbClient> | null = null;

async function boot(): Promise<DbClient> {
  const db = await PgliteDriver.create();
  const result = await runMigrations(db);
  if (result.applied.length === 0 && result.skipped.length === 0) {
    throw new Error(
      `Nenhuma migracao encontrada em ${result.directory}. ` +
        'Os testes de banco dependem de backend/migrations/*.sql (Agent-DB).',
    );
  }
  instance = db;
  return db;
}

/** Cliente compartilhado do processo de teste. */
export async function getTestDb(): Promise<DbClient> {
  if (instance) return instance;
  booting ??= boot();
  return booting;
}

/**
 * Cria um banco NOVO e isolado (schema proprio, migracoes do zero).
 * Use so quando o teste precisar mexer no schema; o normal e `getTestDb()`.
 */
export async function createIsolatedTestDb(): Promise<DbClient> {
  const db = await PgliteDriver.create();
  await runMigrations(db);
  return db;
}

/** Tabelas de dados (tudo menos o controle de migracoes). */
async function dataTables(db: DbClient): Promise<string[]> {
  const result = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> $1`,
    [MIGRATIONS_TABLE],
  );
  return result.rows.map((r) => r.tablename);
}

/**
 * Zera os dados mantendo o schema. Roda como dono das tabelas (sem contexto de
 * tenant), portanto o RLS nao interfere.
 */
export async function resetDatabase(db?: DbClient): Promise<void> {
  const client = db ?? (await getTestDb());
  const tables = await dataTables(client);
  if (tables.length === 0) return;
  const quoted = tables.map((t) => `"${t}"`).join(', ');
  await client.exec(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
}

/** Fecha a instancia cacheada (afterAll de suites que sobem banco proprio). */
export async function closeTestDb(): Promise<void> {
  if (!instance) return;
  await instance.close();
  instance = null;
  booting = null;
}
