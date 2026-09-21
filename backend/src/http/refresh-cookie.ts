/**
 * Como o cookie de refresh (`crm_refresh`) e GRAVADO — compartilhado entre
 * `auth.routes.ts` (login/refresh/logout) e `user.routes.ts` (troca de senha,
 * CRMLAB-35/D-152).
 *
 * O nome e o `Path` moram em `lib/cookies.ts` (CRMLAB-33/D-151), que e a fonte
 * unica tambem para quem le o cookie FORA do pipeline do Express (o upgrade de
 * WebSocket em `ws-hub.ts` nunca passa por `cookie-parser`). Aqui fica so o que
 * depende do `Response` do Express, que o handshake de WS nao tem.
 */
import {
  LEGACY_REFRESH_COOKIE_PATH,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
} from '../lib/cookies.js';
import { env } from '../config/env.js';
import type { CookieOptions, Response } from 'express';

export { REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH };

/**
 * `secure` so em producao/homologacao (HTTPS de verdade atras do Caddy):
 * em `development`/`test`, sem TLS local, um cookie `Secure` jamais voltaria
 * ao backend e o refresh por cookie nunca funcionaria no ambiente dev.
 * `HttpOnly` e `SameSite=Strict` valem em qualquer ambiente — sao o que
 * protege a sessao, nao dependem de HTTPS local.
 */
export function cookieOptions(maxAgeMs?: number): CookieOptions {
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
 * logout, troca de senha), que sao exatamente os pontos por onde qualquer
 * sessao viva passa.
 */
function clearLegacyRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, { ...cookieOptions(), path: LEGACY_REFRESH_COOKIE_PATH });
}

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE_NAME, token, cookieOptions(env.JWT_REFRESH_TTL * 1000));
  // Depois do cookie de verdade, nao antes: os dois `Set-Cookie` tem o mesmo
  // NOME e so diferem no `Path`. Browser trata como cookies distintos em
  // qualquer ordem, mas cliente/parser ingenuo que so olha o nome fica com o
  // PRIMEIRO — e o primeiro tem que ser o valido.
  clearLegacyRefreshCookie(res);
}

export function clearRefreshCookie(res: Response): void {
  clearLegacyRefreshCookie(res);
  res.clearCookie(REFRESH_COOKIE_NAME, cookieOptions());
}
