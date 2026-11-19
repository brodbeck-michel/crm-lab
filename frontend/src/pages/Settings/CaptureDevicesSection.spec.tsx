import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureDevice } from '@crm-lab/shared';
import { ToastProvider } from '@/components/ui';
import { CaptureDevicesSection, REVOKE_CONFIRM } from './CaptureDevicesSection';

/**
 * Dispositivos de captura em Canais & Equipe (PAGES.md §10, CRMLAB-184):
 * admin edita, gestor só lê. `fetch` mockado — rotas de API_CONTRACTS §15.1.
 */

const now = Date.now();
function device(overrides: Partial<CaptureDevice>): CaptureDevice {
  return {
    id: 'd-1',
    name: 'Celular recepção',
    status: 'active',
    pairingCodeExpiresAt: null,
    pairedAt: new Date(now - 86_400_000).toISOString(),
    lastUsedAt: new Date(now - 5 * 60_000).toISOString(),
    pendingScans: 3,
    createdAt: new Date(now - 2 * 86_400_000).toISOString(),
    ...overrides,
  };
}

let devices: CaptureDevice[] = [];
const calls: Array<{ url: string; method: string; body: unknown }> = [];

function fakeResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

const pairing = { code: 'K7MX4QPR', expiresAt: new Date(now + 15 * 60_000).toISOString() };

const fetchMock = vi.fn((input: string, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ url, method, body });
  if (method === 'GET' && /\/settings\/capture-devices$/.test(url)) {
    return Promise.resolve(
      fakeResponse(200, {
        devices,
        pagination: { page: 1, limit: 50, total: devices.length, totalPages: 1 },
      }),
    );
  }
  if (method === 'POST' && /\/settings\/capture-devices$/.test(url)) {
    const created = device({
      id: 'd-new',
      name: (body as { name: string }).name,
      status: 'pending',
      pairedAt: null,
      lastUsedAt: null,
      pendingScans: 0,
    });
    devices = [created, ...devices];
    return Promise.resolve(fakeResponse(201, { device: created, pairing }));
  }
  if (method === 'POST' && /\/pairing-code$/.test(url)) {
    return Promise.resolve(fakeResponse(200, { ...pairing, code: 'ABCD2345' }));
  }
  if (method === 'DELETE') {
    devices = devices.map((item) =>
      url.endsWith(item.id) ? { ...item, status: 'revoked' as const } : item,
    );
    return Promise.resolve(fakeResponse(204));
  }
  return Promise.resolve(fakeResponse(404));
});

function renderSection(canEdit: boolean) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <CaptureDevicesSection canEdit={canEdit} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  devices = [
    device({}),
    device({ id: 'd-2', name: 'Celular coleta', status: 'pending', lastUsedAt: null, pendingScans: 0 }),
    device({ id: 'd-3', name: 'Celular antigo', status: 'revoked', pendingScans: 1 }),
  ];
  calls.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Dispositivos de captura', () => {
  it('lista nome, situação, último envio e fotos na fila', async () => {
    renderSection(true);
    const row = (await screen.findByText('Celular recepção')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Ativo')).toBeInTheDocument();
    expect(within(row).getByText('há 5 min')).toBeInTheDocument();
    expect(within(row).getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Aguardando pareamento')).toBeInTheDocument();
    expect(screen.getByText('Revogado')).toBeInTheDocument();
    expect(screen.getByText('Nunca')).toBeInTheDocument();
  });

  it('gestor lê sem nenhum botão', async () => {
    renderSection(false);
    await screen.findByText('Celular recepção');
    expect(screen.queryByRole('button', { name: 'Novo dispositivo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Gerar novo código' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revogar' })).not.toBeInTheDocument();
  });

  it('admin: revogado não tem ações; os outros têm Gerar novo código e Revogar', async () => {
    renderSection(true);
    const revoked = (await screen.findByText('Celular antigo')).closest('tr') as HTMLElement;
    expect(within(revoked).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Revogar' })).toHaveLength(2);
  });

  it('Novo dispositivo: nome → código grande, contagem de 15 min e a URL /digitalizar', async () => {
    renderSection(true);
    await screen.findByText('Celular recepção');
    await userEvent.click(screen.getByRole('button', { name: 'Novo dispositivo' }));
    await userEvent.type(screen.getByLabelText('Nome do dispositivo'), '  Celular balcão  ');
    await userEvent.click(screen.getByRole('button', { name: 'Gerar código' }));

    const modal = await screen.findByRole('dialog', { name: 'Parear Celular balcão' });
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({ name: 'Celular balcão' });
    expect(within(modal).getByTestId('pairing-code')).toHaveTextContent('K7MX-4QPR');
    expect(within(modal).getByText(/Vale por 1[45]:\d\d/)).toBeInTheDocument();
    expect(within(modal).getByText(`${window.location.origin}/digitalizar`)).toBeInTheDocument();
    expect(within(modal).getByText('Adicionar à Tela de Início')).toBeInTheDocument();
    // A lista é reconsultada com o novo, aguardando pareamento.
    await waitFor(() =>
      expect(calls.filter((call) => call.method === 'GET').length).toBeGreaterThanOrEqual(2),
    );
  });

  it('Gerar novo código abre o modal com o código renovado', async () => {
    renderSection(true);
    const row = (await screen.findByText('Celular coleta')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Gerar novo código' }));
    const modal = await screen.findByRole('dialog', { name: 'Parear Celular coleta' });
    expect(within(modal).getByTestId('pairing-code')).toHaveTextContent('ABCD-2345');
    expect(calls.some((call) => call.url.endsWith('/settings/capture-devices/d-2/pairing-code'))).toBe(true);
  });

  it('Revogar pede confirmação com o texto do contrato; cancelar não chama a API', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderSection(true);
    const row = (await screen.findByText('Celular recepção')).closest('tr') as HTMLElement;

    await userEvent.click(within(row).getByRole('button', { name: 'Revogar' }));
    expect(confirm).toHaveBeenCalledWith(REVOKE_CONFIRM);
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);

    await userEvent.click(within(row).getByRole('button', { name: 'Revogar' }));
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ method: 'DELETE', url: expect.stringMatching(/\/settings\/capture-devices\/d-1$/) }),
      ),
    );
    expect(REVOKE_CONFIRM).toBe(
      'O celular para de enviar na hora. As fotos que já estão na fila continuam.',
    );
  });
});
