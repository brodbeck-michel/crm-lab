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
import { BusinessError, notFound } from '../http/errors.js';
import type { CacheService } from '../lib/cache.js';
import { logCacheUnavailable } from '../lib/cache.js';
import { logger } from '../lib/logger.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { checkPasswordPolicy } from '../lib/password-policy.js';
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

/** Metadados da request; nunca influenciam tenant/role, so auditoria. */
export interface RequestMeta {
  ip: string;
  userAgent: string;
}

/**
 * Shape INTERNO devolvido pelo service — inclui `refreshToken` em claro para o
 * controller gravar no cookie httpOnly (CRMLAB-32). NUNCA e o shape que sai
 * pela API: `LoginResponse`/`RefreshResponse` de `@crm-lab/shared` (o contrato
 * publico) nao tem esse campo. `auth.routes.ts` e o UNICO lugar que le
 * `refreshToken` daqui — para montar o `Set-Cookie` — e o descarta antes de
 * `res.json()`.
 */
export interface LoginResult extends LoginResponse {
  refreshToken: string;
}

export interface RefreshResult extends RefreshResponse {
  refreshToken: string;
}

/** Contexto minimo de quem esta trocando a propria senha (CRMLAB-35). */
export interface ChangePasswordContext {
  tenantId: string;
  userId: string;
  role: UserRole;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
  /** Refresh token da sessao ATUAL (do cookie), se veio na requisicao. */
  currentRefreshToken: string | null;
}

export interface AuthService {
  login(email: string, password: string, meta: RequestMeta): Promise<LoginResult>;
  refresh(refreshToken: string, meta: RequestMeta): Promise<RefreshResult>;
  logout(refreshToken: string, meta: RequestMeta): Promise<LogoutResponse>;
  validateToken(token: string): Promise<JwtPayload>;
  changePassword(
    ctx: ChangePasswordContext,
    input: ChangePasswordInput,
    meta: RequestMeta,
  ): Promise<void>;
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
 * Por quanto tempo um refresh token JA ROTACIONADO pode ser reapresentado sem
 * ser tratado como roubo (D-166). Cobre a corrida entre abas do mesmo
 * navegador no bootstrap da pagina — ver o comentario em `refresh`.
 */
export const REFRESH_REUSE_GRACE_MS = 10_000;

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

/** Teto novo de FAMÍLIA (CRMLAB-35, D-154) — só usado quando uma família NASCE (login). */
function refreshAbsoluteExpiryDate(): Date {
  return new Date(Date.now() + env.JWT_REFRESH_ABSOLUTE_TTL * 1000);
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { db, cache, audit, theme } = deps;

  const failureKey = (email: string, ip: string): string =>
    `login-failures:${email.trim().toLowerCase()}:${ip}`;

  /**
   * Redis fora do ar aqui (D-139): `/auth/login` e rota PUBLICA, entao
   * fail-CLOSED — 503 `SERVICE_UNAVAILABLE`, nunca deixar passar sem lockout
   * (e nunca 500 generico: quem chama sabe exatamente o que aconteceu).
   * Normalmente nem chega aqui — o rate-limit GLOBAL (`app.ts`) ja barra
   * `/auth/login` com o mesmo 503 antes do controller ser alcancado — mas o
   * `AuthService` nao pode depender disso pra se comportar direito sozinho
   * (e o que os testes deste arquivo verificam).
   */
  const onCacheFailure = (scope: string, err: unknown): never => {
    logCacheUnavailable({ scope, message: err instanceof Error ? err.message : String(err) });
    throw new BusinessError('SERVICE_UNAVAILABLE');
  };

  /**
   * Conta a TENTATIVA antes de olhar a senha, e recusa quando o contador passa
   * do limite — `INCR` primeiro, compara depois, o mesmo padrao do
   * `rate-limit.ts` (revisao do PR #45).
   *
   * A versao anterior lia o contador ANTES do bcrypt e incrementava DEPOIS,
   * so na falha. Atomico, mas check-then-act: 100 tentativas em paralelo
   * passavam TODAS pela leitura (contador ainda em zero) antes de qualquer
   * incremento terminar — o proprio teste do PR #45 provava isso ao exigir
   * que 20 senhas erradas paralelas voltassem 401 e nao 429. O lockout de 5
   * so valia para tentativas em serie; uma rajada tinha ~100 palpites.
   *
   * Contar tentativas (e nao falhas) muda pouco na pratica: quem acerta a
   * senha zera o contador (`clearFailures`), entao 5 logins certos seguidos
   * nunca travam ninguem. Quem erra 5 vezes e barrado na 6a, como antes.
   * A janela agora e FIXA a partir da 1a tentativa (o `EXPIRE` so entra na
   * criacao da chave) em vez de deslizar a cada falha — deliberado: renovar o
   * TTL a cada erro e o que deixava um atacante paciente segurar o lockout
   * de uma vitima para sempre, um palpite a cada 14 min.
   *
   * Redis fora do ar: fail-CLOSED (ver `onCacheFailure`).
   */
  const countAttempt = async (email: string, ip: string): Promise<void> => {
    const hits = await cache
      .incr(failureKey(email, ip), LOGIN_FAILURE_WINDOW_SECONDS)
      .catch((err: unknown) => onCacheFailure('auth.login_throttle_check', err));
    if (hits > LOGIN_FAILURE_LIMIT) {
      throw new BusinessError('RATE_LIMIT_EXCEEDED', {
        retryAfter: LOGIN_FAILURE_WINDOW_SECONDS,
      });
    }
  };

  /**
   * Zera o contador quando a senha bate. Melhor esforco: uma falha do Redis
   * aqui NAO pode derrubar um login que ja provou a credencial certa — so
   * loga (fail-open desta limpeza, throttle de `logCacheUnavailable`) e
   * segue. Pior caso: o contador antigo sobrevive ate o TTL de 15 min.
   */
  const clearFailures = async (email: string, ip: string): Promise<void> => {
    try {
      await cache.del(failureKey(email, ip));
    } catch (err) {
      logCacheUnavailable({
        scope: 'auth.login_clear_failures',
        message: err instanceof Error ? err.message : String(err),
      });
    }
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
  /**
   * `absoluteExpiresAt` ausente = família NOVA (login): teto novo de 30 dias.
   * Presente = rotação de família existente: o teto é CARREGADO adiante, nunca
   * reiniciado — senão "absoluto" não seria absoluto (D-154).
   */
  const issueRefreshToken = (
    tenantId: string,
    userId: string,
    role: UserRole,
    absoluteExpiresAt?: Date,
  ): { token: string; hash: string; expiresAt: Date; absoluteExpiresAt: Date } => {
    // `jti` e `role` sao responsabilidade de signRefreshToken (ver doc la).
    const token = signRefreshToken({ userId, tenantId, role });
    return {
      token,
      hash: refreshRepo.hashRefreshToken(token),
      expiresAt: refreshExpiryDate(),
      absoluteExpiresAt: absoluteExpiresAt ?? refreshAbsoluteExpiryDate(),
    };
  };

  const login = async (
    email: string,
    password: string,
    meta: RequestMeta,
  ): Promise<LoginResult> => {
    await countAttempt(email, meta.ip);

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
      // A tentativa ja foi contada em `countAttempt`, antes do bcrypt.
      throw new BusinessError('INVALID_CREDENTIALS');
    }
    const user = matched;
    // Senha certa: zera o contador de falhas (D-139 — "DEL no sucesso").
    await clearFailures(email, meta.ip);

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
        absoluteExpiresAt: refresh.absoluteExpiresAt,
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
        // Reuso de token ja ROTACIONADO => roubo. Derruba a familia (D-015).
        //
        // `revokedReason` separa isso de um token derrubado em massa por acao
        // de seguranca (troca de senha, desativacao — CRMLAB-35/D-154). Sem a
        // distincao, o outro navegador do proprio usuario tentando refresh
        // depois da troca de senha — comportamento normal, nao ataque — caía
        // aqui e derrubava tambem a sessao que acabou de trocar a senha,
        // tornando o "revoga todas MENOS a atual" inutil na pratica.
        if (stored.revokedReason === 'security') {
          // Nao derruba a familia, mas REGISTRA (revisao do PR #49): este e
          // exatamente o caso pos-comprometimento — o usuario trocou a senha
          // PORQUE um dispositivo foi roubado, e o replay do ladrao era o
          // unico sinal de que o token vazou mesmo. Voltar 401 mudo apagava o
          // sinal justamente quando ele importa.
          return { kind: 'replay_after_security' as const, userId: stored.userId };
        }
        // Janela de tolerancia (revisao do PR #44, D-166): um token rotacionado
        // ha POUCOS segundos reapresentado nao e roubo — e a outra aba do
        // mesmo navegador, cujo POST /auth/refresh saiu antes do Set-Cookie da
        // primeira chegar. Desde o CRMLAB-32 o refresh roda em TODA carga de
        // pagina, entao restaurar uma sessao com duas abas produzia isso de
        // forma deterministica: a segunda aba caia aqui, derrubava a familia e
        // deslogava o usuario das duas, com um `refresh_token_reuse_detected`
        // falso na auditoria. Dentro da janela: 401 comum, sem tocar na
        // familia. Um ladrao de verdade que reapresenta o token dentro de 10 s
        // ganha exatamente nada com isso — o token ja esta revogado.
        if (
          stored.revokedSecondsAgo !== null &&
          stored.revokedSecondsAgo * 1000 < REFRESH_REUSE_GRACE_MS
        ) {
          return { kind: 'reuse_within_grace' as const, userId: stored.userId };
        }
        const revoked = await refreshRepo.revokeAllForUser(tx, stored.userId, 'rotated');
        return { kind: 'reuse' as const, userId: stored.userId, revoked };
      }

      if (new Date(stored.expiresAt).getTime() <= Date.now()) {
        await refreshRepo.revokeByHash(tx, tokenHash);
        return { kind: 'expired' as const };
      }

      // Teto da FAMÍLIA (D-154): vencido, força login de novo mesmo com o
      // token individual ainda dentro dos 7 dias rotativos.
      if (new Date(stored.absoluteExpiresAt).getTime() <= Date.now()) {
        await refreshRepo.revokeByHash(tx, tokenHash);
        return { kind: 'absolute_expired' as const };
      }

      const user = await userRepo.findById(tx, stored.userId);
      if (!user) return { kind: 'unknown' as const };
      if (!user.isActive) return { kind: 'user_inactive' as const };

      const tenant = await tenantRepo.findById(tx, tenantId);
      if (!tenant || !tenant.isActive) return { kind: 'tenant_inactive' as const };

      const next = issueRefreshToken(tenantId, user.id, user.role, new Date(stored.absoluteExpiresAt));
      await refreshRepo.revokeByHash(tx, tokenHash);
      await refreshRepo.insert(tx, {
        tenantId,
        userId: user.id,
        tokenHash: next.hash,
        expiresAt: next.expiresAt,
        absoluteExpiresAt: next.absoluteExpiresAt,
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
      case 'reuse_within_grace':
        logger.warn('auth.refresh_reuse_within_grace', { tenantId, userId: outcome.userId });
        throw new BusinessError('REFRESH_TOKEN_INVALID');
      case 'replay_after_security':
        // Mesma resposta de qualquer token invalido — a auditoria e o unico
        // efeito. Nao derruba familia: ver o comentario na deteccao.
        await audit.log({
          tenantId,
          userId: outcome.userId,
          action: 'refresh_token_replay_after_security',
          entityType: 'user',
          entityId: outcome.userId,
          ipAddress: meta.ip,
          userAgent: meta.userAgent,
        });
        throw new BusinessError('REFRESH_TOKEN_INVALID');
      case 'unknown':
      case 'expired':
      case 'absolute_expired':
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

  /**
   * Troca a própria senha (CRMLAB-35). Revoga todas as OUTRAS famílias de
   * refresh do usuário — a da requisição atual (`currentRefreshToken`, do
   * cookie) fica de fora, então quem trocou a senha continua logado. Sem
   * cookie (fallback depreciado sem sessão identificável), revoga TUDO.
   */
  const changePassword = async (
    ctx: ChangePasswordContext,
    input: ChangePasswordInput,
    meta: RequestMeta,
  ): Promise<void> => {
    const policy = checkPasswordPolicy(input.newPassword);
    if (!policy.ok) {
      throw new BusinessError('VALIDATION_ERROR', { fields: { newPassword: policy.reason } });
    }

    // Senha nova igual a atual: a API respondia 200, revogava as outras sessoes
    // e escrevia auditoria sem NADA ter rotacionado. So o frontend barrava.
    if (input.newPassword === input.currentPassword) {
      throw new BusinessError('VALIDATION_ERROR', {
        fields: { newPassword: 'A nova senha precisa ser diferente da atual' },
      });
    }

    const current = await db.withTenant(ctx.tenantId, (tx) => userRepo.findById(tx, ctx.userId));
    if (!current) throw notFound({ resource: 'user' });

    // bcrypt (cost 12, ~300 ms cada) FORA da transacao — revisao do PR #49.
    // Dentro dela, cada troca de senha segurava uma conexao do pool
    // `idle in transaction` por ~600 ms; com DEFAULT_POOL_MAX = 10, dez trocas
    // simultaneas travavam todo o resto do sistema. `login` ja faz assim.
    const currentOk = await verifyPassword(input.currentPassword, current.passwordHash);
    if (!currentOk) {
      throw new BusinessError('VALIDATION_ERROR', {
        fields: { currentPassword: 'Senha atual incorreta' },
      });
    }
    const passwordHash = await hashPassword(input.newPassword);

    const outcome = await db.withTenant(ctx.tenantId, async (tx) => {
      // Compare-and-set contra o hash lido acima: fecha a janela entre conferir
      // e gravar, aberta de proposito ao tirar o bcrypt da transacao.
      const changed = await userRepo.updatePasswordHash(
        tx,
        ctx.userId,
        passwordHash,
        current.passwordHash,
      );
      if (!changed) return { kind: 'invalid_current' as const };

      const exceptHash = input.currentRefreshToken
        ? refreshRepo.hashRefreshToken(input.currentRefreshToken)
        : null;
      await refreshRepo.revokeAllForUserExcept(tx, ctx.userId, exceptHash);

      return { kind: 'ok' as const };
    });

    if (outcome.kind === 'invalid_current') {
      throw new BusinessError('VALIDATION_ERROR', {
        fields: { currentPassword: 'Senha atual incorreta' },
      });
    }

    await audit.log({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: 'change_own_password',
      entityType: 'user',
      entityId: ctx.userId,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
  };

  return { login, refresh, logout, validateToken, changePassword };
}

/**
 * Sessao do refresh token ainda VIVA? (CRMLAB-33, correcao da revisao do PR #47)
 *
 * Mesmas checagens de `refresh` — linha em `refresh_tokens`, `revoked_at`,
 * expiracao, `user.is_active`, `tenant.is_active` — SEM rotacionar nada e SEM
 * derrubar familia em caso de reuso. O WebSocket so precisa da resposta
 * "continua valendo?"; rotacionar aqui brigaria com o `/auth/refresh` do
 * proprio cliente, e derrubar a familia daria a qualquer um que capture um
 * token velho um jeito barato de deslogar o dono.
 *
 * Funcao de modulo, nao metodo do service: quem chama e o `WebSocketHub`, que
 * nasce em `main.ts` antes do `createApp` e nao tem (nem deveria ter) o
 * container de services.
 */
export async function refreshSessionIsLive(db: DbClient, token: string): Promise<boolean> {
  const verified = verifyRefreshToken(token);
  if (!verified.ok) return false;

  const { tenantId } = verified.payload;
  const tokenHash = refreshRepo.hashRefreshToken(token);

  return db.withTenant(tenantId, async (tx) => {
    const stored = await refreshRepo.findByHash(tx, tokenHash);
    if (!stored || stored.revokedAt !== null) return false;
    if (new Date(stored.expiresAt).getTime() <= Date.now()) return false;
    // Teto ABSOLUTO da familia (CRMLAB-35/D-154), somado no merge das duas
    // branches da onda: sem ele, uma familia que ja passou dos 30 dias tem o
    // refresh recusado mas ainda abriria WebSocket — o teto vazaria pelo /ws.
    if (new Date(stored.absoluteExpiresAt).getTime() <= Date.now()) return false;

    const user = await userRepo.findById(tx, stored.userId);
    if (!user || !user.isActive) return false;

    const tenant = await tenantRepo.findById(tx, tenantId);
    return tenant !== null && tenant.isActive;
  });
}
