/**
 * Acesso a tabela `refresh_tokens`.
 *
 * SECURITY.md "Autenticacao": o refresh e guardado HASHEADO e rotacionado a
 * cada uso. Nenhum metodo aqui aceita nem devolve o token em claro — o service
 * passa sempre `hashRefreshToken(token)`.
 *
 * SHA-256 (e nao bcrypt) e o hash certo aqui: o token e um JWT de 256+ bits de
 * entropia gerado pelo servidor, nao uma senha escolhida por humano. Nao ha
 * espaco de busca para forca bruta, e a busca por `token_hash` precisa ser um
 * lookup indexado — com bcrypt seria varredura da tabela inteira.
 */
import { createHash } from 'node:crypto';
import type { DbTx } from '../db/types.js';
import { toIso } from './row-mappers.js';

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface RefreshTokenEntity {
  id: string;
  tenantId: string;
  userId: string;
  expiresAt: string;
  revokedAt: string | null;
}

interface RefreshTokenRow {
  id: string;
  tenant_id: string;
  user_id: string;
  expires_at: unknown;
  revoked_at: unknown;
}

function map(row: RefreshTokenRow): RefreshTokenEntity {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    expiresAt: toIso(row.expires_at),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : toIso(row.revoked_at),
  };
}

export async function insert(
  tx: DbTx,
  input: { tenantId: string; userId: string; tokenHash: string; expiresAt: Date },
): Promise<void> {
  await tx.query(
    `INSERT INTO refresh_tokens (tenant_id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [input.tenantId, input.userId, input.tokenHash, input.expiresAt.toISOString()],
  );
}

export async function findByHash(
  tx: DbTx,
  tokenHash: string,
): Promise<RefreshTokenEntity | null> {
  const result = await tx.query<RefreshTokenRow>(
    `SELECT id, tenant_id, user_id, expires_at, revoked_at
       FROM refresh_tokens WHERE token_hash = $1`,
    [tokenHash],
  );
  const row = result.rows[0];
  return row ? map(row) : null;
}

/** Revoga um token especifico. Idempotente: revogar duas vezes nao muda nada. */
export async function revokeByHash(tx: DbTx, tokenHash: string): Promise<number> {
  const result = await tx.query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash],
  );
  return result.rowCount;
}

/**
 * Deteccao de roubo (D-015): reuso de um refresh ja revogado derruba a FAMILIA
 * inteira — todos os refresh vivos daquele usuario. Sem coluna de familia no
 * schema, a familia e a cadeia de rotacao do usuario, que e o mesmo conjunto.
 */
export async function revokeAllForUser(tx: DbTx, userId: string): Promise<number> {
  const result = await tx.query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return result.rowCount;
}
