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

export function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]?.trim() ?? req.ip ?? 'unknown';
  }
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function userAgentOf(req: Request): string {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua : 'unknown';
}
