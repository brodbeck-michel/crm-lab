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
 *     Path=/` (D-151 — era `/api/v1/auth`, ampliado pelo CRMLAB-33 para o
 *     handshake de `/ws`; `PATCH /users/me/password` reusa o mesmo). O corpo JSON
 *     responde SO com o access token — o refresh nunca aparece em
 *     `response.body` nem em `document.cookie` (HttpOnly bloqueia leitura por JS).
 *   - `POST /refresh` le o cookie primeiro; o campo `refreshToken` no corpo e
 *     fallback DEPRECIADO de transicao (`RefreshRequest.refreshToken` em
 *     `@crm-lab/shared`), com remocao prevista para 2026-10-04.
 *   - `cookie-parser` tambem entra em `user.routes.ts` desde o CRMLAB-35, so
 *     para LER (nunca seta cookie de auth por la fora do fluxo de troca de senha).
 *   - CSRF do refresh: com `SameSite=Strict` o risco ja e baixo (um POST
 *     cross-site nao carrega o cookie — e `Path` deixou de ajudar nisso desde
 *     que virou `/`, D-151), mas exigimos tambem
 *     o header `X-Requested-With: crm-lab` — um form HTML cross-site nao
 *     consegue setar header customizado, so fetch/XHR same-origin conseguem.
 *   - NAO ligamos `credentials: true` no CORS geral (`app.ts`): nginx serve
 *     SPA e API no mesmo origin em producao/homologacao, entao o cookie viaja
 *     sozinho sem preflight cross-origin.
 */
import cookieParser from 'cookie-parser';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { LoginRequest, RefreshRequest } from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { clientIp, userAgentOf } from '../http/context.js';
import { BusinessError } from '../http/errors.js';
import { validate, validated } from '../http/middleware/validate.js';
import {
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  setRefreshCookie,
  clearRefreshCookie,
} from '../http/refresh-cookie.js';
import { createAuditService } from '../services/audit.service.js';
import { createAuthService, type RequestMeta } from '../services/auth.service.js';
import { createThemeService } from '../services/theme.service.js';

/** Re-exportados por compatibilidade — `refresh-cookie.ts` (D-152) e a fonte agora. */
export { REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH };

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
