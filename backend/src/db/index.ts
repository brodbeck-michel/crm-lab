/**
 * Ponto unico de acesso ao banco.
 *
 * Escolha do driver (D-008):
 *   NODE_ENV=test  OU  DATABASE_URL ausente  ->  PGlite (em memoria)
 *   caso contrario                            ->  Postgres via `pg`
 *
 * Uso normal:
 *   await db.withTenant(ctx.tenantId, (tx) => tx.query('SELECT ...'));
 */
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import type { DbClient } from './types.js';

export * from './types.js';
export { PgDriver } from './pg-driver.js';
export { PgliteDriver } from './pglite-driver.js';
export { applyTenantContext } from './tenant-context.js';

export function shouldUsePglite(): boolean {
  return env.isTest || !env.DATABASE_URL;
}

/** Cria um cliente novo. Repositorios devem receber o cliente por injecao. */
export async function createDbClient(): Promise<DbClient> {
  if (shouldUsePglite()) {
    const { PgliteDriver } = await import('./pglite-driver.js');
    logger.info('db.driver_selected', { driver: 'pglite' });
    return PgliteDriver.create();
  }
  const { PgDriver } = await import('./pg-driver.js');
  logger.info('db.driver_selected', { driver: 'pg' });
  return new PgDriver(env.DATABASE_URL as string);
}

let singleton: DbClient | null = null;

/** Cliente compartilhado do processo (usado por `main.ts` e pelos CLIs). */
export async function getDb(): Promise<DbClient> {
  singleton ??= await createDbClient();
  return singleton;
}

export async function closeDb(): Promise<void> {
  if (!singleton) return;
  await singleton.close();
  singleton = null;
}
