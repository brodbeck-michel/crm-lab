#!/usr/bin/env node
/**
 * CLI: `npm run seed` (e `npm run seed:e2e`).
 *
 * Os seeds em si sao do Agent-DB (`src/db/seeds/index.ts`, que exporta
 * `seed(db, options)`). Este CLI apenas garante o schema e delega. Enquanto o
 * modulo nao existir, imprime a mensagem e sai com sucesso — import dinamico
 * dentro de try/catch, para nao quebrar o typecheck do kernel.
 */
import { closeDb, getDb } from '../index.js';
import { runMigrations } from '../migrator.js';
import type { DbClient } from '../types.js';

export interface SeedOptions {
  /** `npm run seed:e2e` passa `--e2e`: dataset deterministico para o Playwright. */
  e2e: boolean;
}

type SeedModule = { seed?: (db: DbClient, options: SeedOptions) => Promise<void> };

/**
 * Especificador em VARIAVEL de proposito: o modulo ainda nao existe, e um
 * literal faria o typecheck falhar com TS2307. Quando o Agent-DB criar
 * `src/db/seeds/index.ts` nada aqui precisa mudar.
 */
const SEEDS_MODULE = '../seeds/index.js';

async function loadSeedModule(): Promise<SeedModule | null> {
  try {
    return (await import(SEEDS_MODULE)) as SeedModule;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const options: SeedOptions = { e2e: process.argv.includes('--e2e') };
  const db = await getDb();
  await runMigrations(db);

  const mod = await loadSeedModule();
  if (!mod?.seed) {
    process.stdout.write(
      'Seeds ainda nao implementados.\n' +
        'Esperado: backend/src/db/seeds/index.ts exportando ' +
        '`export async function seed(db: DbClient, options: { e2e: boolean }): Promise<void>`.\n' +
        'Responsavel: Agent-DB (docs/STATUS.md, Onda 2 "Seeds de desenvolvimento").\n',
    );
    return;
  }

  await mod.seed(db, options);
  process.stdout.write(`Seeds aplicados${options.e2e ? ' (dataset e2e)' : ''}.\n`);
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    process.stderr.write(
      `Falha ao rodar seeds: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
