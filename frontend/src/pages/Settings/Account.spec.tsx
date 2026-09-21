import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserRole } from '@crm-lab/shared';
import { mutationIdle } from '@/test/query-mocks';
import { ToastProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth.store';
import Account from './Account';
import * as usersApi from '@/api/users';

vi.mock('@/api/users', async () => {
  const actual = await vi.importActual('@/api/users');
  return { ...actual, useChangePassword: vi.fn() };
});

const useChangePassword = vi.mocked(usersApi.useChangePassword);

const SENHA_ATUAL = 'senha-de-teste-123';
const SENHA_NOVA = 'jacarandá-roxo-42';

function signIn(role: UserRole = 'attendant') {
  useAuthStore.setState({
    user: { id: 'user-9', email: 'quem@lab.com.br', name: 'Quem Silva', role, discountLimit: 10 },
  });
}

function renderPage() {
  return render(
    <ToastProvider>
      <MemoryRouter>
        <Account />
      </MemoryRouter>
    </ToastProvider>,
  );
}

/** Preenche os três campos do formulário. */
async function preencher(
  user: ReturnType<typeof userEvent.setup>,
  valores: { atual?: string; nova?: string; confirmar?: string },
) {
  if (valores.atual !== undefined) {
    await user.type(screen.getByLabelText(/senha atual/i), valores.atual);
  }
  if (valores.nova !== undefined) {
    await user.type(screen.getByLabelText(/^nova senha$/i), valores.nova);
  }
  if (valores.confirmar !== undefined) {
    await user.type(screen.getByLabelText(/confirmar nova senha/i), valores.confirmar);
  }
}

describe('Account (/settings/account)', () => {
  const mockChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useChangePassword.mockReturnValue(mutationIdle(mockChange));
  });

  afterEach(() => {
    useAuthStore.setState({ user: null });
  });

  it('mostra nome e e-mail da sessao', () => {
    signIn();
    renderPage();

    expect(screen.getByText('Quem Silva')).toBeInTheDocument();
    expect(screen.getByText('quem@lab.com.br')).toBeInTheDocument();
  });

  it('atendente tambem acessa: trocar a propria senha nao e privilegio de admin', () => {
    signIn('attendant');
    renderPage();

    expect(screen.getByRole('button', { name: /alterar senha/i })).toBeInTheDocument();
  });

  it('envia currentPassword e newPassword — nunca a confirmacao', async () => {
    const user = userEvent.setup();
    signIn();
    renderPage();

    await preencher(user, { atual: SENHA_ATUAL, nova: SENHA_NOVA, confirmar: SENHA_NOVA });
    await user.click(screen.getByRole('button', { name: /alterar senha/i }));

    expect(mockChange).toHaveBeenCalledTimes(1);
    expect(mockChange.mock.calls[0]?.[0]).toEqual({
      currentPassword: SENHA_ATUAL,
      newPassword: SENHA_NOVA,
    });
  });

  it('confirmacao divergente nem chega no servidor', async () => {
    const user = userEvent.setup();
    signIn();
    renderPage();

    await preencher(user, { atual: SENHA_ATUAL, nova: SENHA_NOVA, confirmar: 'outra-coisa-999' });
    await user.click(screen.getByRole('button', { name: /alterar senha/i }));

    expect(mockChange).not.toHaveBeenCalled();
    expect(screen.getByText(/não conferem/i)).toBeInTheDocument();
  });

  it('senha curta nem chega no servidor (minimo 10, D-153)', async () => {
    const user = userEvent.setup();
    signIn();
    renderPage();

    await preencher(user, { atual: SENHA_ATUAL, nova: 'curta123', confirmar: 'curta123' });
    await user.click(screen.getByRole('button', { name: /alterar senha/i }));

    expect(mockChange).not.toHaveBeenCalled();
    expect(screen.getByText(/ao menos 10 caracteres/i)).toBeInTheDocument();
  });

  it('nova senha igual a atual e recusada na tela', async () => {
    const user = userEvent.setup();
    signIn();
    renderPage();

    await preencher(user, { atual: SENHA_ATUAL, nova: SENHA_ATUAL, confirmar: SENHA_ATUAL });
    await user.click(screen.getByRole('button', { name: /alterar senha/i }));

    expect(mockChange).not.toHaveBeenCalled();
    expect(screen.getByText(/diferente da atual/i)).toBeInTheDocument();
  });

  it('botao fica desabilitado enquanto faltar campo', async () => {
    const user = userEvent.setup();
    signIn();
    renderPage();

    const botao = screen.getByRole('button', { name: /alterar senha/i });
    expect(botao).toBeDisabled();

    await preencher(user, { atual: SENHA_ATUAL, nova: SENHA_NOVA });
    expect(botao).toBeDisabled();

    await preencher(user, { confirmar: SENHA_NOVA });
    expect(botao).toBeEnabled();
  });

  it('erro de campo do servidor aparece no campo certo', async () => {
    const user = userEvent.setup();
    signIn();
    mockChange.mockImplementation(
      (_data: unknown, opts: { onError?: (err: unknown) => void }) => {
        opts.onError?.({ details: { fields: { currentPassword: 'Senha atual incorreta' } } });
      },
    );
    renderPage();

    await preencher(user, { atual: 'errada-mesmo-1', nova: SENHA_NOVA, confirmar: SENHA_NOVA });
    await user.click(screen.getByRole('button', { name: /alterar senha/i }));

    expect(await screen.findByText('Senha atual incorreta')).toBeInTheDocument();
  });

  it('sucesso limpa o formulario e avisa que as outras sessoes cairam', async () => {
    const user = userEvent.setup();
    signIn();
    mockChange.mockImplementation(
      (_data: unknown, opts: { onSuccess?: () => void }) => {
        opts.onSuccess?.();
      },
    );
    renderPage();

    await preencher(user, { atual: SENHA_ATUAL, nova: SENHA_NOVA, confirmar: SENHA_NOVA });
    await user.click(screen.getByRole('button', { name: /alterar senha/i }));

    expect(screen.getByLabelText(/senha atual/i)).toHaveValue('');
    expect(screen.getByLabelText(/^nova senha$/i)).toHaveValue('');
    expect(await screen.findByText(/outras sessões foram encerradas/i)).toBeInTheDocument();
  });
});
