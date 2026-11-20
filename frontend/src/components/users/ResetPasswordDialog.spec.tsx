import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { ManagedUser } from '@crm-lab/shared';
import * as usersApi from '@/api/users';
import ResetPasswordDialog from './ResetPasswordDialog';
import UserTable from './UserTable';

const DIANA: ManagedUser = {
  id: 'u-diana',
  email: 'diana@lab.com',
  name: 'Diana',
  role: 'attendant',
  discountLimit: 15,
  isActive: true,
  lastLoginAt: null,
  createdAt: '2026-11-01T12:00:00Z',
};

function renderDialog(onClose = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ResetPasswordDialog user={DIANA} onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

describe('ResetPasswordDialog (CRMLAB-186)', () => {
  let resetSpy: MockInstance<typeof usersApi.usersApi.resetPassword>;

  beforeEach(() => {
    resetSpy = vi.spyOn(usersApi.usersApi, 'resetPassword').mockResolvedValue({
      userId: DIANA.id,
      email: DIANA.email,
      temporaryPassword: 'kQ7f2m9Xp1zR-a3B',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('confirma, reseta e mostra a senha provisória uma vez', async () => {
    const user = userEvent.setup();
    const onClose = renderDialog();

    expect(screen.getByText(/diana@lab.com/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resetar senha' }));

    expect(resetSpy).toHaveBeenCalledWith(DIANA.id);
    expect(await screen.findByText('kQ7f2m9Xp1zR-a3B')).toBeInTheDocument();

    // O último "Fechar" é o do rodapé (o primeiro é o × do cabeçalho do Modal).
    const fechar = screen.getAllByRole('button', { name: 'Fechar' });
    await user.click(fechar[fechar.length - 1]!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cancelar não chama a API', async () => {
    const user = userEvent.setup();
    const onClose = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Cancelar' }));

    expect(resetSpy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('erro da API aparece no diálogo e a senha não é mostrada', async () => {
    resetSpy.mockRejectedValueOnce(new Error('falhou'));
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Resetar senha' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível resetar a senha'),
    );
    expect(screen.queryByText('Senha provisória gerada')).not.toBeInTheDocument();
  });
});

describe('UserTable — Resetar senha (CRMLAB-186)', () => {
  const ADMIN: ManagedUser = { ...DIANA, id: 'u-admin', name: 'Admin', role: 'admin' };
  const pagination = { page: 1, limit: 20, total: 2, totalPages: 1 };

  it('aparece para os outros usuários, nunca para quem está logado', async () => {
    const onResetPassword = vi.fn();
    const user = userEvent.setup();
    render(
      <UserTable
        users={[ADMIN, DIANA]}
        pagination={pagination}
        onEdit={vi.fn()}
        onPageChange={vi.fn()}
        onResetPassword={onResetPassword}
        currentUserId={ADMIN.id}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Resetar senha de Admin' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resetar senha de Diana' }));
    expect(onResetPassword).toHaveBeenCalledWith(DIANA);
  });
});
