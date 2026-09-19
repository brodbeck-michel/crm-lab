/**
 * Runner de migracoes.
 *
 * - As migracoes sao SQL puro em `backend/migrations/*.sql`, aplicadas em ordem
 *   LEXICAL do nome do arquivo (por isso o prefixo numerico: `001_...`).
 * - Cada migracao roda na sua propria transacao: falhou, nada dela fica.
 * - Idempotente: `schema_migrations` guarda o que ja foi aplicado; rodar duas
 *   vezes nao reaplica nada.
 * - Ausencia da pasta ou pasta vazia NAO e erro (o Agent-DB pode ainda nao ter
 *   escrito as migracoes) — apenas retorna lista vazia.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../lib/logger.js';
import { NO_STATEMENT_TIMEOUT, setStatementTimeout } from './statement-timeout.js';
import type { DbClient } from './types.js';

export const MIGRATIONS_TABLE = 'schema_migrations';

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMP DEFAULT NOW()
)`;

/**
 * Descobre `backend/migrations` sem depender do cwd: sobe a partir deste modulo
 * ate achar a raiz do workspace do backend. Funciona tanto rodando via `tsx`
 * (src/db/) quanto compilado (dist/backend/src/db/).
 */
export async function resolveMigrationsDir(): Promise<string> {
  const candidates: string[] = [];
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    candidates.push(path.join(dir, 'migrations'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  candidates.push(path.resolve(process.cwd(), 'migrations'));
  candidates.push(path.resolve(process.cwd(), 'backend/migrations'));

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      /* segue para o proximo candidato */
    }
  }
  // Nenhuma encontrada: devolve o caminho canonico; `listMigrationFiles` trata.
  return path.resolve(process.cwd(), 'migrations');
}

export async function listMigrationFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  return entries.filter((name) => name.toLowerCase().endsWith('.sql')).sort();
}

export interface MigrationResult {
  /** Nomes aplicados NESTA execucao (vazio quando ja estava tudo em dia). */
  applied: string[];
  /** Nomes que ja constavam em `schema_migrations`. */
  skipped: string[];
  directory: string;
}

export async function runMigrations(
  db: DbClient,
  options: { dir?: string } = {},
): Promise<MigrationResult> {
  const dir = options.dir ?? (await resolveMigrationsDir());
  await db.exec(CREATE_TABLE_SQL);

  const files = await listMigrationFiles(dir);
  if (files.length === 0) {
    logger.warn('db.migrations_empty', { directory: dir });
    return { applied: [], skipped: [], directory: dir };
  }

  const existing = await db.query<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE}`);
  const done = new Set(existing.rows.map((r) => r.name));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const name of files) {
    if (done.has(name)) {
      skipped.push(name);
      continue;
    }
    const sql = await fs.readFile(path.join(dir, name), 'utf8');
    if (sql.trim().length === 0) {
      skipped.push(name);
      continue;
    }
    await db.transaction(async (tx) => {
      // CRMLAB-30: o `PgDriver` fixa `statement_timeout=30s` na sessao, o que e
      // certo para request de usuario e perigoso aqui — um `CREATE INDEX` ou um
      // `ALTER TABLE` que reescreve tabela pode passar de 30 s legitimamente, e
      // migracao cortada no meio de um deploy e o pior desfecho possivel.
      // `SET LOCAL` isenta SO esta transacao e e desfeito no COMMIT/ROLLBACK.
      await setStatementTimeout(tx, NO_STATEMENT_TIMEOUT);
      await tx.exec(sql);
      await tx.query(`INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ($1)`, [name]);
    });
    applied.push(name);
    logger.info('db.migration_applied', { name });
  }

  return { applied, skipped, directory: dir };
}

/** Nomes ja aplicados — util para diagnostico e para os testes. */
export async function appliedMigrations(db: DbClient): Promise<string[]> {
  await db.exec(CREATE_TABLE_SQL);
  const result = await db.query<{ name: string }>(
    `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY name`,
  );
  return result.rows.map((r) => r.name);
}
