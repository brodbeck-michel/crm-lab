/**
 * Rate limiting — 100 req/min por usuario (`RATE_LIMIT_PER_MINUTE`).
 * SECURITY.md "OWASP" exige o limite ativo.
 *
 * Implementado sobre `CacheService` (D-011): janela deslizante simples,
 * guardando os timestamps das requisicoes da janela. Com Redis, o mesmo codigo
 * passa a valer para todas as instancias.
 *
 * ==========================================================================
 * A CHAVE: usuario autenticado quando ha token; IP nas rotas publicas.
 * ==========================================================================
 * O limitador roda no kernel, ANTES dos routers — logo antes de qualquer
 * `requireAuth()`, que e por rota. Enquanto a chave dependia de `req.ctx`
 * (preenchido SO pelo `requireAuth`), o ramo `user:<id>` nunca era alcancado:
 * todo o trafego autenticado, de todos os tenants, dividia UM balde por IP.
 * Atras de load balancer ou NAT isso e um laboratorio inteiro se
 * autobloqueando — foi o que derrubou a suite E2E com 429 em cascata (D-050).
 *
 * A correcao NAO e afrouxar o limite: e a chave enxergar quem esta chamando.
 * `rateLimitKey` verifica a assinatura do proprio Bearer token e usa o
 * `userId` de dentro dele. O que ela deliberadamente NAO faz e escrever em
 * `req.ctx`: popular o contexto fora do `requireAuth` daria contexto valido de
 * brinde a qualquer rota que esquecesse o middleware — trocaria um bug de
 * disponibilidade por um de autorizacao.
 *
 * Token ausente, expirado ou adulterado cai no balde por IP. Se ganhasse balde
 * proprio, trocar o token a cada request seria um bypass trivial do limite.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { env } from '../../config/env.js';
import type { CacheService } from '../../lib/cache.js';
import { verifyAccessToken } from '../../lib/tokens.js';
import { clientIp } from '../context.js';
import { BusinessError } from '../errors.js';
import { bearerToken } from './auth.js';

export interface RateLimitOptions {
  cache: CacheService;
  /** Requisicoes permitidas por janela. Default: `RATE_LIMIT_PER_MINUTE`. */
  limit?: number;
  /** Tamanho da janela em ms. Default: 60_000. */
  windowMs?: number;
  /** Sobrescreve a chave (ex.: login usa email+ip, mais restrito). */
  keyResolver?: (req: Request) => string;
  now?: () => number;
}

export const RATE_LIMIT_PREFIX = 'ratelimit:';

/**
 * Identidade do chamador para efeito de limite.
 *
 * `req.ctx` vem primeiro so por eficiencia: se o limitador for montado depois
 * de um `requireAuth()`, o token ja foi verificado e nao ha por que refazer.
 * Exportada para ser testada direto — a regra e importante demais para so
 * existir dentro de um closure.
 */
export function rateLimitKey(req: Request): string {
  const userId = req.ctx?.userId ?? verifiedUserId(req);
  return userId !== null ? `user:${userId}` : `ip:${clientIp(req)}`;
}

/** `userId` do Bearer token, SE a assinatura conferir. Nao toca em `req`. */
function verifiedUserId(req: Request): string | null {
  const token = bearerToken(req);
  if (token === null) return null;
  const result = verifyAccessToken(token);
  return result.ok ? result.payload.userId : null;
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  const limit = options.limit ?? env.RATE_LIMIT_PER_MINUTE;
  const windowMs = options.windowMs ?? 60_000;
  const resolveKey = options.keyResolver ?? rateLimitKey;
  const now = options.now ?? (() => Date.now());

  return (req: Request, res: Response, next: NextFunction): void => {
    const cacheKey = `${RATE_LIMIT_PREFIX}${resolveKey(req)}`;
    const at = now();

    void (async () => {
      try {
        const stored = (await options.cache.get<number[]>(cacheKey)) ?? [];
        const hits = stored.filter((ts) => ts > at - windowMs);

        res.setHeader('X-RateLimit-Limit', String(limit));

        if (hits.length >= limit) {
          const oldest = hits[0] ?? at;
          const resetAt = oldest + windowMs;
          const retryAfter = Math.max(1, Math.ceil((resetAt - at) / 1000));
          res.setHeader('X-RateLimit-Remaining', '0');
          res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
          res.setHeader('Retry-After', String(retryAfter));
          next(new BusinessError('RATE_LIMIT_EXCEEDED', { retryAfter }));
          return;
        }

        hits.push(at);
        // TTL = janela: entradas antigas somem sozinhas mesmo sem trafego.
        await options.cache.set(cacheKey, hits, Math.ceil(windowMs / 1000));

        res.setHeader('X-RateLimit-Remaining', String(limit - hits.length));
        res.setHeader('X-RateLimit-Reset', String(Math.ceil((at + windowMs) / 1000)));
        next();
      } catch (err) {
        next(err);
      }
    })();
  };
}
