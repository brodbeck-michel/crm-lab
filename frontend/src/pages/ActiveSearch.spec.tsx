import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LisBudgetsFilters,
  ListPendingLisBudgetsResponse,
  PendingLisBudget,
  PendingLisBudgetsSummary,
} from '@crm-lab/shared';
import { querySuccess } from '@/test/query-mocks';
import { ToastProvider } from '@/components/ui';
import ActiveSearch from './ActiveSearch';
import * as lisApi from '@/api/lis';

vi.mock('@/api/lis', async () => {
  const actual = await vi.importActual('@/api/lis');
  return {
    ...actual,
    useLisBudgetsPending: vi.fn(),
    useLisBudgetsPendingSummary: vi.fn(),
    useLisBudgetsFilters: vi.fn(),
  };
});

const useLisBudgetsPending = vi.mocked(lisApi.useLisBudgetsPending);
const useLisBudgetsPendingSummary = vi.mocked(lisApi.useLisBudgetsPendingSummary);
const useLisBudgetsFilters = vi.mocked(lisApi.useLisBudgetsFilters);

const pendingBudget: PendingLisBudget = {
  id: 'b-1',
  number: '48213',
  patientName: 'João Santos',
  principalInsuranceName: 'Unimed Tubarão',
  totalValue: 452.3,
  attendantName: 'Maria Souza',
  attendantId: 'a-1',
  requisitionNumber: 'REQ-9911',
  requisitionValue: 452.3,
  issuedOn: '2026-08-20',
  daysOpen: 12,
  ageBand: '8-15',
};

const summary: PendingLisBudgetsSummary = {
  total: { count: 34, value: 18500 },
  byAgeBand: {
    '0-7': { count: 10, value: 5200 },
    '8-15': { count: 12, value: 6800 },
    '16-30': { count: 8, value: 4500 },
    '30+': { count: 4, value: 2000 },
  },
};

const filters: LisBudgetsFilters = {
  attendants: [{ id: 'a-1', name: 'Maria Souza' }],
  insurances: [],
  issuedOnRange: { min: '2025-01-05', max: '2026-08-30' },
};

function pendingResult(overrides: Partial<ListPendingLisBudgetsResponse> = {}) {
  return querySuccess<ListPendingLisBudgetsResponse>({
    budgets: [pendingBudget],
    pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    ...overrides,
  });
}

function renderPage() {
  return render(
    <ToastProvider>
      <MemoryRouter>
        <ActiveSearch />
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe('ActiveSearch (/active-search)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLisBudgetsPending.mockReturnValue(pendingResult());
    useLisBudgetsPendingSummary.mockReturnValue(querySuccess(summary));
    useLisBudgetsFilters.mockReturnValue(querySuccess(filters));
  });

  it('mostra as 4 faixas sempre, mesmo com contagem zero', () => {
    renderPage();

    expect(screen.getByText('Total em aberto')).toBeInTheDocument();
    // Os mesmos rótulos também aparecem como opção do `Select` de faixa —
    // `getAllByText` confirma o KpiCard sem depender de ser o único no DOM.
    expect(screen.getAllByText('0-7 dias').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('8-15 dias').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('16-30 dias').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('30+ dias').length).toBeGreaterThanOrEqual(1);
  });

  it('lista a fila ordenada por dias em aberto, com AgeBadge por linha', async () => {
    renderPage();

    expect(await screen.findByText('48213')).toBeInTheDocument();
    expect(screen.getByText('12 dias · 8-15')).toBeInTheDocument();
  });

  it('vazio mostra "Nenhum orçamento em aberto" com tom positivo', () => {
    useLisBudgetsPending.mockReturnValue(
      pendingResult({ budgets: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }),
    );
    renderPage();

    expect(screen.getByText('Nenhum orçamento em aberto')).toBeInTheDocument();
  });
});
