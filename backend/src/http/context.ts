/**
 * `TenantContext` — o objeto que TODO service recebe como primeiro parametro
 * (SERVICES.md "Convencoes Transversais").
 *
 * Origem dos campos: exclusivamente o JWT verificado (camada 1 de SECURITY.md)
 * e os metadados da conexao. NADA aqui vem de header/query/body do cliente.
 */
import type { Request } from 'express';
import type { UserRole } from '@crm-lab/shared';

export interface TenantContext {
  userId: string;
  tenantId: string;
  role: UserRole;
  /** Alcada de desconto do usuario, em % (BUSINESS_RULES.md §2). */
  discountLimit: number;
  ip: string;
  userAgent: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Preenchido por `requireAuth`. Use `getContext(req)` para ler com garantia. */
      ctx?: TenantContext;
      /** Preenchido por `requestContext`. */
      correlationId?: string;
    }
  }
}

/** Le o contexto ja autenticado. Lanca se a rota esqueceu de usar `requireAuth`. */
export function getContext(req: Request): TenantContext {
  if (!req.ctx) {
    throw new Error('TenantContext ausente: a rota precisa passar por requireAuth');
  }
  return req.ctx;
}

/**
 * IP do cliente para rate limit, lockout de login e audit log (D-057).
 *
 * NAO le `X-Forwarded-For`. O header e escrito pelo cliente e so vira dado
 * confiavel depois de passar pela cadeia de proxies configurada — quem faz esse
 * corte e o Express, via `app.set('trust proxy', env.trustProxy)`. `req.ip` ja
 * e o resultado desse corte; ler o header aqui desfaria a protecao inteira e
 * daria ao atacante um balde de rate limit e um contador de lockout novos a
 * cada requisicao.
 */
export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function userAgentOf(req: Request): string {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua : 'unknown';
}
