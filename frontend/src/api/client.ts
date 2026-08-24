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
  getRefreshToken: () => string | null;
  setAccessToken: (accessToken: string, expiresIn: number) => void;
  clearSession: () => void;
}

const NULL_BRIDGE: SessionBridge = {
  getAccessToken: () => null,
  getRefreshToken: () => null,
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

function send(path: string, options: RequestOptions, token: string | null): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
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
 */
export function refreshAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = performRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function performRefresh(): Promise<string> {
  const refreshToken = bridge.getRefreshToken();
  if (!refreshToken) {
    return failSession(
      new ApiError('REFRESH_TOKEN_INVALID', 'Sessão expirada. Faça login novamente.', 401),
    );
  }

  let result: RefreshResponse;
  try {
    result = await parseResponse<RefreshResponse>(
      await send('/auth/refresh', { method: 'POST', body: { refreshToken }, auth: false }, null),
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
