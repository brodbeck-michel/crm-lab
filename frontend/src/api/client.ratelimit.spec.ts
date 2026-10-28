import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  http,
  onRateLimit,
  rateLimitedUntilMs,
  refreshAccessToken,
  resetApiClient,
  setSessionBridge,
  setUnauthenticatedHandler,
} from './client';
import type { ApiError } from './client';

/**
 * CRMLAB-122 (D-288): 429 no client HTTP. O limitador do backend recusa ANTES
 * de qualquer rota, então repetir é seguro. Regras testadas:
 *  - espera o `Retry-After` e repete, sem erro para quem chamou;
 *  - segura as outras requisições da aba até a janela virar;
 *  - 429 NUNCA limpa a sessão (nem no `/auth/refresh`);
 *  - login não repete (lá o 429 é o lockout fazendo o seu trabalho).
 */

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const tooMany = (retryAfter = 3) =>
  response(
    429,
    { error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Limite', statusCode: 429, details: { retryAfter } } },
    { 'Retry-After': String(retryAfter), 'RateLimit-Reset': String(retryAfter) },
  );

let calls: string[];
let session: { accessToken: string | null; cleared: boolean };

function mockFetch(handler: (path: string, n: number) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = url.split('/api/v1')[1] ?? url;
      calls.push(path);
      return handler(path, calls.filter((c) => c === path).length);
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0); // sem jitter: espera exata
  calls = [];
  resetApiClient();
  session = { accessToken: 'access-1', cleared: false };
  setSessionBridge({
    getAccessToken: () => session.accessToken,
    setAccessToken: (token) => {
      session.accessToken = token;
    },
    clearSession: () => {
      session.cleared = true;
      session.accessToken = null;
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetApiClient();
});

describe('client — 429 com espera e nova tentativa', () => {
  it('GET em 429 espera o Retry-After e repete de forma transparente', async () => {
    mockFetch((_path, n) => (n === 1 ? tooMany(3) : response(200, { ok: true })));

    const promise = http.get<{ ok: boolean }>('/conversations');
    await vi.advanceTimersByTimeAsync(2_900);
    expect(calls).toEqual(['/conversations']); // ainda esperando

    await vi.advanceTimersByTimeAsync(200);
    await expect(promise).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['/conversations', '/conversations']);
    expect(session.cleared).toBe(false);
  });

  it('avisa a UI (onRateLimit) com o prazo da espera', async () => {
    const listener = vi.fn();
    onRateLimit(listener);
    mockFetch((_path, n) => (n === 1 ? tooMany(5) : response(200, {})));

    const promise = http.get('/users/presence');
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(rateLimitedUntilMs()).toBeGreaterThanOrEqual(Date.now() + 4_900);

    await vi.advanceTimersByTimeAsync(5_100);
    await promise;
  });

  it('outras requisições da aba esperam a janela virar em vez de bater no balde vazio', async () => {
    mockFetch((path, n) => (path === '/conversations' && n === 1 ? tooMany(4) : response(200, {})));

    const first = http.get('/conversations');
    await vi.advanceTimersByTimeAsync(0);
    const second = http.get('/quick-replies');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual(['/conversations']); // a segunda nem saiu

    await vi.advanceTimersByTimeAsync(3_100);
    await Promise.all([first, second]);
    expect(calls).toContain('/quick-replies');
  });

  it('429 persistente desiste depois de 3 tentativas com RATE_LIMIT_EXCEEDED, sem deslogar', async () => {
    const onUnauthenticated = vi.fn();
    setUnauthenticatedHandler(onUnauthenticated);
    mockFetch(() => tooMany(2));

    const promise = http.get('/conversations').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = (await promise) as ApiError;

    expect(error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(calls).toHaveLength(3);
    expect(session.cleared).toBe(false);
    expect(onUnauthenticated).not.toHaveBeenCalled();
  });

  it('login NÃO repete o 429 (lockout por IP)', async () => {
    mockFetch(() => tooMany(30));

    const error = (await http
      .post('/auth/login', { email: 'a@b.c', password: 'x' }, { auth: false })
      .catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(calls).toEqual(['/auth/login']);
  });
});

describe('client — 429 no /auth/refresh NUNCA leva ao logout', () => {
  it('refresh em 429 espera e repete; a sessão sobrevive', async () => {
    const onUnauthenticated = vi.fn();
    setUnauthenticatedHandler(onUnauthenticated);
    mockFetch((_path, n) =>
      n === 1 ? tooMany(2) : response(200, { accessToken: 'access-2', expiresIn: 900 }),
    );

    const promise = refreshAccessToken();
    await vi.advanceTimersByTimeAsync(2_100);

    await expect(promise).resolves.toBe('access-2');
    expect(session.accessToken).toBe('access-2');
    expect(session.cleared).toBe(false);
    expect(onUnauthenticated).not.toHaveBeenCalled();
  });

  it('refresh em 429 até esgotar: falha sem limpar a sessão nem chamar o handler de login', async () => {
    const onUnauthenticated = vi.fn();
    setUnauthenticatedHandler(onUnauthenticated);
    mockFetch(() => tooMany(1));

    const promise = refreshAccessToken().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    const error = (await promise) as ApiError;

    expect(error.statusCode).toBe(429);
    expect(calls).toHaveLength(6); // o refresh insiste mais que um GET comum
    expect(session.cleared).toBe(false);
    expect(onUnauthenticated).not.toHaveBeenCalled();
  });

  it('TOKEN_EXPIRED → refresh em 429 → repete → original sai com o token novo', async () => {
    mockFetch((path, n) => {
      if (path === '/auth/refresh') {
        return n === 1 ? tooMany(1) : response(200, { accessToken: 'access-2', expiresIn: 900 });
      }
      if (n === 1) {
        return response(401, { error: { code: 'TOKEN_EXPIRED', message: 'exp', statusCode: 401 } });
      }
      return response(200, { items: [] });
    });

    const promise = http.get('/conversations');
    await vi.advanceTimersByTimeAsync(1_100);

    await expect(promise).resolves.toEqual({ items: [] });
    expect(calls).toEqual(['/conversations', '/auth/refresh', '/auth/refresh', '/conversations']);
    expect(session.cleared).toBe(false);
  });
});
