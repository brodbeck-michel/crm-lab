/**
 * Acesso a tabela `password_reset_tokens` (CRMLAB-39, D-172).
 *
 * Mesma logica de `refresh-token.repository.ts`: o token de alta entropia
 * nunca e guardado em claro, so o hash SHA-256 (lookup indexado, sem espaco de
 * busca util para forca bruta — o token e gerado pelo servidor, nao escolhido
 * por humano).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { DbClient, DbTx } from '../db/types.js';
import { toIso, toIsoOrNull } from './row-mappers.js';

/** 32 bytes = 256 bits de entropia, o mesmo patamar do refresh token (JWT). */
export function generateResetToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface PasswordResetTokenEntity {
  id: string;
  tenantId: string;
  userId: string;
  expiresAt: string;
  usedAt: string | null;
}

interface PasswordResetTokenRow {
  id: string;
  tenant_id: string;
  user_id: string;
  expires_at: unknown;
  used_at: unknown;
}

function map(row: PasswordResetTokenRow): PasswordResetTokenEntity {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    expiresAt: toIso(row.expires_at),
    usedAt: toIsoOrNull(row.used_at),
  };
}

export async function insert(
  tx: DbTx,
  input: { tenantId: string; userId: string; tokenHash: string; expiresAt: Date },
): Promise<void> {
  await tx.query(
    `INSERT INTO password_reset_tokens (tenant_id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [input.tenantId, input.userId, input.tokenHash, input.expiresAt.toISOString()],
  );
}

export async function findByHash(
  tx: DbTx,
  tokenHash: string,
): Promise<PasswordResetTokenEntity | null> {
  const result = await tx.query<PasswordResetTokenRow>(
    `SELECT id, tenant_id, user_id, expires_at, used_at
       FROM password_reset_tokens WHERE token_hash = $1`,
    [tokenHash],
  );
  const row = result.rows[0];
  return row ? map(row) : null;
}

/** Marca como usado. Idempotente por construcao: `resetPassword` so chama uma vez. */
export async function markUsed(tx: DbTx, id: string): Promise<void> {
  await tx.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1`, [id]);
}

/**
 * Invalida qualquer token de reset ainda vivo do usuario (nao usado, nao
 * vencido) ANTES de emitir um novo — um pedido novo de "esqueci minha senha"
 * torna o link anterior, se ainda nao aberto, obsoleto.
 */
export async function invalidateAllForUser(tx: DbTx, userId: string): Promise<number> {
  const result = await tx.query(
    `UPDATE password_reset_tokens SET used_at = NOW()
      WHERE user_id = $1 AND used_at IS NULL AND expires_at > NOW()`,
    [userId],
  );
  return result.rowCount;
}

/**
 * Limpeza periodica, mesmo padrao de `refresh-token.repository.ts` (D-155):
 * best-effort, chamada pelo `main.ts` no boot e a cada 24h.
 */
export async function deleteExpiredOrUsed(db: DbClient): Promise<number> {
  return db.withoutTenant(async (tx) => {
    const result = await tx.query(
      `DELETE FROM password_reset_tokens
        WHERE expires_at < NOW() - INTERVAL '7 days'
           OR used_at < NOW() - INTERVAL '7 days'`,
    );
    return result.rowCount;
  });
}
