import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api';
import { mutationIdle } from '@/test/query-mocks';
import { useAuthStore } from '@/stores/auth.store';
import * as usersApi from '@/api/users';
import * as client from '@/api/client';
import { ChangePassword } from './ChangePassword';

vi.mock('@/api/users', async () => {
  const actual = await vi.importActual('@/api/users');
  return { ...actual, useChangePassword: vi.fn() };
});
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual('@/api/client');
  return { ...actual, refreshAccessToken: vi.fn(async () => 'access-novo') };
});

const useChangePassword = vi.mocked(usersApi.useChangePassword);
const refreshAccessToken = vi.mocked(client.refreshAccessToken);

const PROVISORIA = 'kQ7f2m9Xp1zR-a3B';
const NOVA = 'ipê-amarelo-2026';

function signIn(mustChangePassword = true) {
  useAuthStore.setState({
    user: {
      id: 'u-1',
      email: 'diana@lab.com',
      name: 'Diana',
      role: 'attendant',
      discountLimit: 15,
      mustChangePassword,
    },
  });
}

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/change-password']}>
        <Routes>
          <Route path="/change-password" element={<ChangePassword />} />
          <Route path="*" element={<p>home do papel</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function preencher(atual: string, nova: string, confirmar = nova) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Senha provisória'), atual);
  await user.type(screen.getByLabelText('Nova senha'), nova);
  await user.type(screen.getByLabelText('Confirmar nova senha'), confirmar);
  await user.click(screen.getByRole('button', { name: 'Salvar nova senha' }));
}

describe('ChangePassword (/change-password, CRMLAB-186)', () => {
  let mutateAsync: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mutateAsync = vi.fn(async () => ({ message: 'Senha alterada com sucesso' }));
    useChangePassword.mockReturnValue({ ...mutationIdle(), mutateAsync } as unknown as ReturnType<
      typeof usersApi.useChangePassword
    >);
  });

  it('troca a senha, renova o token, desliga a flag e segue para a home', async () => {
    signIn();
    renderPage();

    await preencher(PROVISORIA, NOVA);

    expect(mutateAsync).toHaveBeenCalledWith({ currentPassword: PROVISORIA, newPassword: NOVA });
    await waitFor(() => expect(screen.getByText('home do papel')).toBeInTheDocument());
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().user?.mustChangePassword).toBe(false);
  });

  it('confirmação divergente não chama a API', async () => {
    signIn();
    renderPage();

    await preencher(PROVISORIA, NOVA, 'outra-coisa-123');

    expect(screen.getByText('As senhas não conferem')).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('senha provisória errada aparece no campo e a flag continua ligada', async () => {
    mutateAsync.mockRejectedValueOnce(
      new ApiError('VALIDATION_ERROR', 'Dados invalidos', 400, {
        fields: { currentPassword: 'Senha atual incorreta' },
      }),
    );
    signIn();
    renderPage();

    await preencher('errada-123456', NOVA);

    expect(await screen.findByText('Senha provisória incorreta')).toBeInTheDocument();
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(useAuthStore.getState().user?.mustChangePassword).toBe(true);
  });

  it('sem a flag, redireciona para a home', () => {
    signIn(false);
    renderPage();
    expect(screen.getByText('home do papel')).toBeInTheDocument();
  });
});
