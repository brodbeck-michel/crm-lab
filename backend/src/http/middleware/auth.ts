/**
 * Autenticacao e autorizacao — camada 1 do isolamento (SECURITY.md).
 *
 * `requireAuth` le o Bearer token, verifica a assinatura e monta o
 * `TenantContext`. O `tenantId` sai SEMPRE do token assinado; header, query e
 * body do cliente sao ignorados de proposito.
 *
 * `requireRoles(...)` e a checagem de permissao do servidor. "A UI esconde, o
 * servidor recusa" — nunca confie no frontend.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { UserRole } from '@crm-lab/shared';
import { verifyAccessToken } from '../../lib/tokens.js';
import { clientIp, userAgentOf, type TenantContext } from '../context.js';
import { BusinessError } from '../errors.js';

/** Extrai o token de `Authorization: Bearer <token>`. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, ...rest] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
}

export function requireAuth(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const token = bearerToken(req);
    if (!token) {
      next(new BusinessError('UNAUTHORIZED'));
      return;
    }

    const result = verifyAccessToken(token);
    if (!result.ok) {
      // API_ERRORS.md separa os dois: expirado dispara refresh no frontend.
      next(new BusinessError(result.reason === 'expired' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID'));
      return;
    }

    const ctx: TenantContext = {
      userId: result.payload.userId,
      tenantId: result.payload.tenantId,
      role: result.payload.role,
      discountLimit: result.payload.discountLimit,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
    };
    req.ctx = ctx;
    next();
  };
}

/**
 * Exige um dos papeis informados. Use SEMPRE depois de `requireAuth`.
 * Falha com `FORBIDDEN` + `details.requiredRoles` (contrato de API_ERRORS.md).
 */
export function requireRoles(...roles: UserRole[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const ctx = req.ctx;
    if (!ctx) {
      next(new BusinessError('UNAUTHORIZED'));
      return;
    }
    if (!roles.includes(ctx.role)) {
      next(new BusinessError('FORBIDDEN', { requiredRoles: roles }));
      return;
    }
    next();
  };
}

/**
 * Bloqueia o operador de plataforma nas rotas de laboratorio (SECURITY.md
 * "Console de Plataforma": o operador NAO tem caminho para dados de labs).
 */
export function denyPlatformOperator(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.ctx?.role === 'platform_operator') {
      next(new BusinessError('FORBIDDEN', { requiredRoles: ['attendant', 'manager', 'admin'] }));
      return;
    }
    next();
  };
}
