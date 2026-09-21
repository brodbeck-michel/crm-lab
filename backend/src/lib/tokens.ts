/**
 * Emissao e verificacao de JWT.
 *
 * Camada 1 do isolamento multitenant (SECURITY.md): o `tenantId` vive DENTRO do
 * token assinado. Nenhum header, query ou body do cliente pode alterar o tenant.
 */
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { JwtPayload, UserRole } from '@crm-lab/shared';
import { env } from '../config/env.js';

export type VerifyFailure = 'expired' | 'invalid';

export type VerifyResult =
  | { ok: true; payload: JwtPayload }
  | { ok: false; reason: VerifyFailure };

export interface AccessTokenClaims {
  userId: string;
  tenantId: string;
  role: UserRole;
  discountLimit: number;
}

export function signAccessToken(claims: AccessTokenClaims, ttlSeconds = env.JWT_ACCESS_TTL): string {
  return jwt.sign(claims, env.JWT_SECRET, { expiresIn: ttlSeconds });
}

/** Claims minimas de um refresh token. `role` e obrigatorio porque `verifyWith` o exige. */
export type RefreshTokenClaims = Pick<AccessTokenClaims, 'userId' | 'tenantId' | 'role'>;

/**
 * Emite um refresh token.
 *
 * Duas invariantes que ficam AQUI, e nao no ponto de chamada, para que nenhum
 * caminho futuro possa esquece-las:
 *
 * - `role` e obrigatorio na assinatura. Sem ele, `verifyWith` rejeita o token
 *   como invalido e o proprio sistema recusa o refresh que acabou de emitir.
 * - `jti` (nonce) e gerado internamente. Dois `jwt.sign` com as mesmas claims no
 *   mesmo segundo produzem a MESMA string (`iat` tem resolucao de 1s); sem o
 *   nonce, rotacionar logo apos o login colidiria com o UNIQUE de
 *   `refresh_tokens.token_hash`.
 */
export function signRefreshToken(
  claims: RefreshTokenClaims,
  ttlSeconds = env.JWT_REFRESH_TTL,
): string {
  return jwt.sign(
    { userId: claims.userId, tenantId: claims.tenantId, role: claims.role, jti: randomUUID() },
    env.JWT_REFRESH_SECRET,
    { expiresIn: ttlSeconds },
  );
}

function verifyWith(token: string, secret: string): VerifyResult {
  try {
    // `algorithms` explicito (CRMLAB-35): `jsonwebtoken` 9 ja restringe por
    // padrao a HMAC quando o secret e string, mas explicito e defesa em
    // profundidade contra downgrade de algoritmo se a lib mudar de comportamento.
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (typeof decoded === 'string' || decoded === null) return { ok: false, reason: 'invalid' };
    const payload = decoded as Partial<JwtPayload>;
    if (
      typeof payload.userId !== 'string' ||
      typeof payload.tenantId !== 'string' ||
      typeof payload.role !== 'string'
    ) {
      return { ok: false, reason: 'invalid' };
    }
    return {
      ok: true,
      payload: {
        userId: payload.userId,
        tenantId: payload.tenantId,
        role: payload.role,
        discountLimit: typeof payload.discountLimit === 'number' ? payload.discountLimit : 0,
        iat: payload.iat,
        exp: payload.exp,
      },
    };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'invalid' };
  }
}

/** Distingue expirado de invalido — API_ERRORS.md exige codigos diferentes. */
export function verifyAccessToken(token: string): VerifyResult {
  return verifyWith(token, env.JWT_SECRET);
}

export function verifyRefreshToken(token: string): VerifyResult {
  return verifyWith(token, env.JWT_REFRESH_SECRET);
}
