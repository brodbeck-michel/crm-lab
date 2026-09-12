import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LisBudget, LisBudgetsFilters, ListLisBudgetsResponse } from '@crm-lab/shared';
import { querySuccess } from '@/test/query-mocks';
import { useUIStore, defaultLisFilters } from '@/stores/ui.store';
import Reconciliation from './Reconciliation';
import * as lisApi from '@/api/lis';

vi.mock('@/api/lis', async () => {
  const actual = await vi.importActual('@/api/lis');
  return {
    ...actual,
    useLisBudgetList: vi.fn(),
    useLisBudgetsFilters: vi.fn(),
    useImportLisSpreadsheet: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  };
});

const useLisBudgetList = vi.mocked(lisApi.useLisBudgetList);
const useLisBudgetsFilters = vi.mocked(lisApi.useLisBudgetsFilters);

const budget: LisBudget = {
  id: 'b-1',
  number: '48213',
  issuedOn: '2026-08-20',
  patientName: 'João Santos',
  principalInsuranceName: 'Unimed Tubarão',
  totalValue: 452.3,
  insuranceId: 'i-1',
  attendantName: 'Maria Souza',
  attendantId: 'a-1',
  requisitionNumber: 'REQ-9911',
  requisitionValue: 452.3,
  paidValue: null,
  paidOn: null,
  proposalId: null,
  createdAt: '2026-08-21T09:00:00.000Z',
};

const filters: LisBudgetsFilters = {
  attendants: [{ id: 'a-1', name: 'Maria Souza' }],
  insurances: [{ id: 'i-1', name: 'Unimed Tubarão' }],
  issuedOnRange: { min: '2025-01-05', max: '2026-08-30' },
};

function listResult(overrides: Partial<ListLisBudgetsResponse> = {}) {
  return querySuccess<ListLisBudgetsResponse>({
    budgets: [budget],
    pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    ...overrides,
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Reconciliation />
    </MemoryRouter>,
  );
}

describe('Reconciliation (/reconciliation)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ lisFilters: defaultLisFilters() });
    useLisBudgetList.mockReturnValue(listResult());
    useLisBudgetsFilters.mockReturnValue(querySuccess(filters));
  });

  afterEach(() => {
    useUIStore.setState({ lisFilters: defaultLisFilters() });
  });

  it('lista os orçamentos importados, com "—" para pagamento ausente', async () => {
    renderPage();

    expect(await screen.findByText('48213')).toBeInTheDocument();
    expect(screen.getByText('João Santos')).toBeInTheDocument();
    // paidValue e paidOn são null nesta linha
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it('vazio mostra "Nenhum orçamento neste filtro"', () => {
    useLisBudgetList.mockReturnValue(
      listResult({ budgets: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }),
    );
    renderPage();

    expect(screen.getByText('Nenhum orçamento neste filtro')).toBeInTheDocument();
  });
});
