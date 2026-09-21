/**
 * Rotas de autenticacao — `/api/v1/auth/*`.
 *
 * PUBLICAS por definicao (`requiresAuth: false`): sao o caminho de entrada. A
 * protecao aqui e outra — validacao de DTO, mensagem generica em falha e
 * limite de tentativas por email+IP dentro do AuthService.
 *
 * CRMLAB-32 — sessao deixa de viver 100% em Bearer:
 *
 *   - `POST /login` e `POST /refresh` gravam o refresh token em
 *     `Set-Cookie: crm_refresh=<token>; HttpOnly; Secure; SameSite=Strict;
 *     Path=/` (Path alargado de `/api/v1/auth` para `/` no CRMLAB-33/D-151 —
 *     o handshake do WebSocket em `/ws` tambem precisa do cookie). O corpo
 *     JSON responde SO com o access token — o refresh nunca aparece em
 *     `response.body` nem em `document.cookie` (HttpOnly bloqueia leitura
 *     por JS).
 *   - `POST /refresh` le o cookie primeiro; o campo `refreshToken` no corpo e
 *     fallback DEPRECIADO de transicao (`RefreshRequest.refreshToken` em
 *     `@crm-lab/shared`), com remocao prevista para 2026-10-04.
 *   - `cookie-parser` so entra NESTE router — nenhum outro modulo depende de
 *     `req.cookies`.
 *   - CSRF do refresh: com `SameSite=Strict` + `Path=/api/v1/auth` o risco ja
 *     e baixo (um POST cross-site nao carrega o cookie), mas exigimos tambem
 *     o header `X-Requested-With: crm-lab` — um form HTML cross-site nao
 *     consegue setar header customizado, so fetch/XHR same-origin conseguem.
 *   - NAO ligamos `credentials: true` no CORS geral (`app.ts`): nginx serve
 *     SPA e API no mesmo origin em producao/homologacao, entao o cookie viaja
 *     sozinho sem preflight cross-origin.
 */
import cookieParser from 'cookie-parser';
import { Router, type CookieOptions, type Request, type Response } from 'express';
import { z } from 'zod';
import type { LoginRequest, RefreshRequest } from '@crm-lab/shared';
import { env } from '../config/env.js';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { clientIp, userAgentOf } from '../http/context.js';
import { BusinessError } from '../http/errors.js';
import { validate, validated } from '../http/middleware/validate.js';
import { createAuditService } from '../services/audit.service.js';
import { createAuthService, type RequestMeta } from '../services/auth.service.js';
import { createThemeService } from '../services/theme.service.js';
import {
  LEGACY_REFRESH_COOKIE_PATH,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
} from '../lib/cookies.js';

export { REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH };

/**
 * `secure` so em producao/homologacao (HTTPS de verdade atras do Caddy):
 * em `development`/`test`, sem TLS local, um cookie `Secure` jamais voltaria
 * ao backend e o refresh por cookie nunca funcionaria no ambiente dev.
 * `HttpOnly` e `SameSite=Strict` valem em qualquer ambiente — sao o que
 * protege a sessao, nao dependem de HTTPS local.
 */
function cookieOptions(maxAgeMs?: number): CookieOptions {
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
  };
}

/**
 * Mata o cookie que ficou no path antigo (`LEGACY_REFRESH_COOKIE_PATH`).
 *
 * Sem isto, quem ja estava logado quando esta versao subir fica com dois
 * `crm_refresh` e `/auth/refresh` le eternamente o velho — ver o comentario em
 * `lib/cookies.ts`. Roda em TODA resposta que mexe no cookie (login, refresh,
 * logout), que sao exatamente os pontos por onde qualquer sessao viva passa.
 */
function clearLegacyRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, { ...cookieOptions(), path: LEGACY_REFRESH_COOKIE_PATH });
}

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE_NAME, token, cookieOptions(env.JWT_REFRESH_TTL * 1000));
  // Depois do cookie de verdade, nao antes: os dois `Set-Cookie` tem o mesmo
  // NOME e so diferem no `Path`. Browser trata como cookies distintos em
  // qualquer ordem, mas cliente/parser ingenuo que so olha o nome fica com o
  // PRIMEIRO — e o primeiro tem que ser o valido.
  clearLegacyRefreshCookie(res);
}

function clearRefreshCookie(res: Response): void {
  clearLegacyRefreshCookie(res);
  res.clearCookie(REFRESH_COOKIE_NAME, cookieOptions());
}

/** Header exigido em `/refresh` como camada extra de protecao CSRF (ver cabecalho do arquivo). */
const REQUIRED_REFRESH_HEADER = 'crm-lab';

function assertRefreshHeader(req: Request): void {
  if (req.header('X-Requested-With') !== REQUIRED_REFRESH_HEADER) {
    throw new BusinessError('REFRESH_TOKEN_INVALID');
  }
}

/**
 * Cookie primeiro, corpo depois (fallback depreciado — ver cabecalho do
 * arquivo). Nenhum dos dois presente => sessao invalida.
 */
function refreshTokenOf(req: Request): string {
  const fromCookie = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE_NAME];
  const fromBody = (req.body as RefreshRequest | undefined)?.refreshToken;
  const token = fromCookie ?? fromBody;
  if (!token) throw new BusinessError('REFRESH_TOKEN_INVALID');
  return token;
}

const loginSchema = z
  .object({
    email: z.string().trim().min(1, 'E-mail obrigatório').email('E-mail inválido'),
    password: z.string().min(1, 'Senha obrigatória'),
  })
  .strict();

/** `refreshToken` opcional: fallback depreciado, o caminho normal e o cookie. */
const refreshBodySchema = z
  .object({ refreshToken: z.string().min(1, 'refreshToken obrigatório').optional() })
  .strict();

function metaOf(req: Request): RequestMeta {
  return { ip: clientIp(req), userAgent: userAgentOf(req) };
}

export function authModule(deps: ApiModuleDeps): ApiModule {
  const audit = createAuditService(deps.db);
  const theme = createThemeService({ db: deps.db, audit });
  const auth = createAuthService({ db: deps.db, cache: deps.cache, audit, theme });

  const router = Router();
  router.use(cookieParser());

  router.post(
    '/login',
    validate(loginSchema, 'body'),
    (req: Request, res: Response, next): void => {
      const dto = validated<LoginRequest>(req, 'body');
      auth
        .login(dto.email, dto.password, metaOf(req))
        .then(({ refreshToken, ...body }) => {
          setRefreshCookie(res, refreshToken);
          res.status(200).json(body);
        })
        .catch(next);
    },
  );

  router.post(
    '/refresh',
    validate(refreshBodySchema, 'body'),
    (req: Request, res: Response, next): void => {
      try {
        assertRefreshHeader(req);
        const token = refreshTokenOf(req);
        auth
          .refresh(token, metaOf(req))
          .then(({ refreshToken, ...body }) => {
            setRefreshCookie(res, refreshToken);
            res.status(200).json(body);
          })
          .catch(next);
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/logout',
    validate(refreshBodySchema, 'body'),
    (req: Request, res: Response, next): void => {
      const fromCookie = (req.cookies as Record<string, string> | undefined)?.[
        REFRESH_COOKIE_NAME
      ];
      const fromBody = validated<RefreshRequest>(req, 'body').refreshToken;
      const token = fromCookie ?? fromBody ?? '';
      clearRefreshCookie(res);
      auth
        .logout(token, metaOf(req))
        .then((result) => res.status(200).json(result))
        .catch(next);
    },
  );

  return { basePath: '/auth', router, requiresAuth: false };
}
