import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CommissionSettings,
  ExecutiveReport,
  LisBudgetsFilters,
  LisBudgetsSummary,
  LisImport,
  SalesSummary,
  UserRole,
} from '@crm-lab/shared';
import { querySuccess } from '@/test/query-mocks';
import { ToastProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth.store';
import { useUIStore, defaultLisFilters } from '@/stores/ui.store';
import Results from './Results';
import * as lisApi from '@/api/lis';
import * as reportsApi from '@/api/reports';
import * as salesApi from '@/api/sales';
import * as commissionApi from '@/api/commission-settings';

vi.mock('@/api/lis', async () => {
  const actual = await vi.importActual('@/api/lis');
  return {
    ...actual,
    useLisBudgetsFilters: vi.fn(),
    useLisBudgetsSummary: vi.fn(),
    useLisImportsLatest: vi.fn(),
    useImportLisSpreadsheet: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
    usePurgeLisBudgets: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  };
});

vi.mock('@/api/reports', async () => {
  const actual = await vi.importActual('@/api/reports');
  return { ...actual, useExecutiveReport: vi.fn() };
});

vi.mock('@/api/sales', async () => {
  const actual = await vi.importActual('@/api/sales');
  return { ...actual, useSalesSummary: vi.fn() };
});

vi.mock('@/api/commission-settings', async () => {
  const actual = await vi.importActual('@/api/commission-settings');
  return { ...actual, useCommissionSettings: vi.fn() };
});

const useLisBudgetsFilters = vi.mocked(lisApi.useLisBudgetsFilters);
const useLisBudgetsSummary = vi.mocked(lisApi.useLisBudgetsSummary);
const useLisImportsLatest = vi.mocked(lisApi.useLisImportsLatest);
const useExecutiveReport = vi.mocked(reportsApi.useExecutiveReport);
const useSalesSummary = vi.mocked(salesApi.useSalesSummary);
const useCommissionSettings = vi.mocked(commissionApi.useCommissionSettings);

const summary: LisBudgetsSummary = {
  period: { startDate: '2026-08-01', endDate: '2026-08-31' },
  issued: { count: 225, totalValue: 90996, averageTicket: 404.4 },
  requisition: { count: 75, totalValue: 20117 },
  paid: { count: 92, totalValue: 26163.45, averageTicket: 284.4, conversionQty: 40.9 },
  byAttendant: [
    { attendantId: 'a-1', attendantName: 'Tainá', issuedCount: 54, paidCount: 28, paidValue: 8296 },
  ],
  byAttendantDetail: [
    { attendantId: 'a-1', attendantName: 'Tainá', issuedCount: 54, paidCount: 28, paidValue: 8296 },
    { attendantId: 'a-2', attendantName: 'Carol', issuedCount: 62, paidCount: 25, paidValue: 5510 },
  ],
  byInsurance: [{ insuranceName: 'Particular', count: 90, totalValue: 6805 }],
};

const previousSummary: LisBudgetsSummary = {
  ...summary,
  issued: { count: 200, totalValue: 80000, averageTicket: 400 },
};

const filters: LisBudgetsFilters = {
  attendants: [{ id: 'a-1', name: 'Tainá' }],
  insurances: [{ id: 'i-1', name: 'Particular' }],
  issuedOnRange: { min: '2025-01-05', max: '2026-08-30' },
};

const executiveReport: ExecutiveReport = {
  period: { startDate: '2026-08-01', endDate: '2026-08-31' },
  issued: summary.issued,
  requisition: summary.requisition,
  paid: summary.paid,
  monthlySeries: [{ month: '2026-08', issuedValue: 90996, paidValue: 26163 }],
  byAttendant: summary.byAttendant,
  byInsurance: summary.byInsurance,
  brandName: 'Laboratório Vida',
  logoUrl: null,
};

const latestImport: LisImport = {
  id: 'i-1',
  kind: 'import',
  fileName: 'Sante - Relatorio_20260911.xlsx',
  rowsInFile: 225,
  rowsAccepted: 225,
  rowsRejected: 0,
  proposalsWon: 0,
  status: 'completed',
  errorMessage: null,
  createdBy: 'u-1',
  createdAt: '2026-09-12T16:17:16.000Z',
  finishedAt: '2026-09-12T16:17:20.000Z',
};

const salesSummary: SalesSummary = {
  period: { startDate: '2026-08-01', endDate: '2026-08-31' },
  byKind: {
    exams: { count: 10, value: 3000, commissionValue: 45 },
    checkup: { count: 0, value: 0, commissionValue: 0 },
  },
  totalValue: 3000,
  commissionTotal: 45,
  byAttendant: [
    {
      attendantId: 'a-1',
      attendantName: 'Tainá',
      byKind: {
        exams: { count: 10, value: 3000, commissionValue: 45 },
        checkup: { count: 0, value: 0, commissionValue: 0 },
      },
      totalValue: 3000,
      commissionTotal: 45,
    },
  ],
};

const commissionSettings: CommissionSettings = {
  commissionBudgetPct: 2,
  commissionExamsPct: 1.5,
  commissionCheckupPct: 3.5,
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
    useLisBudgetsFilters.mockReturnValue(querySuccess(filters));
    useLisImportsLatest.mockReturnValue(querySuccess<LisImport | null>(latestImport));
    useExecutiveReport.mockReturnValue(querySuccess(executiveReport));
    useSalesSummary.mockReturnValue(querySuccess(salesSummary));
    useCommissionSettings.mockReturnValue(querySuccess(commissionSettings));
    // A tela chama o hook duas vezes: período atual e período anterior
    // (deltaPct). Distingue pelo `startDate` da query, não pela ordem da
    // chamada — `mockReturnValueOnce` esgotaria após a 1ª renderização e
    // quebraria os testes seguintes.
    const currentStart = defaultLisFilters().startDate;
    useLisBudgetsSummary.mockImplementation((query) =>
      query?.startDate === currentStart ? querySuccess(summary) : querySuccess(previousSummary),
    );
  });

  afterEach(() => {
    useAuthStore.setState({ user: null });
    useUIStore.setState({ lisFilters: defaultLisFilters() });
  });

  it('mostra os 4 KPIs com os números do período', async () => {
    signIn('manager');
    renderPage();

    expect(await screen.findByText('Total Orçado')).toBeInTheDocument();
    expect(screen.getByText('225 orçamentos')).toBeInTheDocument();
    expect(screen.getByText('Em Requisição')).toBeInTheDocument();
    expect(screen.getAllByText('Recebido').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Atendentes')).toBeInTheDocument();
  });

  it('a variação (delta) do Total Orçado compara com o período anterior', async () => {
    signIn('manager');
    renderPage();
    // (90996 - 80000) / 80000 = 13.7%
    expect(await screen.findByText(/13\.7%/)).toBeInTheDocument();
  });

  it('mostra a tabela "Detalhe por atendente" combinando orçamento e vendas', async () => {
    signIn('manager');
    renderPage();

    expect(await screen.findByText('Detalhe por atendente')).toBeInTheDocument();
    expect(screen.getByText('Tainá')).toBeInTheDocument();
    expect(screen.getByText('Carol')).toBeInTheDocument();
    // % Comissão do badge vem de commissionBudgetPct
    expect(screen.getByText('% Comissão: 2%')).toBeInTheDocument();
  });

  it('exportar comissão em PDF/Excel está disponível quando há dado', async () => {
    signIn('manager');
    renderPage();

    expect(await screen.findByRole('button', { name: /comissão em pdf/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /comissão em excel/i })).toBeInTheDocument();
  });

  it('só admin vê "Limpar base"', async () => {
    signIn('manager');
    renderPage();
    await screen.findByText('Total Orçado');
    expect(screen.queryByRole('button', { name: /limpar base/i })).not.toBeInTheDocument();
  });

  it('admin vê "Limpar base"', async () => {
    signIn('admin');
    renderPage();
    expect(await screen.findByRole('button', { name: /limpar base/i })).toBeInTheDocument();
  });

  it('sem importação ainda mostra "Nenhuma importação ainda"', async () => {
    useLisImportsLatest.mockReturnValue(querySuccess<LisImport | null>(null));
    signIn('manager');
    renderPage();

    expect(await screen.findByText('Nenhuma importação ainda')).toBeInTheDocument();
  });
});
