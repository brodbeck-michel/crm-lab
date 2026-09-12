import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attendant, ChannelSettingsResponse, ListAttendantsResponse, UserRole } from '@crm-lab/shared';
import { querySuccess, mutationIdle } from '@/test/query-mocks';
import { settingsApi } from '@/api/settings';
import { ToastProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth.store';
import Attendants from './Attendants';
import * as attendantsApi from '@/api/attendants';

vi.mock('@/api/attendants', async () => {
  const actual = await vi.importActual('@/api/attendants');
  return {
    ...actual,
    useAttendantList: vi.fn(),
    useCreateAttendant: vi.fn(),
    useUpdateAttendant: vi.fn(),
  };
});

vi.mock('@/api/settings', () => ({
  settingsApi: { channels: vi.fn(), updateChannels: vi.fn() },
}));

const useAttendantList = vi.mocked(attendantsApi.useAttendantList);
const useCreateAttendant = vi.mocked(attendantsApi.useCreateAttendant);
const useUpdateAttendant = vi.mocked(attendantsApi.useUpdateAttendant);
const channelsMock = vi.mocked(settingsApi.channels);

const maria: Attendant = {
  id: 'a-1',
  name: 'Maria Souza',
  isActive: true,
  userId: null,
  userName: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
};

const channelSettings: ChannelSettingsResponse = {
  channels: [],
  distributionMode: 'manual',
  autoMessages: { greeting: { enabled: false, message: null }, offHours: { enabled: false, message: null } },
  businessHours: { timezone: 'America/Sao_Paulo', days: {} },
  team: [{ id: 'u-9', name: 'Ana Gestora', role: 'manager', isActive: true }],
};

function listResult(overrides: Partial<ListAttendantsResponse> = {}) {
  return querySuccess<ListAttendantsResponse>({
    attendants: [maria],
    pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    ...overrides,
  });
}

function signIn(role: UserRole) {
  useAuthStore.setState({
    user: { id: 'user-9', email: 'quem@lab.com.br', name: 'Quem', role, discountLimit: 10 },
  });
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <Attendants />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Attendants (/settings/attendants)', () => {
  const mockCreate = vi.fn();
  const mockUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useAttendantList.mockReturnValue(listResult());
    useCreateAttendant.mockReturnValue(mutationIdle(mockCreate));
    useUpdateAttendant.mockReturnValue(mutationIdle(mockUpdate));
    channelsMock.mockResolvedValue(channelSettings);
  });

  afterEach(() => {
    useAuthStore.setState({ user: null });
  });

  it('lista atendentes com o vínculo de usuário (ou "— sem login —")', async () => {
    signIn('manager');
    renderPage();

    expect(await screen.findByText('Maria Souza')).toBeInTheDocument();
    expect(screen.getByText('— sem login —')).toBeInTheDocument();
  });

  it('atendente não vê botão de novo atendente nem coluna de ações', async () => {
    signIn('attendant');
    renderPage();

    await screen.findByText('Maria Souza');
    expect(screen.queryByRole('button', { name: /novo atendente/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /editar/i })).not.toBeInTheDocument();
  });

  it('gestor cria um atendente novo, sem login vinculado', async () => {
    const user = userEvent.setup();
    signIn('manager');
    renderPage();

    await user.click(await screen.findByRole('button', { name: /novo atendente/i }));
    await user.type(screen.getByLabelText('Nome'), 'Ana Lima');
    await user.click(screen.getByRole('button', { name: /^criar$/i }));

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({ name: 'Ana Lima', userId: null });
  });

  it('edita o atendente e desativa via o Toggle', async () => {
    const user = userEvent.setup();
    signIn('admin');
    renderPage();

    await user.click(await screen.findByRole('button', { name: /editar/i }));
    expect(screen.getByLabelText('Nome')).toHaveValue('Maria Souza');

    await waitFor(() => expect(screen.getByLabelText('Usuário vinculado')).toBeInTheDocument());
    await user.click(screen.getByRole('switch', { name: /ativo/i }));
    await user.click(screen.getByRole('button', { name: /atualizar/i }));

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0]?.[0]).toMatchObject({
      id: 'a-1',
      dto: { isActive: false },
    });
  });

  it('vincula um login existente lido de GET /settings/channels (team), não de GET /users', async () => {
    const user = userEvent.setup();
    signIn('admin');
    renderPage();

    await user.click(await screen.findByRole('button', { name: /editar/i }));
    await waitFor(() => expect(screen.getByLabelText('Usuário vinculado')).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Usuário vinculado'), 'u-9');
    await user.click(screen.getByRole('button', { name: /atualizar/i }));

    expect(mockUpdate.mock.calls[0]?.[0]).toMatchObject({ dto: { userId: 'u-9' } });
  });
});
