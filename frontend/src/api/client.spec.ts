import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiErrorBody } from '@crm-lab/shared';
import {
  http,
  isApiError,
  request,
  resetApiClient,
  resolveMediaUrl,
  setSessionBridge,
  setUnauthenticatedHandler,
} from './client';
import type { ApiError } from './client';

/**
 * Contrato do client HTTP:
 *  - injeta `Authorization: Bearer`
 *  - converte o envelope de API_ERRORS.md em `ApiError` tipada
 *  - `401 TOKEN_EXPIRED` → refresh → repete a original de forma transparente
 *  - N requisições concorrentes compartilham UM único refresh
 *  - `REFRESH_TOKEN_INVALID` limpa a sessão
 */

interface FakeCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

function errorResponse(body: ApiErrorBody): Response {
  return jsonResponse(body, body.error.statusCode);
}

function headerOf(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

/** Acesso a uma chamada registrada, falhando alto se ela não existir. */
function call(index: number): FakeCall {
  const found = calls[index];
  if (!found) throw new Error(`fetch #${index} não aconteceu (total: ${calls.length})`);
  return found;
}

let calls: FakeCall[];
let session: { accessToken: string | null; refreshToken: string | null; cleared: boolean };

function installSession(accessToken: string | null, refreshToken: string | null): void {
  session = { accessToken, refreshToken, cleared: false };
  setSessionBridge({
    getAccessToken: () => session.accessToken,
    getRefreshToken: () => session.refreshToken,
    setAccessToken: (token) => {
      session.accessToken = token;
    },
    clearSession: () => {
      session.cleared = true;
      session.accessToken = null;
      session.refreshToken = null;
    },
  });
}

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return handler(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  calls = [];
  resetApiClient();
  installSession('access-1', 'refresh-1');
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
});

describe('client — requisição', () => {
  it('injeta o header Authorization com o access token da sessão', async () => {
    mockFetch(() => jsonResponse({ exams: [] }));

    await http.get('/exams');

    expect(headerOf(call(0).init, 'Authorization')).toBe('Bearer access-1');
  });

  it('não injeta Authorization quando auth: false (login)', async () => {
    mockFetch(() => jsonResponse({ accessToken: 'x' }));

    await request('/auth/login', { method: 'POST', body: {}, auth: false });

    expect(headerOf(call(0).init, 'Authorization')).toBeUndefined();
  });

  it('serializa query string ignorando undefined e vazio', async () => {
    mockFetch(() => jsonResponse({ exams: [] }));

    await http.get('/exams', { active: true, search: undefined, category: '' });

    expect(call(0).url).toContain('/exams?active=true');
    expect(call(0).url).not.toContain('search');
    expect(call(0).url).not.toContain('category');
  });

  it('converte o envelope de erro em ApiError com o code certo', async () => {
    mockFetch(() =>
      errorResponse({
        error: {
          code: 'DISCOUNT_EXCEEDS_LIMIT',
          message: 'Desconto solicitado excede sua alçada',
          statusCode: 403,
          details: { requestedDiscount: 25, userLimit: 15, approvalRequired: true },
        },
      }),
    );

    const error = await http.post('/proposals', {}).catch((e: unknown) => e);

    expect(isApiError(error)).toBe(true);
    const apiError = error as ApiError;
    expect(apiError.code).toBe('DISCOUNT_EXCEEDS_LIMIT');
    expect(apiError.statusCode).toBe(403);
    expect(apiError.details).toEqual({
      requestedDiscount: 25,
      userLimit: 15,
      approvalRequired: true,
    });
  });

  it('corpo sem envelope conhecido vira INTERNAL_ERROR', async () => {
    mockFetch(() => jsonResponse('<html>502</html>', 502));

    const error = (await http.get('/exams').catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.statusCode).toBe(502);
  });
});

describe('client — interceptor de refresh', () => {
  const tokenExpired: ApiErrorBody = {
    error: { code: 'TOKEN_EXPIRED', message: 'Token expirado', statusCode: 401 },
  };

  it('401 TOKEN_EXPIRED dispara refresh e repete a original com o token novo', async () => {
    let expired = true;
    mockFetch((url) => {
      if (url.includes('/auth/refresh')) {
        return jsonResponse({ accessToken: 'access-2', expiresIn: 900 });
      }
      if (expired) {
        expired = false;
        return errorResponse(tokenExpired);
      }
      return jsonResponse({ conversations: [] });
    });

    const result = await http.get<{ conversations: unknown[] }>('/conversations');

    expect(result).toEqual({ conversations: [] });
    expect(calls.map((c) => c.url.split('/api/v1')[1] ?? c.url)).toEqual([
      '/conversations',
      '/auth/refresh',
      '/conversations',
    ]);
    // O retry vai com o token NOVO.
    expect(headerOf(call(2).init, 'Authorization')).toBe('Bearer access-2');
    expect(session.accessToken).toBe('access-2');
  });

  it('N requisições concorrentes em 401 disparam UM ÚNICO refresh', async () => {
    const expiredOnce = new Set<string>();
    mockFetch((url) => {
      if (url.includes('/auth/refresh')) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(jsonResponse({ accessToken: 'access-2', expiresIn: 900 })), 5);
        });
      }
      if (!expiredOnce.has(url)) {
        expiredOnce.add(url);
        return errorResponse(tokenExpired);
      }
      return jsonResponse({ ok: url });
    });

    await Promise.all([
      http.get('/conversations'),
      http.get('/proposals'),
      http.get('/exams'),
      http.get('/analytics/pipeline'),
      http.get('/users/me'),
    ]);

    const refreshCalls = calls.filter((c) => c.url.includes('/auth/refresh'));
    expect(refreshCalls).toHaveLength(1);
    // 5 originais + 1 refresh + 5 retries
    expect(calls).toHaveLength(11);
  });

  it('REFRESH_TOKEN_INVALID limpa a sessão e avisa o app', async () => {
    const onUnauthenticated = vi.fn();
    setUnauthenticatedHandler(onUnauthenticated);

    mockFetch((url) => {
      if (url.includes('/auth/refresh')) {
        return errorResponse({
          error: {
            code: 'REFRESH_TOKEN_INVALID',
            message: 'Sessão expirada',
            statusCode: 401,
          },
        });
      }
      return errorResponse(tokenExpired);
    });

    const error = (await http.get('/conversations').catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('REFRESH_TOKEN_INVALID');
    expect(session.cleared).toBe(true);
    expect(session.accessToken).toBeNull();
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
  });

  it('sem refresh token guardado, nem tenta renovar', async () => {
    installSession('access-1', null);
    mockFetch(() => errorResponse(tokenExpired));

    const error = (await http.get('/conversations').catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('REFRESH_TOKEN_INVALID');
    expect(calls.filter((c) => c.url.includes('/auth/refresh'))).toHaveLength(0);
    expect(session.cleared).toBe(true);
  });

  it('falha de rede no refresh NÃO derruba a sessão', async () => {
    mockFetch((url) => {
      if (url.includes('/auth/refresh')) throw new Error('network down');
      return errorResponse(tokenExpired);
    });

    await expect(http.get('/conversations')).rejects.toThrow('network down');
    expect(session.cleared).toBe(false);
  });

  it('401 que não é TOKEN_EXPIRED sobe direto, sem refresh', async () => {
    mockFetch(() =>
      errorResponse({
        error: { code: 'INVALID_CREDENTIALS', message: 'Credenciais inválidas', statusCode: 401 },
      }),
    );

    const error = (await http.post('/auth/login', {}).catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('INVALID_CREDENTIALS');
    expect(calls.filter((c) => c.url.includes('/auth/refresh'))).toHaveLength(0);
  });
});

/**
 * `resolveMediaUrl` — regressão do crash "Invalid base URL".
 *
 * O build de produção usa `VITE_API_URL=/api/v1` (relativa), e `new URL` só
 * aceita base ABSOLUTA: abrir uma conversa com anexo derrubava a tela inteira.
 * Em dev a variável é absoluta, então nenhum teste até aqui tocava o caso que
 * quebra — por isso este bloco cobre os DOIS formatos de base.
 */
describe('resolveMediaUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('base RELATIVA (build de produção) resolve no origin da janela', () => {
    vi.stubEnv('VITE_API_URL', '/api/v1');

    expect(resolveMediaUrl('/api/v1/media/abc')).toBe(
      `${window.location.origin}/api/v1/media/abc`,
    );
  });

  it('base ABSOLUTA (dev, backend em outra porta) troca só o origin', () => {
    vi.stubEnv('VITE_API_URL', 'http://localhost:3300/api/v1');

    expect(resolveMediaUrl('/api/v1/media/abc')).toBe('http://localhost:3300/api/v1/media/abc');
  });

  it('URL já absoluta passa intacta', () => {
    vi.stubEnv('VITE_API_URL', '/api/v1');

    expect(resolveMediaUrl('https://cdn.exemplo.com/foto.png')).toBe(
      'https://cdn.exemplo.com/foto.png',
    );
  });
});
