import type { ApiErrorBody, ApiErrorCode, RefreshResponse } from '@crm-lab/shared';

/**
 * Cliente HTTP — a ÚNICA camada do frontend que chama `fetch`
 * (docs/guides/CONVENTIONS.md: "Proibido: fetch fora da camada api/").
 *
 * Responsabilidades:
 *  1. base URL (`VITE_API_URL`) + serialização de query/body
 *  2. injeção do header `Authorization: Bearer <accessToken>`
 *  3. conversão do envelope de erro de docs/api/API_ERRORS.md em `ApiError`
 *  4. interceptor de refresh: `401 TOKEN_EXPIRED` → `POST /auth/refresh` →
 *     repete a requisição original de forma transparente
 *     (docs/contracts/FRONTEND_BACKEND.md — "Autenticação")
 *
 * N requisições que batem em 401 ao mesmo tempo compartilham UM único refresh
 * em voo (`refreshInFlight`), nunca N.
 *
 * CRMLAB-32 — o refresh token NUNCA passa por aqui: ele vive só no cookie
 * httpOnly `crm_refresh` (`Set-Cookie` do backend), que o browser anexa
 * sozinho em `POST /auth/refresh` porque SPA e API são o MESMO origin (nginx).
 * O access token é o único token que este client vê, e só em memória — sem
 * `credentials: 'include'` (não precisa: same-origin já manda cookie) e sem
 * `credentials: true` no CORS do backend (regra do card: nginx já resolve).
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue>;

/** Erro tipado da API. O frontend faz `switch` no `code`, NUNCA na `message`. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ApiErrorCode,
    message: string,
    statusCode: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export interface RequestOptions {
  method?: HttpMethod;
  /** Serializado como JSON. `undefined` não envia corpo. */
  body?: unknown;
  query?: QueryParams;
  signal?: AbortSignal;
  /** `false` em `/auth/login` e `/auth/refresh` — sem header nem refresh. */
  auth?: boolean;
}

/**
 * Ponte com a sessão. O client NÃO importa o store (evita ciclo):
 * `stores/auth.store.ts` se registra aqui na inicialização.
 */
export interface SessionBridge {
  getAccessToken: () => string | null;
  setAccessToken: (accessToken: string, expiresIn: number) => void;
  clearSession: () => void;
}

const NULL_BRIDGE: SessionBridge = {
  getAccessToken: () => null,
  setAccessToken: () => undefined,
  clearSession: () => undefined,
};

let bridge: SessionBridge = NULL_BRIDGE;
let onUnauthenticated: () => void = () => undefined;
let refreshInFlight: Promise<string> | null = null;

export function setSessionBridge(next: SessionBridge): void {
  bridge = next;
}

/** Chamado quando o refresh falha — o app manda o usuário para `/login`. */
export function setUnauthenticatedHandler(handler: () => void): void {
  onUnauthenticated = handler;
}

/** Só para testes: volta ao estado inicial (sem sessão, sem refresh em voo). */
export function resetApiClient(): void {
  bridge = NULL_BRIDGE;
  onUnauthenticated = () => undefined;
  refreshInFlight = null;
}

export function apiBaseUrl(): string {
  const url = import.meta.env.VITE_API_URL;
  return typeof url === 'string' && url.length > 0 ? url : 'http://localhost:3000/api/v1';
}

/**
 * Resolve uma URL de mídia (ex. `Message.attachmentUrl`) vinda da API.
 *
 * O backend devolve caminho RELATIVO (`/api/v1/media/:id`). `VITE_API_URL` é
 * relativo em todo ambiente desde D-142 (produção via nginx — D-051; dev/E2E
 * via proxy do Vite) — `apiBaseUrl()` normalmente já é `/api/v1`, então
 * `origem` cai em `window.location.origin`, que é sempre o origin certo.
 * O ramo absoluto abaixo é defensivo (ex. mídia hospedada fora, ou uma base
 * absoluta configurada manualmente): `new URL(caminho, base)` EXIGE base
 * absoluta, e sem ele esta função lançava `Invalid base URL` sempre que
 * `apiBaseUrl()` viesse relativo (histórico: era o caso de todo build de
 * produção antes desta função existir, e derrubava a tela inteira ao abrir
 * uma conversa com anexo).
 */
export function resolveMediaUrl(url: string): string {
  if (/^https?:\/\//.test(url)) return url;
  const base = apiBaseUrl();
  const origem = /^https?:\/\//.test(base) ? base : window.location.origin;
  return new URL(url, origem).toString();
}

export interface AuthenticatedMedia {
  blob: Blob;
  /** Nome original do arquivo, do `Content-Disposition`. `null` se não veio. */
  fileName: string | null;
}

/**
 * `Content-Disposition: inline; filename="pedido%20medico.jpg"` → o nome.
 *
 * O backend percentual-codifica o nome ao montar o header
 * (`media.routes.ts`), por isso o `decodeURIComponent` na volta.
 */
function fileNameFrom(header: string | null): string | null {
  const encoded = /filename="([^"]*)"/.exec(header ?? '')?.[1];
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded) || null;
  } catch {
    return encoded;
  }
}

/**
 * Busca um recurso de mídia AUTENTICADO (`GET /media/:id` exige
 * `requireAuth()` — docs/api §media) e devolve os bytes como `Blob`, junto do
 * nome original do arquivo.
 *
 * `<img src>`/`<a href>` crus nunca mandam `Authorization`: só servem para URL
 * pública. Quem precisa exibir mídia protegida busca aqui e usa
 * `URL.createObjectURL(blob)` como `src` (ver `useAuthenticatedMedia`).
 *
 * O nome vem junto porque `object URL` não tem nome nenhum: sem ele, baixar a
 * imagem (CRMLAB-26) salvaria o uuid do blob, sem extensão.
 */
export async function fetchAuthenticatedBlob(url: string): Promise<AuthenticatedMedia> {
  const token = bridge.getAccessToken();
  const authHeader = (t: string | null): Record<string, string> =>
    t ? { Authorization: `Bearer ${t}` } : {};

  let response = await fetch(url, { headers: authHeader(token) });
  if (response.status === 401 && token) {
    const refreshed = await refreshAccessToken();
    response = await fetch(url, { headers: authHeader(refreshed) });
  }
  if (!response.ok) {
    throw new ApiError('INTERNAL_ERROR', 'Não foi possível carregar a mídia', response.status);
  }
  return {
    blob: await response.blob(),
    fileName: fileNameFrom(response.headers.get('Content-Disposition')),
  };
}

export function buildQueryString(query?: QueryParams): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized.length > 0 ? `?${serialized}` : '';
}

function toApiError(payload: unknown, statusCode: number): ApiError {
  const envelope = payload as Partial<ApiErrorBody> | null;
  const error = envelope?.error;
  if (error && typeof error.code === 'string') {
    return new ApiError(
      error.code,
      error.message ?? 'Erro inesperado',
      error.statusCode ?? statusCode,
      error.details,
    );
  }
  return new ApiError('INTERNAL_ERROR', 'Erro inesperado no servidor', statusCode);
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const payload = await readBody(response);
  if (!response.ok) {
    throw toApiError(payload, response.status);
  }
  return payload as T;
}

function send(
  path: string,
  options: RequestOptions,
  token: string | null,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json', ...extraHeaders };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  return fetch(`${apiBaseUrl()}${path}${buildQueryString(options.query)}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
}

/**
 * Renova o access token. Chamadas concorrentes compartilham a MESMA promise —
 * 5 requisições que expiram juntas disparam 1 `POST /auth/refresh`, não 5.
 *
 * Usada também no BOOTSTRAP da página (`useSessionBootstrap`, App.tsx):
 * como o access token não é persistido (CRMLAB-32), toda carga de página
 * chama isto para trocar o cookie `crm_refresh` por um access token novo.
 */
export function refreshAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = withCrossTabLock(performRefresh).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/** Nome do lock compartilhado entre abas do mesmo origin para o refresh. */
export const REFRESH_LOCK_NAME = 'crm-lab:auth-refresh';

/**
 * Serializa o refresh ENTRE ABAS (revisão dos PRs #44/#47, CRMLAB-40).
 *
 * `refreshInFlight` deduplica só dentro de uma aba. O cookie `crm_refresh` é
 * um só para o navegador inteiro, e o backend ROTACIONA o token a cada uso:
 * duas abas que chamam `/auth/refresh` ao mesmo tempo (restaurar sessão com
 * várias abas, ou o 4401 do WebSocket chegando em todas no mesmo instante)
 * mandam o MESMO cookie; a primeira rotaciona, a segunda apresenta um token já
 * revogado, e o backend trata como roubo — derruba a família e desloga o
 * usuário de TODAS as abas.
 *
 * Com o Web Locks API, a segunda aba espera a primeira terminar; quando entra,
 * o cookie já é o novo (cookie é compartilhado na hora) e o refresh dela
 * simplesmente funciona. Sem `navigator.locks` (browser antigo, jsdom nos
 * testes) roda direto — o backend ainda tem a janela de tolerância de 10 s
 * (D-166) como rede de segurança.
 */
async function withCrossTabLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return fn();
  return locks.request(REFRESH_LOCK_NAME, fn);
}

/**
 * `X-Requested-With: crm-lab` é exigido pelo backend em `/auth/refresh` como
 * camada extra de proteção CSRF (o cookie sozinho já é `SameSite=Strict` +
 * `Path=/api/v1/auth`, mas um form cross-site não consegue setar este header).
 * Sem `refreshToken` no corpo: o cookie viaja sozinho (same-origin).
 */
async function performRefresh(): Promise<string> {
  let result: RefreshResponse;
  try {
    result = await parseResponse<RefreshResponse>(
      await send(
        '/auth/refresh',
        { method: 'POST', auth: false },
        null,
        { 'X-Requested-With': 'crm-lab' },
      ),
    );
  } catch (error) {
    // Só derruba a sessão em 401 do refresh. Queda de rede não desloga.
    if (isApiError(error) && error.statusCode === 401) return failSession(error);
    throw error;
  }

  bridge.setAccessToken(result.accessToken, result.expiresIn);
  return result.accessToken;
}

function failSession(error: ApiError): never {
  bridge.clearSession();
  onUnauthenticated();
  throw error;
}

/** Requisição tipada. Lança `ApiError` em qualquer 4xx/5xx. */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const useAuth = options.auth !== false;
  const response = await send(path, options, useAuth ? bridge.getAccessToken() : null);

  try {
    return await parseResponse<T>(response);
  } catch (error) {
    if (!useAuth || !isApiError(error) || error.code !== 'TOKEN_EXPIRED') throw error;
    // Interceptor: renova (uma vez, compartilhado) e repete a original.
    const accessToken = await refreshAccessToken();
    return parseResponse<T>(await send(path, options, accessToken));
  }
}

export const http = {
  get: <T>(path: string, query?: QueryParams, options: RequestOptions = {}) =>
    request<T>(path, { ...options, method: 'GET', query }),
  post: <T>(path: string, body?: unknown, options: RequestOptions = {}) =>
    request<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options: RequestOptions = {}) =>
    request<T>(path, { ...options, method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown, options: RequestOptions = {}) =>
    request<T>(path, { ...options, method: 'PUT', body }),
  delete: <T>(path: string, options: RequestOptions = {}) =>
    request<T>(path, { ...options, method: 'DELETE' }),
};
