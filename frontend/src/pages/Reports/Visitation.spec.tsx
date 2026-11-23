import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AuthUser,
  VisitationReport,
  VisitationReportQuery,
  VisitationReportStaleQuery,
  VisitationReportStaleResponse,
} from '@crm-lab/shared';
import { conversationsApi } from '@/api/conversations';
import { visitationReportsApi } from '@/api/visitation-reports';
import { downloadCsv } from '@/lib/csv';
import { ToastProvider } from '@/components/ui';
import { useAuthStore } from '@/stores';
import VisitationReportPage, { currentMonthPeriod } from './Visitation';

/**
 * Relatório de Visitação — `/reports/visitation` (CRMLAB-193, D-333). A API é
 * mockada em `visitationReportsApi`: o que a tela manda é o que chegaria ao servidor.
 */
// Os hooks chamam o objeto do PRÓPRIO módulo; recriá-los aqui faz o mock valer.
vi.mock('@/api/visitation-reports', async () => {
  const { useQuery } = await import('@tanstack/react-query');
  const api = { summary: vi.fn(), staleDoctors: vi.fn() };
  return {
    visitationReportsApi: api,
    useVisitationReport: (query: VisitationReportQuery, options: { enabled?: boolean } = {}) =>
      useQuery({ queryKey: ['vr', 'summary', query], queryFn: () => api.summary(query), enabled: options.enabled ?? true }),
    useVisitationStaleDoctors: (query: VisitationReportStaleQuery, options: { enabled?: boolean } = {}) =>
      useQuery({ queryKey: ['vr', 'stale', query], queryFn: () => api.staleDoctors(query), enabled: options.enabled ?? true }),
  };
});

vi.mock('@/api/conversations', () => ({
  conversationsApi: { assignees: vi.fn() },
}));

vi.mock('@/api/visit-purposes', () => ({
  useVisitPurposes: () => ({
    data: { purposes: [{ id: 'p-visita', name: 'Visita', color: 'azul', isActive: true, sortOrder: 0 }] },
  }),
}));

vi.mock('@/lib/csv', () => ({ downloadCsv: vi.fn() }));

// O Recharts mede o contêiner; no jsdom ele é zero e nada desenha — o gráfico não é o alvo.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => <div data-testid="chart">{children}</div>,
  };
});

const summaryMock = vi.mocked(visitationReportsApi.summary);
const staleMock = vi.mocked(visitationReportsApi.staleDoctors);
const assigneesMock = vi.mocked(conversationsApi.assignees);
const downloadMock = vi.mocked(downloadCsv);

const coverage = (visited: number, portfolio: number, rate: number | null) => ({
  portfolioDoctors: portfolio,
  visitedDoctors: visited,
  rate,
});

const report: VisitationReport = {
  period: { from: '2026-11-01', to: '2026-11-30' },
  granularity: 'week',
  scope: 'all',
  summary: {
    scheduled: 3,
    completed: 4,
    cancelled: 1,
    notReceived: 1,
    total: 9,
    reschedules: 2,
    completionRate: 66.7,
    averageDurationMinutes: 27.5,
    durationSampleSize: 4,
    coverage: coverage(3, 7, 42.9),
  },
  byRepresentative: [
    {
      responsible: { id: 'u-carla', name: 'Carla Rep' },
      portfolioDoctors: 4,
      visitedDoctors: 2,
      coverage: coverage(2, 4, 50),
      coverageByClass: { A: coverage(1, 1, 100), B: coverage(1, 1, 100), C: coverage(0, 1, 0), unclassified: coverage(0, 1, 0) },
      completed: 3,
      cancelled: 1,
      notReceived: 1,
      reschedules: 2,
    },
  ],
  byPurpose: [{ purpose: { id: 'p-visita', name: 'Visita', color: 'azul' }, total: 9, completed: 4 }],
  evolution: [{ bucket: '2026-10-26', total: 9, completed: 4, cancelled: 1, notReceived: 1 }],
};

const stale: VisitationReportStaleResponse = {
  days: 60,
  referenceDate: '2026-11-22',
  doctors: [
    {
      id: 'd-nunca',
      name: 'Dra. Nunca Visitada',
      crm: '123',
      crmUf: 'SC',
      specialty: null,
      abcClass: 'A',
      responsible: { id: 'u-carla', name: 'Carla Rep' },
      lastVisitAt: null,
      daysSinceLastVisit: null,
    },
    {
      id: 'd-velho',
      name: 'Dr. Visita Antiga',
      crm: null,
      crmUf: null,
      specialty: null,
      abcClass: 'B',
      responsible: null,
      lastVisitAt: '2026-08-01T15:00:00.000Z',
      daysSinceLastVisit: 113,
    },
  ],
  total: 2,
  truncated: false,
};

function login(role: AuthUser['role'], id = 'u-ana', name = 'Ana Gestora'): void {
  useAuthStore.setState({ user: { id, email: `${id}@lab.com`, name, role, discountLimit: 30 } });
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <VisitationReportPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Relatório de Visitação (/reports/visitation)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    summaryMock.mockResolvedValue(report);
    staleMock.mockResolvedValue(stale);
    assigneesMock.mockResolvedValue({
      assignees: [
        { id: 'u-ana', name: 'Ana Gestora', role: 'manager' },
        { id: 'u-carla', name: 'Carla Rep', role: 'representative' },
        { id: 'u-bia', name: 'Bia Atendente', role: 'attendant' },
      ],
    });
  });

  it('período padrão = mês corrente inteiro', () => {
    expect(currentMonthPeriod(new Date(2026, 1, 10))).toEqual({ startDate: '2026-02-01', endDate: '2026-02-28' });
    expect(currentMonthPeriod(new Date(2026, 10, 22))).toEqual({ startDate: '2026-11-01', endDate: '2026-11-30' });
  });

  it('gestor: cards, tabela por representante e esquecidos', async () => {
    login('manager');
    renderPage();
    const period = currentMonthPeriod();
    await waitFor(() => expect(summaryMock).toHaveBeenCalledWith({ from: period.startDate, to: period.endDate }));

    expect(await screen.findByText('66,7%')).toBeInTheDocument(); // taxa de realização
    expect(screen.getByText('27,5 min')).toBeInTheDocument();
    expect(screen.getByText('42,9%')).toBeInTheDocument();
    expect(screen.getByText('3 de 7 médicos ativos visitados')).toBeInTheDocument();
    expect(screen.getByText('4 visitas com check-in e check-out')).toBeInTheDocument();

    const kpi = (label: string) => document.querySelector(`[data-kpi="${label}"]`) as HTMLElement;
    expect(within(kpi('Agendadas')).getByText('3')).toBeInTheDocument();
    expect(within(kpi('Realizadas')).getByText('4')).toBeInTheDocument();
    expect(within(kpi('Canceladas')).getByText('1')).toBeInTheDocument();
    expect(within(kpi('Não recebidas')).getByText('1')).toBeInTheDocument();

    const table = screen.getAllByRole('table')[0] as HTMLElement;
    expect(within(table).getByText('Carla Rep')).toBeInTheDocument();
    expect(within(table).getByText('50%')).toBeInTheDocument();
    expect(within(table).getAllByText('1/1')).toHaveLength(2); // A e B

    expect(await screen.findByText('Dra. Nunca Visitada')).toBeInTheDocument();
    expect(screen.getByText('Nunca visitado')).toBeInTheDocument();
    expect(screen.getByText('113')).toBeInTheDocument();
    expect(staleMock).toHaveBeenCalledWith({ days: 60 });
  });

  it('filtros do gestor vão para as duas consultas', async () => {
    const user = userEvent.setup({ delay: null });
    login('manager');
    renderPage();
    await screen.findByText('66,7%');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Carla Rep' })).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Representante'), 'u-carla');
    await user.selectOptions(screen.getByLabelText('Finalidade'), 'p-visita');
    await user.selectOptions(screen.getByLabelText('Curva ABC'), 'A');

    await waitFor(() =>
      expect(summaryMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ responsibleId: 'u-carla', purposeId: 'p-visita', abcClass: 'A' }),
      ),
    );
    // Esquecidos: representante e classe, nunca finalidade.
    expect(staleMock).toHaveBeenLastCalledWith({ days: 60, responsibleId: 'u-carla', abcClass: 'A' });

    const days = screen.getByLabelText('Há mais de (dias)');
    await user.clear(days);
    await user.type(days, '90');
    await waitFor(() => expect(staleMock).toHaveBeenLastCalledWith(expect.objectContaining({ days: 90 })));
  });

  it('X fora de 1–730 avisa e não consulta', async () => {
    const user = userEvent.setup({ delay: null });
    login('manager');
    renderPage();
    await screen.findByText('Dra. Nunca Visitada');
    const calls = staleMock.mock.calls.length;
    const days = screen.getByLabelText('Há mais de (dias)');
    await user.clear(days);
    await user.type(days, '0');
    expect(screen.getByText('De 1 a 730')).toBeInTheDocument();
    expect(staleMock.mock.calls.length).toBe(calls);
  });

  it('representante: sem seletor de representante e nunca manda responsibleId', async () => {
    login('representative', 'u-carla', 'Carla Rep');
    summaryMock.mockResolvedValue({ ...report, scope: 'own' });
    renderPage();
    await screen.findByText('66,7%');
    expect(screen.queryByLabelText('Representante')).not.toBeInTheDocument();
    expect(screen.getByText('Seus números: sua carteira e as visitas em que você é o responsável.')).toBeInTheDocument();
    expect(assigneesMock).not.toHaveBeenCalled();
    for (const [query] of summaryMock.mock.calls) expect(query).not.toHaveProperty('responsibleId');
    for (const [query] of staleMock.mock.calls) expect(query).not.toHaveProperty('responsibleId');
  });

  it('exporta CSV da tabela por representante e da lista de esquecidos', async () => {
    const user = userEvent.setup({ delay: null });
    login('manager');
    renderPage();
    await screen.findByText('Dra. Nunca Visitada');
    const [repButton, staleButton] = screen.getAllByRole('button', { name: 'Exportar CSV' });

    await user.click(repButton!);
    const [repFile, repRows] = downloadMock.mock.calls[0]!;
    expect(repFile).toMatch(/^visitacao-por-representante_/);
    expect(repRows[0]).toContain('Cobertura %');
    expect(repRows[1]).toEqual(['Carla Rep', 4, 2, 50, '1/1', '1/1', '0/1', '0/1', 3, 2, 1, 1]);

    await user.click(staleButton!);
    const [staleFile, staleRows] = downloadMock.mock.calls[1]!;
    expect(staleFile).toBe('medicos-sem-visita-60-dias_2026-11-22.csv');
    expect(staleRows[1]).toEqual(['Dra. Nunca Visitada', '123/SC', null, 'A', 'Carla Rep', 'Nunca visitado', null]);
    expect(staleRows[2]).toEqual(['Dr. Visita Antiga', null, null, 'B', 'Sem responsável', '01/08/2026', 113]);
  });

  it('período vazio do servidor: taxa e duração "—", tabela e barras com vazio', async () => {
    login('manager');
    summaryMock.mockResolvedValue({
      ...report,
      summary: {
        ...report.summary,
        scheduled: 0,
        completed: 0,
        cancelled: 0,
        notReceived: 0,
        total: 0,
        reschedules: 0,
        completionRate: null,
        averageDurationMinutes: null,
        durationSampleSize: 0,
        coverage: coverage(0, 0, null),
      },
      byRepresentative: [],
      byPurpose: [],
    });
    renderPage();
    expect(await screen.findByText('Sem visita no período.')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('Nenhum representante no período')).toBeInTheDocument();
  });
});
