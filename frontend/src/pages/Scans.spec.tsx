import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scan } from '@crm-lab/shared';
import { ToastProvider } from '@/components/ui';
import { useAuthStore } from '@/stores';
import Scans from './Scans';

/** Digitalizações — `/scans` (PAGES.md §24a, CRMLAB-184). fetch mockado como no Attendance.scans.spec. */

const now = Date.now();
function scan(id: string, minutesAgo: number): Scan {
  return {
    id,
    deviceId: 'd-1',
    deviceName: 'Celular recepção',
    fileName: `digitalizacao-${id}.jpg`,
    mimeType: 'image/jpeg',
    byteSize: 1000,
    contentUrl: `/api/v1/scans/${id}/content`,
    createdAt: new Date(now - minutesAgo * 60_000).toISOString(),
    expiresAt: new Date(now + 86_400_000).toISOString(),
  };
}

let queue: Scan[] = [];
const fetchCalls: Array<{ url: string; method: string }> = [];

function fakeResponse(status: number, body?: unknown, blob?: Blob): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body)),
    blob: () => Promise.resolve(blob ?? new Blob()),
  } as unknown as Response;
}

const fetchMock = vi.fn((input: string, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  fetchCalls.push({ url, method });
  if (/\/scans\/[^/]+\/content$/.test(url)) {
    return Promise.resolve(fakeResponse(200, undefined, new Blob(['jpg'], { type: 'image/jpeg' })));
  }
  const one = /\/scans\/([^/?]+)$/.exec(url);
  if (one && method === 'DELETE') {
    queue = queue.filter((item) => item.id !== one[1]);
    return Promise.resolve(fakeResponse(204));
  }
  if (/\/scans(\?|$)/.test(url)) {
    return Promise.resolve(
      fakeResponse(200, { scans: queue, pagination: { page: 1, limit: 50, total: queue.length, totalPages: 1 } }),
    );
  }
  return Promise.resolve(fakeResponse(404, { error: { code: 'NOT_FOUND', message: 'x', statusCode: 404 } }));
});

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/scans']}>
          <Scans />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  queue = [scan('s-2', 3), scan('s-1', 12)];
  fetchCalls.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  useAuthStore.setState({ tokens: { accessToken: 'a', expiresAt: Date.now() + 60_000 } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Digitalizações (/scans)', () => {
  it('lista a fila com "há X min · dispositivo"', async () => {
    renderScreen();
    expect(await screen.findAllByTestId('scan-card')).toHaveLength(2);
    expect(screen.getByText('há 12 min · Celular recepção')).toBeInTheDocument();
    expect(screen.getByText('há 3 min · Celular recepção')).toBeInTheDocument();
  });

  it('fila vazia mostra o aviso', async () => {
    queue = [];
    renderScreen();
    expect(await screen.findByText('Nenhuma foto. Tire pelo atalho Digitalizar no celular.')).toBeInTheDocument();
  });

  it('lixeira pede confirmação e faz DELETE /scans/:id', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderScreen();
    await userEvent.click(await screen.findByRole('button', { name: 'Descartar foto de há 12 min' }));
    await waitFor(() =>
      expect(fetchCalls).toContainEqual({ url: expect.stringMatching(/\/scans\/s-1$/), method: 'DELETE' }),
    );
    await waitFor(() => expect(screen.getAllByTestId('scan-card')).toHaveLength(1));
  });

  it('cancelar a confirmação não descarta', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderScreen();
    await userEvent.click(await screen.findByRole('button', { name: 'Descartar foto de há 12 min' }));
    expect(fetchCalls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('clicar na miniatura abre a foto ampliada', async () => {
    renderScreen();
    await userEvent.click(await screen.findByRole('button', { name: /Ampliar foto de há 3 min/ }));
    expect(await screen.findByTestId('image-lightbox-backdrop')).toBeInTheDocument();
    expect(screen.getByTestId('image-lightbox-title')).toHaveTextContent('Celular recepção');
  });
});
