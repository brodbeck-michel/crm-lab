/**
 * AuthService — login, refresh com rotacao, logout (SERVICES.md §1, WORKFLOWS §8).
 *
 * Pontos que sao contrato, nao detalhe de implementacao:
 *
 * 1. `login` e o UNICO caminho que usa `db.withoutTenant()`: e preciso achar o
 *    usuario pelo e-mail ANTES de saber o tenant. Assim que o tenant e
 *    resolvido, todo o resto (tema, last_login_at, refresh token) roda por
 *    `withTenant()`, sob RLS.
 *
 * 2. Login falho nao revela se o e-mail existe: `INVALID_CREDENTIALS` nos dois
 *    casos, e quando o usuario nao existe comparamos a senha contra um hash
 *    bcrypt de verdade (dummy) para que o TEMPO de resposta tambem nao denuncie
 *    a diferenca.
 *
 * 3. O refresh e guardado HASHEADO (SHA-256) e ROTACIONADO a cada uso. Reuso de
 *    um refresh ja revogado e sinal de roubo: derruba a familia inteira (D-015).
 *
 * 4. A resposta de login ja embute o tema do tenant — FRONTEND_BACKEND.md: "o
 *    tema vem no login, o frontend nao faz request extra".
 */
import { randomUUID } from 'node:crypto';
import type {
  JwtPayload,
  LoginResponse,
  LogoutResponse,
  RefreshResponse,
  UserRole,
} from '@crm-lab/shared';
import { env } from '../config/env.js';
import type { DbClient } from '../db/types.js';
import { BusinessError } from '../http/errors.js';
import type { CacheService } from '../lib/cache.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '../lib/tokens.js';
import * as refreshRepo from '../repositories/refresh-token.repository.js';
import * as tenantRepo from '../repositories/tenant.repository.js';
import * as userRepo from '../repositories/user.repository.js';
import type { AuditService } from './audit.service.js';
import type { ThemeService } from './theme.service.js';

/**
 * `POST /auth/refresh` devolve TAMBEM o novo refresh token (D-014): sem isso o
 * cliente perderia a sessao no primeiro uso, ja que a rotacao revoga o antigo.
 * Campo aditivo — `RefreshResponse` continua valido.
 */
export interface RefreshResult extends RefreshResponse {
  refreshToken: string;
}

/** Metadados da request; nunca influenciam tenant/role, so auditoria. */
export interface RequestMeta {
  ip: string;
  userAgent: string;
}

export interface AuthService {
  login(email: string, password: string, meta: RequestMeta): Promise<LoginResponse>;
  refresh(refreshToken: string, meta: RequestMeta): Promise<RefreshResult>;
  logout(refreshToken: string, meta: RequestMeta): Promise<LogoutResponse>;
  validateToken(token: string): Promise<JwtPayload>;
}

export interface AuthServiceDeps {
  db: DbClient;
  cache: CacheService;
  audit: AuditService;
  theme: ThemeService;
}

/** SECURITY.md "Autenticacao": 5 tentativas falhas / 15 min por email+IP. */
export const LOGIN_FAILURE_LIMIT = 5;
export const LOGIN_FAILURE_WINDOW_SECONDS = 15 * 60;

/**
 * Hash bcrypt descartavel usado quando o e-mail NAO existe. Comparar contra ele
 * gasta o mesmo tempo de um bcrypt real, eliminando o canal lateral de tempo
 * que revelaria a existencia da conta. Calculado uma vez por processo.
 */
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(`nao-existe-${randomUUID()}`);
  return dummyHashPromise;
}

function refreshExpiryDate(): Date {
  return new Date(Date.now() + env.JWT_REFRESH_TTL * 1000);
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { db, cache, audit, theme } = deps;

  const failureKey = (email: string, ip: string): string =>
    `login-failures:${email.trim().toLowerCase()}:${ip}`;

  const assertNotThrottled = async (email: string, ip: string): Promise<void> => {
    const hits = (await cache.get<number>(failureKey(email, ip))) ?? 0;
    if (hits >= LOGIN_FAILURE_LIMIT) {
      throw new BusinessError('RATE_LIMIT_EXCEEDED', {
        retryAfter: LOGIN_FAILURE_WINDOW_SECONDS,
      });
    }
  };

  const registerFailure = async (email: string, ip: string): Promise<void> => {
    const key = failureKey(email, ip);
    const hits = (await cache.get<number>(key)) ?? 0;
    await cache.set(key, hits + 1, LOGIN_FAILURE_WINDOW_SECONDS);
  };

  /**
   * Emite um refresh token novo.
   *
   * Duas claims alem do par userId/tenantId, e as duas sao necessarias:
   *
   * - `role`: `verifyRefreshToken` do kernel valida o payload contra
   *   `JwtPayload` de `@crm-lab/shared`, onde `role` e OBRIGATORIO. Sem ela o
   *   token que acabamos de assinar nao passaria na nossa propria verificacao.
   *   (A alcada efetiva NAO sai daqui: na rotacao, papel e limite sao relidos
   *   do banco — um refresh antigo nunca ressuscita privilegio revogado.)
   * - `jti`: dois `jwt.sign` com as mesmas claims no mesmo segundo produzem a
   *   MESMA string (o `iat` tem resolucao de 1s). Sem o nonce, rotacionar logo
   *   apos o login geraria um token identico ao anterior e colidiria com
   *   `refresh_tokens.token_hash UNIQUE`.
   */
  const issueRefreshToken = (
    tenantId: string,
    userId: string,
    role: UserRole,
  ): { token: string; hash: string; expiresAt: Date } => {
    // `jti` e `role` sao responsabilidade de signRefreshToken (ver doc la).
    const token = signRefreshToken({ userId, tenantId, role });
    return { token, hash: refreshRepo.hashRefreshToken(token), expiresAt: refreshExpiryDate() };
  };

  const login = async (
    email: string,
    password: string,
    meta: RequestMeta,
  ): Promise<LoginResponse> => {
    await assertNotThrottled(email, meta.ip);

    // EXCECAO AUDITADA de RLS — unica no sistema (ver doc do metodo em db/types.ts).
    const candidates = await db.withoutTenant((tx) =>
      userRepo.findLoginCandidatesByEmail(tx, email),
    );

    let matched: (typeof candidates)[number] | null = null;
    if (candidates.length === 0) {
      // Gasta o mesmo tempo de um bcrypt real: sem oraculo por temporizacao.
      await verifyPassword(password, await dummyHash());
    } else {
      for (const candidate of candidates) {
        if (await verifyPassword(password, candidate.passwordHash)) {
          matched = candidate;
          break;
        }
      }
    }

    if (!matched) {
      await registerFailure(email, meta.ip);
      throw new BusinessError('INVALID_CREDENTIALS');
    }
    const user = matched;

    // Senha correta: os motivos de bloqueio ja podem ser especificos (o cliente
    // provou conhecer a credencial, entao nao ha o que vazar).
    if (!user.isActive) throw new BusinessError('USER_INACTIVE');
    if (!user.tenantIsActive) throw new BusinessError('TENANT_INACTIVE');

    const refresh = issueRefreshToken(user.tenantId, user.id, user.role);

    const tenantTheme = await db.withTenant(user.tenantId, async (tx) => {
      await userRepo.touchLastLogin(tx, user.id);
      await refreshRepo.insert(tx, {
        tenantId: user.tenantId,
        userId: user.id,
        tokenHash: refresh.hash,
        expiresAt: refresh.expiresAt,
      });
      return theme.getCurrentIn(tx, user.tenantId);
    });

    const accessToken = signAccessToken({
      userId: user.id,
      tenantId: user.tenantId,
      role: user.role,
      discountLimit: user.discountLimit,
    });

    await audit.log({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'login',
      entityType: 'user',
      entityId: user.id,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      accessToken,
      refreshToken: refresh.token,
      expiresIn: env.JWT_ACCESS_TTL,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        discountLimit: user.discountLimit,
      },
      tenant: {
        id: user.tenantId,
        name: user.tenantName,
        slug: user.tenantSlug,
        theme: tenantTheme,
      },
    };
  };

  const refresh = async (token: string, meta: RequestMeta): Promise<RefreshResult> => {
    const verified = verifyRefreshToken(token);
    if (!verified.ok) throw new BusinessError('REFRESH_TOKEN_INVALID');

    const { tenantId } = verified.payload;
    const tokenHash = refreshRepo.hashRefreshToken(token);

    const outcome = await db.withTenant(tenantId, async (tx) => {
      const stored = await refreshRepo.findByHash(tx, tokenHash);
      if (!stored) return { kind: 'unknown' as const };

      if (stored.revokedAt !== null) {
        // Reuso de token ja rotacionado => roubo. Derruba a familia (D-015).
        const revoked = await refreshRepo.revokeAllForUser(tx, stored.userId);
        return { kind: 'reuse' as const, userId: stored.userId, revoked };
      }

      if (new Date(stored.expiresAt).getTime() <= Date.now()) {
        await refreshRepo.revokeByHash(tx, tokenHash);
        return { kind: 'expired' as const };
      }

      const user = await userRepo.findById(tx, stored.userId);
      if (!user) return { kind: 'unknown' as const };
      if (!user.isActive) return { kind: 'user_inactive' as const };

      const tenant = await tenantRepo.findById(tx, tenantId);
      if (!tenant || !tenant.isActive) return { kind: 'tenant_inactive' as const };

      const next = issueRefreshToken(tenantId, user.id, user.role);
      await refreshRepo.revokeByHash(tx, tokenHash);
      await refreshRepo.insert(tx, {
        tenantId,
        userId: user.id,
        tokenHash: next.hash,
        expiresAt: next.expiresAt,
      });

      return { kind: 'rotated' as const, user, refreshToken: next.token };
    });

    switch (outcome.kind) {
      case 'reuse':
        await audit.log({
          tenantId,
          userId: outcome.userId,
          action: 'refresh_token_reuse_detected',
          entityType: 'user',
          entityId: outcome.userId,
          newValues: { revokedTokens: outcome.revoked },
          ipAddress: meta.ip,
          userAgent: meta.userAgent,
        });
        throw new BusinessError('REFRESH_TOKEN_INVALID');
      case 'unknown':
      case 'expired':
        throw new BusinessError('REFRESH_TOKEN_INVALID');
      case 'user_inactive':
        throw new BusinessError('USER_INACTIVE');
      case 'tenant_inactive':
        throw new BusinessError('TENANT_INACTIVE');
      case 'rotated':
        return {
          accessToken: signAccessToken({
            userId: outcome.user.id,
            tenantId,
            role: outcome.user.role,
            discountLimit: outcome.user.discountLimit,
          }),
          expiresIn: env.JWT_ACCESS_TTL,
          refreshToken: outcome.refreshToken,
        };
    }
  };

  const logout = async (token: string, meta: RequestMeta): Promise<LogoutResponse> => {
    const verified = verifyRefreshToken(token);
    // Token ilegivel: resposta identica a do sucesso — logout nao e oraculo.
    if (verified.ok) {
      const { tenantId, userId } = verified.payload;
      const revoked = await db.withTenant(tenantId, (tx) =>
        refreshRepo.revokeByHash(tx, refreshRepo.hashRefreshToken(token)),
      );
      if (revoked > 0) {
        await audit.log({
          tenantId,
          userId,
          action: 'logout',
          entityType: 'user',
          entityId: userId,
          ipAddress: meta.ip,
          userAgent: meta.userAgent,
        });
      }
    }
    return { message: 'Logged out successfully' };
  };

  const validateToken = async (token: string): Promise<JwtPayload> => {
    const result = verifyAccessToken(token);
    if (!result.ok) {
      throw new BusinessError(result.reason === 'expired' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID');
    }
    return result.payload;
  };

  return { login, refresh, logout, validateToken };
}
