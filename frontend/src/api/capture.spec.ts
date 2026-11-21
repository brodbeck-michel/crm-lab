import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureApi } from './capture';
import { isApiError, resetApiClient, setSessionBridge, setUnauthenticatedHandler } from './client';

/**
 * Captura do celular (CRMLAB-184, D-327): sem Bearer, cookie do dispositivo
 * (`credentials: 'include'`) e SEM refresh no 401 — não é sessão de usuário.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  resetApiClient();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  // Mesmo com um usuário logado na aba, o celular não manda o token dele.
  setSessionBridge({
    getAccessToken: () => 'token-de-usuario',
    setAccessToken: () => undefined,
    clearSession: () => undefined,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
});

describe('captureApi', () => {
  it('session: GET /capture/session com credentials include e sem Authorization', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ deviceName: 'Celular', tenantName: 'Lab' }));
    await expect(captureApi.session()).resolves.toEqual({ deviceName: 'Celular', tenantName: 'Lab' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/capture\/session$/);
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('401 CAPTURE_DEVICE_UNPAIRED vira ApiError sem chamar /auth/refresh nem deslogar', async () => {
    const onUnauthenticated = vi.fn();
    setUnauthenticatedHandler(onUnauthenticated);
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'CAPTURE_DEVICE_UNPAIRED',
            message: 'Dispositivo não pareado',
            statusCode: 401,
          },
        },
        401,
      ),
    );
    const error: unknown = await captureApi.uploadScan({ mimeType: 'image/jpeg', contentBase64: 'AA==' }).catch(
      (caught: unknown) => caught,
    );
    expect(isApiError(error) && error.code).toBe('CAPTURE_DEVICE_UNPAIRED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUnauthenticated).not.toHaveBeenCalled();
  });

  it('pair: POST /capture/pair com o código', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ deviceName: 'Celular', tenantName: 'Lab' }));
    await captureApi.pair({ code: 'K7MX4QPR' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/capture\/pair$/);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ code: 'K7MX4QPR' }));
    expect(init.credentials).toBe('include');
  });
});
