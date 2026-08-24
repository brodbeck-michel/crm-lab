import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import { QueryClient } from '@tanstack/react-query';
import Analytics from './Analytics';
import { http } from '@/api/client';

// Mock the API calls
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual('@/api/client');
  return {
    ...actual,
    http: {
      get: vi.fn((url) => {
        if (url.includes('/analytics/conversion')) {
          return Promise.resolve({
            period: { startDate: '2026-01-01', endDate: '2026-12-31' },
            funnel: {
              novoContato: 100,
              orcamentoEnviado: 80,
              followUp: 60,
              negociacao: 40,
              ganho: 30,
              perdido: 10,
              conversionRate: 30,
            },
            lossReasons: {
              preco_alto: 5,
              concorrencia: 3,
              paciente_cancelou: 2,
            },
            revenue: 30000,
            averageTicket: 1000,
            topPerformers: [
              {
                userId: 'user1',
                name: 'João',
                conversions: 10,
                revenue: 10000,
              },
            ],
            partial: false,
          });
        }
        if (url.includes('/analytics/pipeline')) {
          return Promise.resolve({
            byStatus: {
              novo_contato: { count: 20, value: 5000 },
              orcamento_enviado: { count: 15, value: 8000 },
              follow_up: { count: 10, value: 6000 },
              negociacao: { count: 5, value: 3000 },
              ganho: { count: 30, value: 30000 },
              perdido: { count: 10, value: 5000 },
            },
            totalValue: 57000,
            averageTicket: 1900,
            openCount: 50,
            oldestProposal: {
              id: 'prop1',
              daysOpen: 45,
              status: 'novo_contato',
            },
          });
        }
        return Promise.resolve({});
      }),
      post: vi.fn(() => Promise.resolve({})),
      patch: vi.fn(() => Promise.resolve({})),
      put: vi.fn(() => Promise.resolve({})),
      delete: vi.fn(() => Promise.resolve({})),
    },
  };
});

// Mock the chart components
vi.mock('@/components/analytics/ConversionChart', () => ({
  default: () => <div data-testid="conversion-chart">Funil de Conversão</div>,
}));

vi.mock('@/components/analytics/RevenueChart', () => ({
  default: () => <div data-testid="revenue-chart">Receita Acumulada</div>,
}));

vi.mock('@/components/analytics/LossReasonsChart', () => ({
  default: () => <div data-testid="loss-reasons-chart">Motivos de Perda</div>,
}));

vi.mock('@/components/analytics/MetricTile', () => ({
  default: ({ label, value }: { label: string; value: number }) => (
    <div data-testid={`metric-tile-${label}`}>
      {label}: {value}
    </div>
  ),
}));

// Create a fresh query client for each test
let queryClient: QueryClient;

describe('Analytics', () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    useAuthStore.setState({
      user: { id: 'user1', role: 'attendant', name: 'Test User', discountLimit: 10 },
      tenant: { id: 'tenant1', name: 'Test Tenant' },
      theme: null,
      tokens: null,
    } as any);
  });

  it('renders analytics dashboard with title', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Analytics />
        </BrowserRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /conversão/i })).toBeInTheDocument();
    });
  });

  it('renders 4 metric tiles', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Analytics />
        </BrowserRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('metric-tile-Receita')).toBeInTheDocument();
      expect(screen.getByTestId('metric-tile-Ticket Médio')).toBeInTheDocument();
      expect(screen.getByTestId('metric-tile-Taxa de Conversão')).toBeInTheDocument();
      expect(screen.getByTestId('metric-tile-Propostas Criadas')).toBeInTheDocument();
    });
  });

  it('renders conversion and revenue charts', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Analytics />
        </BrowserRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('conversion-chart')).toBeInTheDocument();
      expect(screen.getByTestId('revenue-chart')).toBeInTheDocument();
    });
  });

  /**
   * Defeito QA-E2E #3: o backend devolve `partial: true` para atendente
   * (docs/STATUS.md — pedido do Agent-API-Analytics; PAGES.md §8 "versão
   * PARCIAL"), mas a tela não exibia aviso nenhum.
   */
  it('exibe o aviso de versão parcial quando partial: true', async () => {
    vi.mocked(http.get).mockImplementationOnce(() =>
      Promise.resolve({
        period: { startDate: '2026-01-01', endDate: '2026-12-31' },
        funnel: {
          novoContato: 4,
          orcamentoEnviado: 3,
          followUp: 2,
          negociacao: 1,
          ganho: 1,
          perdido: 1,
          conversionRate: 25,
        },
        lossReasons: { preco_alto: 1 },
        revenue: 1000,
        averageTicket: 1000,
        topPerformers: [],
        partial: true,
      }),
    );

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Analytics />
        </BrowserRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/vers[aã]o parcial/i);
    });
  });

  it('não exibe o aviso de versão parcial quando partial: false', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Analytics />
        </BrowserRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('conversion-chart')).toBeInTheDocument();
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders loss reasons chart', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Analytics />
        </BrowserRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loss-reasons-chart')).toBeInTheDocument();
    });
  });
});
