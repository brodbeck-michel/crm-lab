/**
 * Rotas de autenticacao — `/api/v1/auth/*`.
 *
 * PUBLICAS por definicao (`requiresAuth: false`): sao o caminho de entrada. A
 * protecao aqui e outra — validacao de DTO, mensagem generica em falha e
 * limite de tentativas por email+IP dentro do AuthService.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { LoginRequest, RefreshRequest } from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { clientIp, userAgentOf } from '../http/context.js';
import { validate, validated } from '../http/middleware/validate.js';
import { createAuditService } from '../services/audit.service.js';
import { createAuthService, type RequestMeta } from '../services/auth.service.js';
import { createThemeService } from '../services/theme.service.js';

const loginSchema = z
  .object({
    email: z.string().trim().min(1, 'E-mail obrigatório').email('E-mail inválido'),
    password: z.string().min(1, 'Senha obrigatória'),
  })
  .strict();

const refreshSchema = z
  .object({ refreshToken: z.string().min(1, 'refreshToken obrigatório') })
  .strict();

function metaOf(req: Request): RequestMeta {
  return { ip: clientIp(req), userAgent: userAgentOf(req) };
}

export function authModule(deps: ApiModuleDeps): ApiModule {
  const audit = createAuditService(deps.db);
  const theme = createThemeService({ db: deps.db, audit });
  const auth = createAuthService({ db: deps.db, cache: deps.cache, audit, theme });

  const router = Router();

  router.post(
    '/login',
    validate(loginSchema, 'body'),
    (req: Request, res: Response, next): void => {
      const dto = validated<LoginRequest>(req, 'body');
      auth
        .login(dto.email, dto.password, metaOf(req))
        .then((result) => res.status(200).json(result))
        .catch(next);
    },
  );

  router.post(
    '/refresh',
    validate(refreshSchema, 'body'),
    (req: Request, res: Response, next): void => {
      const dto = validated<RefreshRequest>(req, 'body');
      auth
        .refresh(dto.refreshToken, metaOf(req))
        .then((result) => res.status(200).json(result))
        .catch(next);
    },
  );

  router.post(
    '/logout',
    validate(refreshSchema, 'body'),
    (req: Request, res: Response, next): void => {
      const dto = validated<RefreshRequest>(req, 'body');
      auth
        .logout(dto.refreshToken, metaOf(req))
        .then((result) => res.status(200).json(result))
        .catch(next);
    },
  );

  return { basePath: '/auth', router, requiresAuth: false };
}
