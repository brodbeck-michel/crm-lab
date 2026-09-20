/**
 * Rate limiting — 100 req/min por usuario (`RATE_LIMIT_PER_MINUTE`).
 * SECURITY.md "OWASP" exige o limite ativo.
 *
 * Implementado sobre `CacheService.incr` (D-139): janela FIXA — a chave
 * carrega o indice da janela (`Math.floor(at / windowMs)`) e um UNICO `INCR`
 * atomico decide se a requisicao cabe. Antes era `get` -> filtra array de
 * timestamps -> `set`: duas requisicoes concorrentes liam o MESMO estado,
 * as duas calculavam "ainda cabe" e as duas escreviam, perdendo um
 * incremento (rajada paralela furava o limite) — e o array serializado em
 * JSON a cada hit custava O(limite) por requisicao. `INCR` e O(1) e atomico
 * no servidor, sem essa janela entre leitura e escrita.
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
import { logCacheUnavailable } from '../../lib/cache.js';
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
  /**
   * Requisicoes que este limitador ignora — quem cuida delas e outro
   * limitador, montado mais perto da rota. Usado pelo limitador GLOBAL para
   * nao contar os webhooks de canal no mesmo balde dos usuarios.
   */
  skip?: (req: Request) => boolean;
  now?: () => number;
}

export const RATE_LIMIT_PREFIX = 'ratelimit:';

/**
 * Webhook de canal externo (Meta ou Evolution).
 *
 * Casado pelo caminho de proposito: o limitador global roda ANTES dos routers,
 * entao `req.route` ainda nao existe e nao ha como perguntar ao Express que
 * rota vai atender. `originalUrl` inclui o prefixo `/api/v1` e pode trazer
 * query string, dai o `startsWith` sobre o caminho puro.
 */
export function isChannelWebhook(req: Request): boolean {
  const [path] = req.originalUrl.split('?');
  return path?.startsWith('/api/v1/webhooks/') ?? false;
}

/**
 * Rotas publicas para efeito de D-139 (comportamento com Redis fora do ar em
 * runtime): sem sessao/JWT para se apoiar, entao um cache indisponivel aqui
 * fica fail-CLOSED (503 `SERVICE_UNAVAILABLE`) em vez de deixar passar sem
 * lockout/limite. `/auth/logout` fica de fora de proposito — nao ha o que
 * proteger (so revoga um token) e travar logout com o cache fora do ar
 * pioraria um incidente, nao ajudaria.
 */
const PUBLIC_ROUTE_PATHS = ['/api/v1/auth/login', '/api/v1/auth/refresh'];

export function isPublicRoute(req: Request): boolean {
  if (isChannelWebhook(req)) return true;
  const [path] = req.originalUrl.split('?');
  return PUBLIC_ROUTE_PATHS.includes(path ?? '');
}

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

/**
 * Escreve os headers de cota nos dois formatos: `X-RateLimit-*` (o que o
 * frontend/CORS ja consomem, D-050) e os do draft IETF
 * (`draft-ietf-httpapi-ratelimit-headers`, sem prefixo `X-`). Os dois
 * convivem — trocar um pelo outro quebraria contrato (`API_CONTRACTS.md`,
 * `exposedHeaders` do CORS em `app.ts`) sem necessidade.
 *
 * Diferenca proposital de semantica em "Reset": o legado e epoch absoluto
 * (segundos desde 1970); o do draft e DELTA — segundos ATE o reset, a partir
 * de agora — porque e assim que o draft define o campo.
 */
function setRateLimitHeaders(
  res: Response,
  limit: number,
  remaining: number,
  resetAt: number,
  at: number,
): void {
  const resetEpochSeconds = Math.ceil(resetAt / 1000);
  const resetDeltaSeconds = Math.max(0, Math.ceil((resetAt - at) / 1000));
  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(resetEpochSeconds));
  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Remaining', String(remaining));
  res.setHeader('RateLimit-Reset', String(resetDeltaSeconds));
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  const limit = options.limit ?? env.RATE_LIMIT_PER_MINUTE;
  const windowMs = options.windowMs ?? 60_000;
  const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));
  const resolveKey = options.keyResolver ?? rateLimitKey;
  const now = options.now ?? (() => Date.now());

  return (req: Request, res: Response, next: NextFunction): void => {
    if (options.skip?.(req) === true) {
      next();
      return;
    }
    const at = now();
    // Janela FIXA: o indice da janela entra na propria chave, entao todas as
    // requisicoes da mesma janela caem no MESMO INCR e o TTL cobre a janela
    // inteira — sem precisar filtrar timestamp nenhum na leitura.
    const windowIndex = Math.floor(at / windowMs);
    const cacheKey = `${RATE_LIMIT_PREFIX}${resolveKey(req)}:${windowIndex}`;
    const resetAt = (windowIndex + 1) * windowMs;

    void (async () => {
      try {
        const hits = await options.cache.incr(cacheKey, windowSeconds);

        if (hits > limit) {
          const retryAfter = Math.max(1, Math.ceil((resetAt - at) / 1000));
          setRateLimitHeaders(res, limit, 0, resetAt, at);
          res.setHeader('Retry-After', String(retryAfter));
          next(new BusinessError('RATE_LIMIT_EXCEEDED', { retryAfter }));
          return;
        }

        setRateLimitHeaders(res, limit, limit - hits, resetAt, at);
        next();
      } catch (err) {
        // D-139: Redis caiu EM RUNTIME (nao no boot — isso ja e barrado por
        // `verifyCacheReady`/D-058). Nao pode virar 500 pra tudo: rota
        // publica (login/refresh/webhook) fica fail-CLOSED, porque e
        // exatamente o que rate limit/lockout protegem; rota autenticada
        // fica fail-OPEN, porque o JWT ja e a defesa primaria dela e recusar
        // TODO o trafego autenticado por causa do cache seria trocar uma
        // degradacao de cota por uma indisponibilidade total.
        logCacheUnavailable({
          scope: 'rate-limit',
          path: req.originalUrl,
          message: err instanceof Error ? err.message : String(err),
        });
        if (isPublicRoute(req)) {
          next(new BusinessError('SERVICE_UNAVAILABLE'));
          return;
        }
        next();
      }
    })();
  };
}
