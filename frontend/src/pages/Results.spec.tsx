import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutiveReport, LisImport, UserRole } from '@crm-lab/shared';
import { querySuccess } from '@/test/query-mocks';
import { ToastProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth.store';
import { useUIStore, defaultLisFilters } from '@/stores/ui.store';
import Results from './Results';
import * as lisApi from '@/api/lis';
import * as reportsApi from '@/api/reports';

vi.mock('@/api/lis', async () => {
  const actual = await vi.importActual('@/api/lis');
  return {
    ...actual,
    useLisImportsLatest: vi.fn(),
    useImportLisSpreadsheet: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
    usePurgeLisBudgets: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  };
});

vi.mock('@/api/reports', async () => {
  const actual = await vi.importActual('@/api/reports');
  return { ...actual, useExecutiveReport: vi.fn() };
});

const useLisImportsLatest = vi.mocked(lisApi.useLisImportsLatest);
const useExecutiveReport = vi.mocked(reportsApi.useExecutiveReport);

const report: ExecutiveReport = {
  period: { startDate: '2026-08-01', endDate: '2026-08-31' },
  issued: { count: 210, totalValue: 158000, averageTicket: 752.38 },
  paid: { count: 165, totalValue: 121000, averageTicket: 733.33, conversionQty: 78.57 },
  monthlySeries: [{ month: '2026-08', issuedValue: 158000, paidValue: 121000 }],
  byAttendant: [{ attendantId: 'a-1', attendantName: 'Maria Souza', issuedCount: 40, paidValue: 30000 }],
  byInsurance: [{ insuranceName: 'Unimed Tubarão', count: 60, totalValue: 45000 }],
  brandName: 'Laboratório Vida',
  logoUrl: null,
};

const latestImport: LisImport = {
  id: 'i-1',
  kind: 'import',
  fileName: 'orcamentos-agosto.xlsx',
  rowsInFile: 512,
  rowsAccepted: 505,
  rowsRejected: 7,
  proposalsWon: 0,
  status: 'completed',
  errorMessage: null,
  createdBy: 'u-1',
  createdAt: '2026-09-12T14:00:00.000Z',
  finishedAt: '2026-09-12T14:00:03.000Z',
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
        <Results />
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe('Results (/results)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ lisFilters: defaultLisFilters() });
    useLisImportsLatest.mockReturnValue(querySuccess<LisImport | null>(latestImport));
    useExecutiveReport.mockReturnValue(querySuccess(report));
  });

  afterEach(() => {
    useAuthStore.setState({ user: null });
    useUIStore.setState({ lisFilters: defaultLisFilters() });
  });

  it('mostra os KPIs de emitido/pago e a conversão já capada do servidor', async () => {
    signIn('manager');
    renderPage();

    expect(await screen.findByText('Valor emitido')).toBeInTheDocument();
    expect(screen.getByText('Pagos')).toBeInTheDocument();
    expect(screen.getByText('Conversão')).toBeInTheDocument();
  });

  it('sem importação ainda mostra "Nenhuma importação ainda"', () => {
    useLisImportsLatest.mockReturnValue(querySuccess<LisImport | null>(null));
    signIn('manager');
    renderPage();

    expect(screen.getByText('Nenhuma importação ainda')).toBeInTheDocument();
  });

  it('só admin vê "Limpar base"', async () => {
    signIn('manager');
    const { unmount } = renderPage();
    await screen.findByText('Valor emitido');
    expect(screen.queryByRole('button', { name: /limpar base/i })).not.toBeInTheDocument();
    unmount();

    signIn('admin');
    renderPage();
    expect(await screen.findByRole('button', { name: /limpar base/i })).toBeInTheDocument();
  });
});
