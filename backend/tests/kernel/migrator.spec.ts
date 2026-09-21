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
  // D-165: a versao anterior deste teste exigia `rolbypassrls: false` e passava
  // verde enquanto a role, na pratica, deixava login e webhook sem NENHUMA
  // linha visivel (medido: 0 de 5 usuarios em homologacao). O teste nao estava
  // frouxo — estava CERTO sobre o atributo e ERRADO sobre o objetivo, que e a
  // pool conseguir rodar os caminhos `withoutTenant()` sem ser superuser. Por
  // isso o teste seguinte, `crm_login enxerga linhas sem contexto de tenant`,
  // e o que realmente protege: ele falha se alguem "endurecer" a role de novo.
  it('cria a role crm_login (LOGIN, sem superuser/createdb/createrole, COM bypassrls), membro de crm_app', async () => {
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
      // BYPASSRLS de proposito (D-165) — ver o comentario acima do teste.
      rolbypassrls: true,
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

  /**
   * D-165 — o teste que faltava, e que teria barrado o 020 original.
   *
   * O ponto do CRMLAB-38 nao e "crm_login tem tal atributo", e sim "a pool
   * consegue rodar os caminhos `withoutTenant()` (login, /platform, webhook,
   * seeds) SEM ser superuser". Conferir atributo nao prova isso; conferir que
   * a role ENXERGA LINHA sem contexto de tenant, prova.
   *
   * Com a role NOBYPASSRLS do 020 original, as duas contagens abaixo davam 0 —
   * exatamente o que aconteceria com login e webhook em producao.
   */
  it('crm_login enxerga linhas sem contexto de tenant (senao login e webhook morrem)', async () => {
    const tenantId = '11111111-1111-1111-1111-111111111111';
    await db.query(
      `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Lab Teste', 'lab-teste')
       ON CONFLICT (id) DO NOTHING`,
      [tenantId],
    );

    const visiveis = await db.transaction(async (tx) => {
      await tx.query(`SET LOCAL ROLE crm_login`);
      const r = await tx.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM tenants`,
      );
      return r.rows[0]?.count ?? 0;
    });
    expect(visiveis).toBeGreaterThan(0);
  });

  /**
   * O outro lado da D-165: BYPASSRLS em `crm_login` nao pode afrouxar o
   * isolamento multitenant (regra critica 1). Quem atende request COM tenant e
   * `crm_app` via `SET LOCAL ROLE` (D-002), e `crm_app` nao tem BYPASSRLS.
   */
  it('crm_app continua sem bypassrls — o isolamento multitenant nao muda', async () => {
    const role = await db.query<{ rolbypassrls: boolean }>(
      `SELECT rolbypassrls FROM pg_roles WHERE rolname = 'crm_app'`,
    );
    expect(role.rows[0]?.rolbypassrls).toBe(false);
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
