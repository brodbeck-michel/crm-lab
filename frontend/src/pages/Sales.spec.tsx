import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attendant, ListAttendantsResponse, ListSalesResponse, Sale, SalesSummary, UserRole } from '@crm-lab/shared';
import { querySuccess, mutationIdle } from '@/test/query-mocks';
import { ToastProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth.store';
import Sales from './Sales';
import * as attendantsApi from '@/api/attendants';
import * as salesApi from '@/api/sales';

vi.mock('@/api/attendants', async () => {
  const actual = await vi.importActual('@/api/attendants');
  return { ...actual, useAttendantList: vi.fn() };
});

vi.mock('@/api/sales', async () => {
  const actual = await vi.importActual('@/api/sales');
  return {
    ...actual,
    useSaleList: vi.fn(),
    useSalesSummary: vi.fn(),
    useCreateSale: vi.fn(),
    useDeleteSale: vi.fn(),
  };
});

const useAttendantList = vi.mocked(attendantsApi.useAttendantList);
const useSaleList = vi.mocked(salesApi.useSaleList);
const useSalesSummary = vi.mocked(salesApi.useSalesSummary);
const useCreateSale = vi.mocked(salesApi.useCreateSale);
const useDeleteSale = vi.mocked(salesApi.useDeleteSale);

const maria: Attendant = {
  id: 'a-1',
  name: 'Maria Souza',
  isActive: true,
  userId: 'u-1',
  userName: 'Maria Souza',
  createdAt: '',
  updatedAt: '',
};

const sale: Sale = {
  id: 's-1',
  attendantId: 'a-1',
  attendantName: 'Maria Souza',
  soldOn: '2026-08-20',
  code: 'V-1029',
  value: 340,
  exams: 'Hemograma',
  kind: 'exams',
  createdBy: 'u-1',
  createdAt: '2026-08-20T11:00:00.000Z',
};

const summary: SalesSummary = {
  period: { startDate: '2026-08-01', endDate: '2026-08-31' },
  byKind: {
    exams: { count: 1, value: 340, commissionValue: 5.1 },
    checkup: { count: 0, value: 0, commissionValue: 0 },
  },
  totalValue: 340,
  commissionTotal: 5.1,
};

function attendantsResult(): ReturnType<typeof querySuccess<ListAttendantsResponse>> {
  return querySuccess<ListAttendantsResponse>({
    attendants: [maria],
    pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
  });
}

function salesResult(overrides: Partial<ListSalesResponse> = {}) {
  return querySuccess<ListSalesResponse>({
    sales: [sale],
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
    <ToastProvider>
      <MemoryRouter>
        <Sales />
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe('Sales (/sales)', () => {
  const mockCreate = vi.fn();
  const mockDelete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useAttendantList.mockReturnValue(attendantsResult());
    useSaleList.mockReturnValue(salesResult());
    useSalesSummary.mockReturnValue(querySuccess(summary));
    useCreateSale.mockReturnValue(mutationIdle(mockCreate));
    useDeleteSale.mockReturnValue(mutationIdle(mockDelete));
  });

  afterEach(() => {
    useAuthStore.setState({ user: null });
  });

  it('lista vendas e o resumo de comissão', async () => {
    signIn('attendant');
    renderPage();

    expect(await screen.findByText('V-1029')).toBeInTheDocument();
    expect(screen.getByText('Comissão total')).toBeInTheDocument();
  });

  it('atendente NÃO vê o seletor de atendente (recorte é do servidor)', async () => {
    signIn('attendant');
    renderPage();

    await screen.findByText('V-1029');
    expect(screen.queryByLabelText('Atendente')).not.toBeInTheDocument();
  });

  it('gestor vê o seletor de atendente e a coluna correspondente', async () => {
    signIn('manager');
    renderPage();

    await screen.findByText('V-1029');
    expect(screen.getByLabelText('Atendente')).toBeInTheDocument();
  });

  it('lança uma venda nova', async () => {
    const user = userEvent.setup();
    signIn('attendant');
    renderPage();

    await user.click(await screen.findByRole('button', { name: /lançar venda/i }));
    await user.type(screen.getByLabelText('Valor'), '150');
    await user.click(screen.getByRole('button', { name: /^lançar$/i }));

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({ value: 150, kind: 'exams' });
  });

  it('apaga uma venda após confirmação', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    signIn('attendant');
    renderPage();

    await user.click(await screen.findByRole('button', { name: /apagar/i }));
    expect(mockDelete).toHaveBeenCalledWith('s-1', expect.anything());
  });
});
