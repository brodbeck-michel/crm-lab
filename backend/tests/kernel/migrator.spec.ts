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

  // CRMLAB-38 item 1 (D-145): cria a role que a POOL deveria usar no lugar do
  // superuser. Nao testamos "conectar como crm_login e tentar DROP TABLE"
  // aqui: o PGlite deste arquivo conecta com UM usuario fixo (nao dá para
  // reconectar como outra role sem mudar a infra de teste — D-008 fixa o
  // driver, não a identidade da conexão), e o Postgres real do compose
  // também conecta como o superusuário do container até a troca manual de
  // `DATABASE_URL` na VPS (pendência registrada em docs/STATUS.md). O que dá
  // para provar aqui — e o que importa de verdade sobre a MIGRAÇÃO em si,
  // não sobre a infra em volta — é que o `GRANT`/`CREATE ROLE` produziu os
  // atributos certos.
  it('cria a role crm_login (LOGIN, sem superuser/bypassrls/createdb), membro de crm_app', async () => {
    const role = await db.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
    }>(
      `SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
       FROM pg_roles WHERE rolname = 'crm_login'`,
    );
    expect(role.rows).toHaveLength(1);
    expect(role.rows[0]).toEqual({
      rolcanlogin: true,
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });

    const membership = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM pg_auth_members m
       JOIN pg_roles member ON member.oid = m.member
       JOIN pg_roles grp ON grp.oid = m.roleid
       WHERE member.rolname = 'crm_login' AND grp.rolname = 'crm_app'`,
    );
    expect(membership.rows[0]?.count).toBe(1);
  });

  // CRMLAB-38 item 2 (D-146): as 15 FKs sem indice apontadas na auditoria.
  it('cria indice nas 15 FKs apontadas pela auditoria (CRMLAB-38)', async () => {
    const expected = [
      'idx_messages_sender_id',
      'idx_proposals_created_by',
      'idx_proposals_approved_by',
      'idx_proposals_insurance_id',
      'idx_proposal_items_exam_id',
      'idx_proposal_status_history_changed_by',
      'idx_audit_logs_user_id',
      'idx_internal_messages_sender_id',
      'idx_internal_messages_attached_proposal_id',
      'idx_tenant_channels_accepted_terms_by',
      'idx_quick_replies_created_by',
      'idx_message_media_message_id',
      'idx_lis_imports_created_by',
      'idx_lis_budgets_insurance_id',
      'idx_lis_budgets_import_id',
    ];
    const result = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname = ANY($1)`,
      [expected],
    );
    expect(result.rows.map((r) => r.indexname).sort()).toEqual([...expected].sort());
  });
});
