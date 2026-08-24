/**
 * Rate limiting — 100 req/min por usuario (`RATE_LIMIT_PER_MINUTE`).
 * SECURITY.md "OWASP" exige o limite ativo.
 *
 * Implementado sobre `CacheService` (D-011): janela deslizante simples,
 * guardando os timestamps das requisicoes da janela. Com Redis, o mesmo codigo
 * passa a valer para todas as instancias.
 *
 * Chave: userId quando autenticado; IP quando anonimo (login, health).
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { env } from '../../config/env.js';
import type { CacheService } from '../../lib/cache.js';
import { clientIp } from '../context.js';
import { BusinessError } from '../errors.js';

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

function defaultKey(req: Request): string {
  return req.ctx ? `user:${req.ctx.userId}` : `ip:${clientIp(req)}`;
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  const limit = options.limit ?? env.RATE_LIMIT_PER_MINUTE;
  const windowMs = options.windowMs ?? 60_000;
  const resolveKey = options.keyResolver ?? defaultKey;
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
