import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommissionSettings, UserRole } from '@crm-lab/shared';
import { querySuccess, mutationIdle } from '@/test/query-mocks';
import { ToastProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth.store';
import Commissions from './Commissions';
import * as commissionApi from '@/api/commission-settings';

vi.mock('@/api/commission-settings', async () => {
  const actual = await vi.importActual('@/api/commission-settings');
  return {
    ...actual,
    useCommissionSettings: vi.fn(),
    useUpdateCommissionSettings: vi.fn(),
  };
});

const useCommissionSettings = vi.mocked(commissionApi.useCommissionSettings);
const useUpdateCommissionSettings = vi.mocked(commissionApi.useUpdateCommissionSettings);

const DEFAULTS: CommissionSettings = {
  commissionBudgetPct: 2,
  commissionExamsPct: 1.5,
  commissionCheckupPct: 1.5,
};

function signIn(role: UserRole) {
  useAuthStore.setState({
    user: { id: 'user-9', email: 'quem@lab.com.br', name: 'Quem', role, discountLimit: 10 },
  });
}

function renderPage() {
  return render(
    <ToastProvider>
      <MemoryRouter>
        <Commissions />
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe('Commissions (/settings/commissions)', () => {
  const mockUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useCommissionSettings.mockReturnValue(querySuccess(DEFAULTS));
    useUpdateCommissionSettings.mockReturnValue(mutationIdle(mockUpdate));
  });

  afterEach(() => {
    useAuthStore.setState({ user: null });
  });

  it('mostra os defaults do servidor (2,00 / 1,50 / 1,50)', () => {
    signIn('manager');
    renderPage();

    expect(screen.getByLabelText(/orçamento/i)).toHaveValue(2);
    expect(screen.getByLabelText(/exames/i)).toHaveValue(1.5);
    expect(screen.getByLabelText(/check-up/i)).toHaveValue(1.5);
  });

  it('gestor vê os campos desabilitados, sem botão salvar', () => {
    signIn('manager');
    renderPage();

    expect(screen.getByLabelText(/exames/i)).toBeDisabled();
    expect(screen.queryByRole('button', { name: /salvar/i })).not.toBeInTheDocument();
  });

  it('admin edita e o PATCH envia só o campo alterado (dirty fields)', async () => {
    const user = userEvent.setup();
    signIn('admin');
    renderPage();

    const examsInput = screen.getByLabelText(/exames/i);
    await user.clear(examsInput);
    await user.type(examsInput, '1.75');
    await user.click(screen.getByRole('button', { name: /salvar/i }));

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0]?.[0]).toEqual({ commissionExamsPct: 1.75 });
  });
});
