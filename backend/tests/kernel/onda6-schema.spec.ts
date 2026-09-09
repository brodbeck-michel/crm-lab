/**
 * Prova das migracoes da Onda 6 (`003_patients_and_channels.sql` +
 * `004_rls_onda6.sql`), com DOIS tenants em PGlite (D-008).
 *
 * Duas coisas independentes sao provadas aqui:
 *
 *  1. **Backfill em base JA POPULADA.** A suite monta um banco isolado com
 *     APENAS 001 e 002 aplicadas, escreve conversas e propostas como se fossem
 *     dados de producao anteriores a Onda 6, e SO ENTAO aplica 003/004 pelo
 *     runner de verdade. E o unico jeito de provar o backfill: no banco de
 *     teste compartilhado as migracoes ja rodaram sobre um banco vazio, onde o
 *     backfill nao tem o que fazer e passaria por vacuidade.
 *
 *  2. **RLS das 4 tabelas novas.** Cross-tenant e fail-closed (0 linhas, nao
 *     erro) — sempre com o controle positivo do lado: a MESMA linha aparece
 *     dentro do proprio tenant e em `withoutTenant()`. Sem esse par, o teste
 *     passaria com a tabela vazia, isto e, com o RLS desligado.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appliedMigrations,
  listMigrationFiles,
  resolveMigrationsDir,
  runMigrations,
  MIGRATIONS_TABLE,
} from '../../src/db/migrator.js';
import { PgliteDriver } from '../../src/db/pglite-driver.js';
import type { DbClient } from '../../src/db/types.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createTenant, createUser, type TenantRecord } from '../helpers/factories.js';

const NEW_TABLES = ['patients', 'tenant_channels', 'tenant_settings', 'channel_reads'] as const;

// ---------------------------------------------------------------------------
// 1. Backfill sobre base pre-existente
// ---------------------------------------------------------------------------

const PHONE_SHARED = '+5548911110000'; // usado pelos DOIS tenants, de proposito
const PHONE_BRUNO = '+5548922220000';

interface LegacyIds {
  tenantA: string;
  tenantB: string;
  convA1: string;
  convA2: string;
  convA3: string;
  convBlank: string;
  convB1: string;
  proposal: string;
  item0: string;
  item1: string;
  item2: string;
}

/** Aplica so as migracoes anteriores a Onda 6, marcando-as como aplicadas. */
async function applyUpTo(db: DbClient, dir: string, upTo: string): Promise<void> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (name TEXT PRIMARY KEY, applied_at TIMESTAMP DEFAULT NOW())`,
  );
  for (const name of await listMigrationFiles(dir)) {
    if (name > upTo) break;
    const sql = await fs.readFile(path.join(dir, name), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query(`INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ($1)`, [name]);
    });
  }
}

/** Dado "de producao" anterior a Onda 6: nenhuma tabela nova existe ainda. */
async function writeLegacyData(db: DbClient): Promise<LegacyIds> {
  const ids: LegacyIds = {
    tenantA: randomUUID(),
    tenantB: randomUUID(),
    convA1: randomUUID(),
    convA2: randomUUID(),
    convA3: randomUUID(),
    convBlank: randomUUID(),
    convB1: randomUUID(),
    proposal: randomUUID(),
    item0: '00000000-0000-4000-8000-0000000000aa',
    item1: '00000000-0000-4000-8000-0000000000bb',
    item2: '00000000-0000-4000-8000-0000000000cc',
  };
  const userA = randomUUID();
  const examA = randomUUID();

  await db.withoutTenant(async (tx) => {
    await tx.query(
      `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Lab A', 'lab-a'), ($2, 'Lab B', 'lab-b')`,
      [ids.tenantA, ids.tenantB],
    );
    await tx.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, name, role, discount_limit_percent)
       VALUES ($1, $2, 'legado@lab-a.local', 'x', 'Legado', 'attendant', 15)`,
      [userA, ids.tenantA],
    );
    await tx.query(
      `INSERT INTO exam_catalog (id, tenant_id, name, code, price_private, price_insurance)
       VALUES ($1, $2, 'Hemograma', 'HEM01', 40, 20)`,
      [examA, ids.tenantA],
    );

    // Conversas: dois registros do MESMO telefone no tenant A (o mais recente
    // tem nome novo e e-mail nulo — o backfill deve pegar o nome novo E o
    // e-mail antigo), um telefone diferente, e um telefone em branco.
    await tx.query(
      `INSERT INTO conversations
         (id, tenant_id, patient_phone, patient_name, patient_email, created_at, last_message_at)
       VALUES
         ($1, $6, $8, 'Ana Antiga', 'ana@antiga.test', NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days'),
         ($2, $6, $8, 'Ana Nova',   NULL,             NOW() - INTERVAL '2 days',  NOW() - INTERVAL '1 day'),
         ($3, $6, $9, 'Bruno',      NULL,             NOW() - INTERVAL '5 days',  NOW() - INTERVAL '5 days'),
         ($4, $6, '   ', 'Sem Telefone', NULL,         NOW() - INTERVAL '3 days',  NOW() - INTERVAL '3 days'),
         ($5, $7, $8, 'Ana do B',   NULL,             NOW() - INTERVAL '4 days',  NOW() - INTERVAL '4 days')`,
      [
        ids.convA1,
        ids.convA2,
        ids.convA3,
        ids.convBlank,
        ids.convB1,
        ids.tenantA,
        ids.tenantB,
        PHONE_SHARED,
        PHONE_BRUNO,
      ],
    );

    await tx.query(
      // Sem `proposal_number`: neste ponto (migracoes so ate 002) a coluna
      // ainda nao existe — o backfill dela (migracao 011, quando `runMigrations`
      // roda mais abaixo) e o que este describe verifica.
      `INSERT INTO proposals (id, tenant_id, conversation_id, created_by, status, total_price)
       VALUES ($1, $2, $3, $4, 'novo_contato', 120)`,
      [ids.proposal, ids.tenantA, ids.convA1, userA],
    );
    // item0 e item1 compartilham `created_at` (desempate estavel por id);
    // item2 e o mais recente e deve ficar por ultimo.
    await tx.query(
      `INSERT INTO proposal_items
         (id, tenant_id, proposal_id, exam_id, quantity, unit_price, exam_name, created_at)
       VALUES
         ($1, $5, $4, $6, 1, 40, 'Hemograma', TIMESTAMP '2026-01-01 10:00:00'),
         ($2, $5, $4, $6, 1, 40, 'Hemograma', TIMESTAMP '2026-01-01 10:00:00'),
         ($3, $5, $4, $6, 1, 40, 'Hemograma', TIMESTAMP '2026-01-01 11:00:00')`,
      [ids.item0, ids.item1, ids.item2, ids.proposal, ids.tenantA, examA],
    );
  });

  return ids;
}

describe('003/004 — backfill sobre base ja populada', () => {
  let db: DbClient;
  let ids: LegacyIds;
  let dir: string;

  beforeAll(async () => {
    dir = await resolveMigrationsDir();
    db = await PgliteDriver.create();
    await applyUpTo(db, dir, '002_row_level_security.sql');
    ids = await writeLegacyData(db);

    // Controle: as tabelas da Onda 6 ainda NAO existem neste ponto.
    const before = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pg_tables
        WHERE schemaname = 'public' AND tablename = ANY($1)`,
      [[...NEW_TABLES]],
    );
    expect(before.rows[0]?.count).toBe(0);

    const result = await runMigrations(db);
    // `arrayContaining`, não igualdade exata: o runner aplica TODAS as
    // migracoes pendentes, e migracoes de ondas futuras (005+) sao esperadas
    // aqui sem quebrar este teste — o que ele prova e que 003/004 aplicaram,
    // não que sejam as únicas migrações do repositório neste ponto do tempo.
    expect(result.applied).toEqual(
      expect.arrayContaining(['003_patients_and_channels.sql', '004_rls_onda6.sql']),
    );
  }, 120_000);

  afterAll(async () => {
    await db.close();
  });

  it('cria exatamente 1 paciente por (tenant, telefone) distinto', async () => {
    const rows = await db.withoutTenant((tx) =>
      tx.query<{ tenant_id: string; phone: string; name: string | null; email: string | null }>(
        `SELECT tenant_id, phone, name, email FROM patients ORDER BY tenant_id, phone`,
      ),
    );

    // 5 conversas -> 3 pacientes: as duas do mesmo telefone no A viram uma so,
    // a de telefone em branco nao vira nenhuma, e o MESMO telefone no B e outro
    // paciente (a unicidade e por tenant, nunca global).
    expect(rows.rows).toHaveLength(3);

    const byTenant = (tenantId: string): typeof rows.rows =>
      rows.rows.filter((r) => r.tenant_id === tenantId);
    expect(byTenant(ids.tenantA).map((r) => r.phone).sort()).toEqual(
      [PHONE_BRUNO, PHONE_SHARED].sort(),
    );
    expect(byTenant(ids.tenantB).map((r) => r.phone)).toEqual([PHONE_SHARED]);

    // Nome vem da conversa mais recente; o e-mail e escolhido de forma
    // INDEPENDENTE, entao a conversa nova sem e-mail nao apaga o que a antiga
    // sabia.
    const anaA = byTenant(ids.tenantA).find((r) => r.phone === PHONE_SHARED);
    expect(anaA?.name).toBe('Ana Nova');
    expect(anaA?.email).toBe('ana@antiga.test');

    const anaB = byTenant(ids.tenantB)[0];
    expect(anaB?.name).toBe('Ana do B');
    expect(anaB?.email).toBeNull();
  });

  it('nenhuma conversa com telefone conhecido fica com patient_id NULL', async () => {
    const orphans = await db.withoutTenant((tx) =>
      tx.query<{ id: string }>(
        `SELECT id FROM conversations
          WHERE btrim(patient_phone) <> '' AND patient_id IS NULL`,
      ),
    );
    expect(orphans.rows).toEqual([]);

    // ...e o vinculo aponta para o paciente do MESMO tenant e telefone.
    const mismatched = await db.withoutTenant((tx) =>
      tx.query<{ id: string }>(
        `SELECT c.id FROM conversations c
           JOIN patients p ON p.id = c.patient_id
          WHERE p.tenant_id <> c.tenant_id OR p.phone <> c.patient_phone`,
      ),
    );
    expect(mismatched.rows).toEqual([]);

    // Conversa de telefone em branco continua sem paciente (nao inventa linha).
    const blank = await db.withoutTenant((tx) =>
      tx.query<{ patient_id: string | null }>(
        `SELECT patient_id FROM conversations WHERE id = $1`,
        [ids.convBlank],
      ),
    );
    expect(blank.rows[0]?.patient_id).toBeNull();

    // As duas conversas do mesmo telefone caem no MESMO paciente.
    const shared = await db.withoutTenant((tx) =>
      tx.query<{ patient_id: string }>(
        `SELECT patient_id FROM conversations WHERE id = ANY($1)`,
        [[ids.convA1, ids.convA2]],
      ),
    );
    expect(new Set(shared.rows.map((r) => r.patient_id)).size).toBe(1);
  });

  it('preenche proposal_items.position preservando a ordem atual', async () => {
    const rows = await db.withoutTenant((tx) =>
      tx.query<{ id: string; position: number }>(
        `SELECT id, "position" FROM proposal_items WHERE proposal_id = $1
          ORDER BY "position" ASC`,
        [ids.proposal],
      ),
    );
    // Ordem = created_at ASC, desempate estavel por id (item0 < item1 < item2).
    expect(rows.rows.map((r) => r.id)).toEqual([ids.item0, ids.item1, ids.item2]);
    expect(rows.rows.map((r) => r.position)).toEqual([0, 1, 2]);
  });

  it('o backfill e idempotente: reaplicar o bloco nao duplica nem reescreve', async () => {
    const sql = await fs.readFile(path.join(dir, '003_patients_and_channels.sql'), 'utf8');
    const start = sql.indexOf('-- 7a.');
    expect(start).toBeGreaterThan(0); // o bloco de backfill existe no arquivo
    const backfill = sql.slice(start);

    const snapshot = async (): Promise<string> => {
      const patients = await db.withoutTenant((tx) =>
        tx.query(
          `SELECT tenant_id, phone, name, email FROM patients ORDER BY tenant_id, phone`,
        ),
      );
      const links = await db.withoutTenant((tx) =>
        tx.query(`SELECT id, patient_id, updated_at FROM conversations ORDER BY id`),
      );
      const positions = await db.withoutTenant((tx) =>
        tx.query(`SELECT id, "position" FROM proposal_items ORDER BY id`),
      );
      return JSON.stringify([patients.rows, links.rows, positions.rows]);
    };

    const before = await snapshot();
    await db.transaction((tx) => tx.exec(backfill));
    const after = await snapshot();

    // Inclusive `conversations.updated_at`: o backfill desliga o trigger porque
    // religar paciente nao e edicao do usuario — se o trigger disparasse, a base
    // inteira passaria a dizer "atualizada agora".
    expect(after).toBe(before);
  });

  it('as 4 tabelas novas nascem sob RLS (nenhuma fica fail-open)', async () => {
    const rows = await db.query<{ tablename: string; rowsecurity: boolean; policies: number }>(
      `SELECT t.tablename,
              t.rowsecurity,
              (SELECT COUNT(*)::int FROM pg_policies p
                WHERE p.schemaname = 'public' AND p.tablename = t.tablename) AS policies
         FROM pg_tables t
        WHERE t.schemaname = 'public' AND t.tablename = ANY($1)
        ORDER BY t.tablename`,
      [[...NEW_TABLES]],
    );
    expect(rows.rows).toHaveLength(NEW_TABLES.length);
    for (const row of rows.rows) {
      expect(row.rowsecurity, `${row.tablename} sem ENABLE ROW LEVEL SECURITY`).toBe(true);
      expect(row.policies, `${row.tablename} sem policy`).toBeGreaterThan(0);
    }
  });
});

describe('migracoes do zero, em ordem lexical', () => {
  it('banco vazio -> todas as migracoes aplicadas na ordem do nome', async () => {
    const dir = await resolveMigrationsDir();
    const files = await listMigrationFiles(dir);
    expect(files).toContain('003_patients_and_channels.sql');
    expect(files).toContain('004_rls_onda6.sql');

    const db = await PgliteDriver.create();
    try {
      const result = await runMigrations(db, { dir });
      expect(result.applied).toEqual([...files].sort());
      expect(await appliedMigrations(db)).toEqual([...files].sort());

      const tables = await db.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM pg_tables
          WHERE schemaname = 'public' AND tablename = ANY($1)`,
        [[...NEW_TABLES]],
      );
      expect(tables.rows[0]?.count).toBe(NEW_TABLES.length);
    } finally {
      await db.close();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 2. RLS das tabelas da Onda 6, com 2 tenants
// ---------------------------------------------------------------------------

describe('RLS das tabelas da Onda 6 — 2 tenants', () => {
  let db: DbClient;
  let tenantA: TenantRecord;
  let tenantB: TenantRecord;
  let userA: string;
  let userB: string;
  let channelA: string;
  let channelB: string;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    tenantA = await createTenant({ name: 'Lab A' });
    tenantB = await createTenant({ name: 'Lab B' });
    userA = (await createUser({ tenantId: tenantA.id })).id;
    userB = (await createUser({ tenantId: tenantB.id })).id;
    channelA = randomUUID();
    channelB = randomUUID();

    await db.withoutTenant(async (tx) => {
      await tx.query(
        `INSERT INTO internal_channels (id, tenant_id, key, name)
         VALUES ($1, $3, 'geral', '#geral'), ($2, $4, 'geral', '#geral')`,
        [channelA, channelB, tenantA.id, tenantB.id],
      );
      // Uma linha de cada tabela nova, para CADA tenant.
      await tx.query(
        `INSERT INTO patients (tenant_id, phone, name)
         VALUES ($1, '+5548900000001', 'Paciente A'), ($2, '+5548900000002', 'Paciente B')`,
        [tenantA.id, tenantB.id],
      );
      await tx.query(
        `INSERT INTO tenant_channels (tenant_id, channel, phone_number, api_token)
         VALUES ($1, 'whatsapp', '+5548911111111', 'tok-a'),
                ($2, 'whatsapp', '+5548922222222', 'tok-b')`,
        [tenantA.id, tenantB.id],
      );
      await tx.query(
        `INSERT INTO tenant_settings (tenant_id, distribution_mode)
         VALUES ($1, 'round_robin'), ($2, 'manual')`,
        [tenantA.id, tenantB.id],
      );
      await tx.query(
        `INSERT INTO channel_reads (tenant_id, channel_id, user_id)
         VALUES ($1, $3, $5), ($2, $4, $6)`,
        [tenantA.id, tenantB.id, channelA, channelB, userA, userB],
      );
    });
  });

  it('cada tabela nova ve a propria linha e NAO ve a do outro tenant', async () => {
    for (const table of NEW_TABLES) {
      // Controle positivo: a linha de B existe mesmo (senao o teste abaixo
      // passaria com a tabela vazia, isto e, com o RLS desligado).
      const all = await db.withoutTenant((tx) =>
        tx.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${table}`),
      );
      expect(all.rows, `${table}: cenario deveria ter 1 linha por tenant`).toHaveLength(2);

      const seenByA = await db.withTenant(tenantA.id, (tx) =>
        tx.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${table}`),
      );
      expect(seenByA.rows.map((r) => r.tenant_id), `${table} vazou para o tenant A`).toEqual([
        tenantA.id,
      ]);

      const seenByB = await db.withTenant(tenantB.id, (tx) =>
        tx.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${table}`),
      );
      expect(seenByB.rows.map((r) => r.tenant_id), `${table} vazou para o tenant B`).toEqual([
        tenantB.id,
      ]);
    }
  });

  it('buscar por id de linha do outro tenant volta VAZIO, nao erro (vira 404)', async () => {
    const patientOfB = await db.withoutTenant((tx) =>
      tx.query<{ id: string }>(`SELECT id FROM patients WHERE tenant_id = $1`, [tenantB.id]),
    );
    const idOfB = patientOfB.rows[0]?.id;
    expect(idOfB).toBeTruthy();

    const found = await db.withTenant(tenantA.id, (tx) =>
      tx.query(`SELECT id FROM patients WHERE id = $1`, [idOfB]),
    );
    expect(found.rows).toHaveLength(0);
  });

  it('UPDATE e DELETE nao alcancam a linha do outro tenant', async () => {
    const updated = await db.withTenant(tenantA.id, (tx) =>
      tx.query(`UPDATE patients SET name = 'invadido' WHERE tenant_id = $1`, [tenantB.id]),
    );
    expect(updated.rowCount).toBe(0);

    const deleted = await db.withTenant(tenantA.id, (tx) =>
      tx.query(`DELETE FROM tenant_channels WHERE tenant_id = $1`, [tenantB.id]),
    );
    expect(deleted.rowCount).toBe(0);

    const survived = await db.withoutTenant((tx) =>
      tx.query<{ name: string }>(`SELECT name FROM patients WHERE tenant_id = $1`, [tenantB.id]),
    );
    expect(survived.rows[0]?.name).toBe('Paciente B');
  });

  it('INSERT com tenant_id alheio e rejeitado pelo WITH CHECK', async () => {
    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query(`INSERT INTO patients (tenant_id, phone, name) VALUES ($1, $2, $3)`, [
          tenantB.id,
          '+5548933333333',
          'Invasor',
        ]),
      ),
    ).rejects.toThrow(/row-level security|policy/i);

    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tenantB.id]),
      ),
    ).rejects.toThrow(/row-level security|policy/i);
  });

  it('channel_reads: nem canal nem usuario do outro tenant entram com o meu tenant_id', async () => {
    // tenant_id "certo" (o meu), canal do OUTRO: linha valida para as FKs e
    // atravessando a fronteira — e o que o EXISTS da policy impede.
    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query(
          `INSERT INTO channel_reads (tenant_id, channel_id, user_id) VALUES ($1, $2, $3)`,
          [tenantA.id, channelB, userA],
        ),
      ),
    ).rejects.toThrow(/row-level security|policy/i);

    // tenant_id e canal meus, usuario do OUTRO tenant.
    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query(
          `INSERT INTO channel_reads (tenant_id, channel_id, user_id) VALUES ($1, $2, $3)`,
          [tenantA.id, channelA, userB],
        ),
      ),
    ).rejects.toThrow(/row-level security|policy/i);

    // Controle positivo: a MESMA forma de INSERT passa quando tudo e do tenant.
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO internal_channels (id, tenant_id, key, name)
         VALUES ($1, $2, 'aprovacoes', '#aprovacoes')`,
        [randomUUID(), tenantA.id],
      ),
    );
    const secondChannel = await db.withoutTenant((tx) =>
      tx.query<{ id: string }>(
        `SELECT id FROM internal_channels WHERE tenant_id = $1 AND key = 'aprovacoes'`,
        [tenantA.id],
      ),
    );
    await expect(
      db.withTenant(tenantA.id, (tx) =>
        tx.query(
          `INSERT INTO channel_reads (tenant_id, channel_id, user_id) VALUES ($1, $2, $3)`,
          [tenantA.id, secondChannel.rows[0]?.id, userA],
        ),
      ),
    ).resolves.toBeDefined();
  });

  it('quem le no contexto de A nunca alcanca o paciente de B pelo patient_id', async () => {
    // Caminho real do produto: a ficha e resolvida por JOIN dentro do contexto
    // do tenant. Mesmo se um vinculo cross-tenant existisse na coluna (a FK e
    // verificada FORA do RLS — limitacao conhecida, igual a `assigned_to`), o
    // JOIN sob a policy de `patients` nao devolve a linha do outro laboratorio.
    const patientOfB = await db.withoutTenant((tx) =>
      tx.query<{ id: string }>(`SELECT id FROM patients WHERE tenant_id = $1`, [tenantB.id]),
    );
    const conversationId = randomUUID();
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO conversations (id, tenant_id, patient_phone, patient_name, patient_id)
         VALUES ($1, $2, '+5548944444444', 'Conversa A', $3)`,
        [conversationId, tenantA.id, patientOfB.rows[0]?.id],
      ),
    );

    const joined = await db.withTenant(tenantA.id, (tx) =>
      tx.query<{ name: string }>(
        `SELECT p.name FROM conversations c
           JOIN patients p ON p.id = c.patient_id
          WHERE c.id = $1`,
        [conversationId],
      ),
    );
    expect(joined.rows).toEqual([]);

    // Controle positivo: o mesmo JOIN devolve a linha quando o paciente e do
    // proprio tenant.
    const patientOfA = await db.withoutTenant((tx) =>
      tx.query<{ id: string }>(`SELECT id FROM patients WHERE tenant_id = $1`, [tenantA.id]),
    );
    await db.withoutTenant((tx) =>
      tx.query(`UPDATE conversations SET patient_id = $1 WHERE id = $2`, [
        patientOfA.rows[0]?.id,
        conversationId,
      ]),
    );
    const ok = await db.withTenant(tenantA.id, (tx) =>
      tx.query<{ name: string }>(
        `SELECT p.name FROM conversations c
           JOIN patients p ON p.id = c.patient_id
          WHERE c.id = $1`,
        [conversationId],
      ),
    );
    expect(ok.rows.map((r) => r.name)).toEqual(['Paciente A']);
  });
});
