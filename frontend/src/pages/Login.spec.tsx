import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginResponse } from '@crm-lab/shared';
import type * as ApiModule from '@/api';
import type * as ThemeModule from '@/lib/theme';

const loginMock = vi.fn();
const applyThemeMock = vi.fn();

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: { ...actual.api, auth: { ...actual.api.auth, login: loginMock } },
  };
});

vi.mock('@/lib/theme', async (importOriginal) => {
  const actual = await importOriginal<typeof ThemeModule>();
  return { ...actual, applyTheme: applyThemeMock };
});

const { ApiError } = await import('@/api');
const { useAuthStore } = await import('@/stores');
const { Login, GENERIC_CREDENTIALS_ERROR, EMPTY_FIELDS_ERROR } = await import('./Login');

/**
 * Login — PAGES.md §1.
 * O ponto sensível é o erro: uma frase só, para e-mail inexistente E senha
 * errada. E o tema tem de vir do PAYLOAD do login, sem request extra.
 */

const THEME = {
  accent: 'var(--a)',
  accent2: 'var(--a2)',
  bg: 'var(--bg)',
  surface: 'var(--surface)',
  text: 'var(--text)',
  fontId: 'figtree',
  radiusId: 'suave',
  brandName: 'Vida',
  logoUrl: null,
} as const;

const RESPONSE: LoginResponse = {
  accessToken: 'access-1',
  expiresIn: 900,
  user: {
    id: 'u-1',
    email: 'marina@lab.com',
    name: 'Marina Alves',
    role: 'attendant',
    discountLimit: 15,
  },
  tenant: { id: 't-1', name: 'Lab Vida', slug: 'vida', theme: { ...THEME } },
};

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

function renderLogin(state?: { from?: string }) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/login', state: state ?? null }]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<span>outra tela</span>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

async function fillAndSubmit(email: string, password: string) {
  await userEvent.type(screen.getByLabelText('E-mail'), email);
  await userEvent.type(screen.getByLabelText('Senha'), password);
  await userEvent.click(screen.getByRole('button', { name: /Entrar/ }));
}

beforeEach(() => {
  loginMock.mockReset();
  applyThemeMock.mockReset();
  localStorage.clear();
  useAuthStore.setState({ user: null, tenant: null, theme: null, tokens: null });
});

describe('Login', () => {
  it('submete e guarda a sessão', async () => {
    loginMock.mockResolvedValue(RESPONSE);
    renderLogin();

    await fillAndSubmit('marina@lab.com', 'senha123');

    expect(loginMock).toHaveBeenCalledWith({ email: 'marina@lab.com', password: 'senha123' });
    await waitFor(() => {
      expect(useAuthStore.getState().tokens?.accessToken).toBe('access-1');
    });
    expect(useAuthStore.getState().user?.id).toBe('u-1');
  });

  it('aplica o TEMA que veio no response do login (sem request extra)', async () => {
    loginMock.mockResolvedValue(RESPONSE);
    renderLogin();

    await fillAndSubmit('marina@lab.com', 'senha123');

    await waitFor(() => {
      expect(applyThemeMock).toHaveBeenCalledWith(RESPONSE.tenant.theme);
    });
  });

  it('redireciona pelo papel (atendente → /attendance)', async () => {
    loginMock.mockResolvedValue(RESPONSE);
    renderLogin();

    await fillAndSubmit('marina@lab.com', 'senha123');

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/attendance');
    });
  });

  it('volta para a rota de onde o guard tirou o usuário', async () => {
    loginMock.mockResolvedValue(RESPONSE);
    renderLogin({ from: '/catalog' });

    await fillAndSubmit('marina@lab.com', 'senha123');

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/catalog');
    });
  });

  it('erro mostra mensagem GENÉRICA — não revela se o e-mail existe', async () => {
    loginMock.mockRejectedValue(new ApiError('INVALID_CREDENTIALS', 'Invalid password', 401));
    renderLogin();

    await fillAndSubmit('marina@lab.com', 'errada');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(GENERIC_CREDENTIALS_ERROR);
    expect(alert.textContent).not.toMatch(/senha|e-?mail|usuário/i);
    expect(useAuthStore.getState().tokens).toBeNull();
  });

  it('e-mail inexistente produz EXATAMENTE a mesma mensagem', async () => {
    loginMock.mockRejectedValue(new ApiError('INVALID_CREDENTIALS', 'User not found', 401));
    renderLogin();

    await fillAndSubmit('ninguem@lab.com', 'qualquer');

    expect(await screen.findByRole('alert')).toHaveTextContent(GENERIC_CREDENTIALS_ERROR);
  });

  it('conta inativa também não vira oráculo', async () => {
    loginMock.mockRejectedValue(new ApiError('USER_INACTIVE', 'inactive', 403));
    renderLogin();

    await fillAndSubmit('marina@lab.com', 'senha123');

    expect(await screen.findByRole('alert')).toHaveTextContent(GENERIC_CREDENTIALS_ERROR);
  });

  it('campo vazio nem chega ao servidor', async () => {
    renderLogin();

    await userEvent.click(screen.getByRole('button', { name: /Entrar/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(EMPTY_FIELDS_ERROR);
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('estado de carregando bloqueia o botão', async () => {
    let resolve: ((value: LoginResponse) => void) | undefined;
    loginMock.mockImplementation(
      () =>
        new Promise<LoginResponse>((r) => {
          resolve = r;
        }),
    );
    renderLogin();

    await fillAndSubmit('marina@lab.com', 'senha123');

    const button = screen.getByRole('button', { name: /Entrando/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');

    resolve?.(RESPONSE);
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/attendance');
    });
  });
});
