import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Insurance, ListInsurancesResponse, UserRole } from '@crm-lab/shared';
import { querySuccess, mutationIdle } from '@/test/query-mocks';
import { useAuthStore } from '@/stores/auth.store';
import Insurances from './Insurances';
import * as insurancesApi from '@/api/insurances';

/**
 * Mesmo padrão de `Catalog.spec.tsx`/`ExamModal.spec.tsx`: mocka os HOOKS, não
 * `insurancesApi` cru. `useInsuranceList`/`useCreateInsurance`/`useUpdateInsurance`
 * chamam `insurancesApi.list/create/update` de DENTRO do mesmo módulo — um
 * `vi.mock` que só troca `insurancesApi` (spread de `importActual`) não muda o
 * que os hooks reais enxergam, porque a referência interna do módulo não
 * mistura com o objeto substituído fora dele.
 */
vi.mock('@/api/insurances', async () => {
  const actual = await vi.importActual('@/api/insurances');
  return {
    ...actual,
    useInsuranceList: vi.fn(),
    useCreateInsurance: vi.fn(),
    useUpdateInsurance: vi.fn(),
  };
});

const useInsuranceList = vi.mocked(insurancesApi.useInsuranceList);
const useCreateInsurance = vi.mocked(insurancesApi.useCreateInsurance);
const useUpdateInsurance = vi.mocked(insurancesApi.useUpdateInsurance);

const unimed: Insurance = {
  id: '1',
  name: 'Unimed Tubarão',
  officialName: null,
  ansCode: '364860',
  type: 'cooperativa',
  isActive: true,
  createdAt: '',
  updatedAt: '',
};

function listResult(overrides: Partial<ListInsurancesResponse> = {}) {
  return querySuccess<ListInsurancesResponse>({
    insurances: [unimed],
    pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    ...overrides,
  });
}

function signIn(role: UserRole) {
  useAuthStore.setState({
    user: { id: 'user-9', email: 'quem@lab.com.br', name: 'Quem', role, discountLimit: 10 },
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Insurances />
    </MemoryRouter>,
  );
}

describe('Insurances', () => {
  const mockCreate = vi.fn();
  const mockUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useInsuranceList.mockReturnValue(listResult());
    useCreateInsurance.mockReturnValue(mutationIdle(mockCreate));
    useUpdateInsurance.mockReturnValue(mutationIdle(mockUpdate));
  });

  afterEach(() => {
    useAuthStore.setState({ user: null });
  });

  it('lista convênios e permite criar um novo', async () => {
    signIn('admin');
    renderPage();

    expect(await screen.findByText('Unimed Tubarão')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /novo convênio/i })).toBeInTheDocument();
  });

  it('atendente não vê botão de novo convênio', async () => {
    useInsuranceList.mockReturnValue(
      listResult({ insurances: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }),
    );
    signIn('attendant');
    renderPage();

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /novo convênio/i })).not.toBeInTheDocument(),
    );
  });

  it('atendente também não vê a coluna de ações', async () => {
    signIn('attendant');
    renderPage();

    await screen.findByText('Unimed Tubarão');
    expect(screen.queryByRole('button', { name: /editar/i })).not.toBeInTheDocument();
  });

  it('gestor vê o botão e a ação de editar', async () => {
    signIn('manager');
    renderPage();

    expect(await screen.findByRole('button', { name: /novo convênio/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /editar/i })).toBeInTheDocument();
  });

  it('cria um convênio novo com os dados do formulário', async () => {
    const user = userEvent.setup();
    signIn('manager');
    renderPage();

    await user.click(await screen.findByRole('button', { name: /novo convênio/i }));
    await user.type(screen.getByLabelText('Nome'), 'Bradesco Saúde');
    await user.selectOptions(screen.getByLabelText('Tipo'), 'seguradora');
    await user.click(screen.getByRole('button', { name: /^criar$/i }));

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      name: 'Bradesco Saúde',
      type: 'seguradora',
    });
  });

  it('edita um convênio existente e permite desativar', async () => {
    const user = userEvent.setup();
    signIn('admin');
    renderPage();

    await user.click(await screen.findByRole('button', { name: /editar/i }));
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Editar Convênio');
    expect(screen.getByLabelText('Nome')).toHaveValue('Unimed Tubarão');

    await user.click(screen.getByRole('switch', { name: /ativo/i }));
    await user.click(screen.getByRole('button', { name: /atualizar/i }));

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0]?.[0]).toMatchObject({ id: '1', dto: { isActive: false } });
  });
});
