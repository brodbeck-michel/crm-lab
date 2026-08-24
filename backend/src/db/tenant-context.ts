/**
 * Aplicacao do contexto de tenant dentro de uma transacao.
 *
 * Compartilhado pelos dois drivers para que o comportamento seja IDENTICO em
 * teste (PGlite) e em producao (Postgres) — divergencia aqui seria um furo de
 * isolamento que so aparece em producao.
 */
import { APP_DB_ROLE, TENANT_GUC, type DbTx } from './types.js';

/**
 * Camada 3 do isolamento (SECURITY.md).
 *
 * `set_config(..., true)` => escopo da TRANSACAO: o valor some no COMMIT/ROLLBACK.
 * `SET LOCAL ROLE`        => idem, e troca para uma role sem BYPASSRLS e que nao
 *                            e dona das tabelas, de modo que as policies valem.
 *
 * Ordem importa: o `set_config` roda como a role original (que sempre pode
 * escrever o GUC); a troca de role vem depois.
 */
export async function applyTenantContext(tx: DbTx, tenantId: string): Promise<void> {
  await tx.query('SELECT set_config($1, $2, true)', [TENANT_GUC, tenantId]);
  try {
    await tx.query(`SET LOCAL ROLE ${APP_DB_ROLE}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Nao foi possivel assumir a role "${APP_DB_ROLE}". As migracoes que criam a role e as ` +
        `policies RLS precisam ter sido aplicadas (backend/migrations). Causa: ${reason}`,
    );
  }
}
