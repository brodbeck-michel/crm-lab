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
import type { DbClient, DbTx } from '../db/types.js';
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
  /** Teto da FAMÍLIA (CRMLAB-35, D-154) — carregado adiante em cada rotação, nunca reiniciado. */
  absoluteExpiresAt: string;
  /**
   * Por que o token foi revogado (CRMLAB-35, D-154). `'rotated'` = consumido
   * numa rotação normal — reaparecer depois disso é sinal de roubo (D-015).
   * `'security'` = derrubado em massa por troca de senha ou desativação de
   * usuário; reaparecer é o outro dispositivo descobrindo que caiu, não
   * ataque. `null` só em linhas revogadas antes da migração 022 — tratadas
   * como `'rotated'`, que era o comportamento até então.
   */
  revokedReason: RevokedReason | null;
}

export type RevokedReason = 'rotated' | 'security';

interface RefreshTokenRow {
  id: string;
  tenant_id: string;
  user_id: string;
  expires_at: unknown;
  revoked_at: unknown;
  absolute_expires_at: unknown;
  revoked_reason: unknown;
}

function map(row: RefreshTokenRow): RefreshTokenEntity {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    expiresAt: toIso(row.expires_at),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : toIso(row.revoked_at),
    absoluteExpiresAt: toIso(row.absolute_expires_at),
    revokedReason: row.revoked_reason === 'security' ? 'security' : 'rotated',
  };
}

export async function insert(
  tx: DbTx,
  input: {
    tenantId: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    absoluteExpiresAt: Date;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO refresh_tokens (tenant_id, user_id, token_hash, expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.tenantId,
      input.userId,
      input.tokenHash,
      input.expiresAt.toISOString(),
      input.absoluteExpiresAt.toISOString(),
    ],
  );
}

export async function findByHash(
  tx: DbTx,
  tokenHash: string,
): Promise<RefreshTokenEntity | null> {
  const result = await tx.query<RefreshTokenRow>(
    `SELECT id, tenant_id, user_id, expires_at, revoked_at, absolute_expires_at, revoked_reason
       FROM refresh_tokens WHERE token_hash = $1`,
    [tokenHash],
  );
  const row = result.rows[0];
  return row ? map(row) : null;
}

/**
 * Revoga um token especifico — sempre no fluxo de ROTACAO (ou de um token ja
 * vencido saindo de cena). Idempotente: revogar duas vezes nao muda nada.
 * `revoked_reason='rotated'` e o que faz o reuso deste token contar como roubo
 * (D-015); revogacao em massa marca `'security'` e NAO conta (D-154).
 */
export async function revokeByHash(tx: DbTx, tokenHash: string): Promise<number> {
  const result = await tx.query(
    `UPDATE refresh_tokens SET revoked_at = NOW(), revoked_reason = 'rotated'
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
export async function revokeAllForUser(
  tx: DbTx,
  userId: string,
  reason: RevokedReason = 'security',
): Promise<number> {
  const result = await tx.query(
    `UPDATE refresh_tokens SET revoked_at = NOW(), revoked_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason],
  );
  return result.rowCount;
}

/**
 * Troca de senha (CRMLAB-35): revoga todas as famílias do usuário MENOS a da
 * sessão que fez a troca (`exceptTokenHash`). `null` quando a requisição não
 * trouxe o cookie da sessão atual (fallback depreciado sem cookie) — nesse
 * caso revoga TUDO, sem exceção, e a sessão atual desloga junto.
 */
export async function revokeAllForUserExcept(
  tx: DbTx,
  userId: string,
  exceptTokenHash: string | null,
): Promise<number> {
  const result = await tx.query(
    `UPDATE refresh_tokens SET revoked_at = NOW(), revoked_reason = 'security'
      WHERE user_id = $1 AND revoked_at IS NULL
        AND ($2::text IS NULL OR token_hash != $2)`,
    [userId, exceptTokenHash],
  );
  return result.rowCount;
}

/**
 * Limpeza periódica (D-155) — best-effort, chamada pelo `main.ts` no boot e a
 * cada 24h. `withoutTenant` de propósito: manutenção cross-tenant, não serve
 * requisição de tenant nenhum (terceiro uso legítimo, ver `db/types.ts`).
 */
export async function deleteExpiredOrRevoked(db: DbClient): Promise<number> {
  return db.withoutTenant(async (tx) => {
    const result = await tx.query(
      `DELETE FROM refresh_tokens
        WHERE expires_at < NOW() - INTERVAL '7 days'
           OR revoked_at < NOW() - INTERVAL '7 days'`,
    );
    return result.rowCount;
  });
}
