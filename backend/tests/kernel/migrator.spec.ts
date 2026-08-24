import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appliedMigrations, listMigrationFiles, resolveMigrationsDir, runMigrations } from '../../src/db/migrator.js';
import { PgliteDriver } from '../../src/db/pglite-driver.js';
import type { DbClient } from '../../src/db/types.js';

describe('migrator', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await PgliteDriver.create();
  });

  afterAll(async () => {
    await db.close();
  });

  it('acha backend/migrations e enxerga arquivos .sql em ordem lexical', async () => {
    const dir = await resolveMigrationsDir();
    const files = await listMigrationFiles(dir);
    expect(files.length).toBeGreaterThan(0);
    expect(files).toEqual([...files].sort());
    expect(files.every((f) => f.endsWith('.sql'))).toBe(true);
  });

  it('aplica as migracoes e e idempotente: rodar 2x nao reaplica nem quebra', async () => {
    const first = await runMigrations(db);
    expect(first.applied.length).toBeGreaterThan(0);
    expect(first.skipped).toEqual([]);

    const second = await runMigrations(db);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(first.applied);

    const third = await runMigrations(db);
    expect(third.applied).toEqual([]);

    expect(await appliedMigrations(db)).toEqual([...first.applied].sort());
  });

  it('cria a tabela de controle schema_migrations', async () => {
    const result = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'schema_migrations'`,
    );
    expect(result.rows[0]?.count).toBe(1);
  });

  it('cria a role de aplicacao crm_app (NOLOGIN, sem BYPASSRLS)', async () => {
    const result = await db.query<{ rolcanlogin: boolean; rolbypassrls: boolean }>(
      `SELECT rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = 'crm_app'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.rolcanlogin).toBe(false);
    expect(result.rows[0]?.rolbypassrls).toBe(false);
  });

  it('pasta inexistente nao quebra o runner', async () => {
    const result = await runMigrations(db, { dir: '/caminho/que/nao/existe' });
    expect(result.applied).toEqual([]);
  });
});
