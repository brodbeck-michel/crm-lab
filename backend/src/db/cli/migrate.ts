#!/usr/bin/env node
/**
 * CLI: `npm run migrate`
 * Aplica as migracoes pendentes de `backend/migrations` no banco corrente.
 */
import { closeDb, getDb } from '../index.js';
import { runMigrations } from '../migrator.js';

async function main(): Promise<void> {
  const db = await getDb();
  const result = await runMigrations(db);

  process.stdout.write(`Migracoes em: ${result.directory}\n`);
  if (result.applied.length === 0) {
    process.stdout.write(
      result.skipped.length === 0
        ? 'Nenhuma migracao encontrada (backend/migrations vazio).\n'
        : `Banco ja atualizado (${result.skipped.length} migracoes aplicadas anteriormente).\n`,
    );
  } else {
    process.stdout.write(`Aplicadas ${result.applied.length}:\n`);
    for (const name of result.applied) process.stdout.write(`  + ${name}\n`);
  }
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    process.stderr.write(`Falha ao migrar: ${err instanceof Error ? err.message : String(err)}\n`);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
