import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import type { FunnelReport, PipelineSnapshot } from '@crm-lab/shared';
import type * as ApiClientModule from '@/api/client';
import { useAuthStore } from '@/stores/auth.store';
import { DEFAULT_THEME } from '@/lib/theme';
import Analytics from './Analytics';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  Mock por CHAVE, não por ordem de chamada
 * ═══════════════════════════════════════════════════════════════════════════
 * A versão anterior sobrescrevia uma das respostas com
 * `vi.mocked(http.get).mockImplementationOnce(...)`. Isso amarra o teste à
 * ORDEM em que o TanStack Query dispara as queries: passava por sorte, e
 * bastaria a tela ganhar uma query nova (ou disparar o pipeline antes da
 * conversão) para o payload `partial: true` ir parar no endpoint errado — e o
 * teste ficaria vermelho, ou pior, verde provando outra coisa.
 *
 * Aqui `http.get` despacha pela ROTA pedida, e cada teste sobrescreve a rota
 * que lhe interessa em `responses`. Ordem de disparo deixa de importar.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const { responses } = vi.hoisted(() => ({
  responses: new Map<string, unknown>(),
}));

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('@/api/client');
  return {
    ...actual,
    http: {
      get: vi.fn((url: string) => {
        for (const [route, payload] of responses) {
          if (url.includes(route)) return Promise.resolve(payload);
        }
        return Promise.reject(new Error(`Rota sem resposta registrada no teste: ${url}`));
      }),
      post: vi.fn(() => Promise.resolve({})),
      patch: vi.fn(() => Promise.resolve({})),
      put: vi.fn(() => Promise.resolve({})),
      delete: vi.fn(() => Promise.resolve({})),
    },
  };
});

/** Resposta de `/analytics/conversion` — shape de `FunnelReport` (§5). */
function conversionReport(overrides: Partial<FunnelReport> = {}): FunnelReport {
  return {
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
    // Chaves de `LossReason` — as inventadas do mock antigo (`preco_alto`,
    // `concorrencia`, `paciente_cancelou`) NAO existem no contrato; o `as any`
    // e que as deixava passar.
    lossReasons: { preco: 5, silencio: 3, exame_indisponivel: 2, prazo: 1, outro: 0 },
    revenue: 30000,
    averageTicket: 1000,
    topPerformers: [{ userId: 'user1', name: 'João', conversions: 10, revenue: 10000 }],
    partial: false,
    ...overrides,
  };
}

/** Resposta de `/analytics/pipeline` — shape de `PipelineSnapshot` (§5). */
function pipelineSnapshot(): PipelineSnapshot {
  return {
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
    oldestProposal: { id: 'prop1', daysOpen: 45, status: 'novo_contato' },
  };
}

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

/*
 * `MetricTile` NAO e mockado de proposito. Com o duble `{label}: {value}` os
 * numeros do contrato (`revenue: 30000`, `averageTicket`, `conversionRate`)
 * nunca chegavam a uma assercao — os testes so conferiam que quatro `div`
 * existiam. Com o componente real, o teste prova o caminho inteiro: numero do
 * contrato -> rotulo certo -> `variant` certa -> texto formatado em pt-BR.
 */

let queryClient: QueryClient;

function renderPage() {
  return render(
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Analytics />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('Analytics', () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    responses.clear();
    responses.set('/analytics/conversion', conversionReport());
    responses.set('/analytics/pipeline', pipelineSnapshot());

    useAuthStore.setState({
      user: {
        id: 'user1',
        email: 'atendente@lab.com',
        role: 'attendant',
        name: 'Test User',
        discountLimit: 10,
      },
      tenant: { id: 'tenant1', name: 'Test Tenant', slug: 'test-tenant', theme: DEFAULT_THEME },
      theme: null,
      tokens: null,
    });
  });

  it('renders analytics dashboard with title', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /conversão/i })).toBeInTheDocument();
    });
  });

  it('os 4 indicadores mostram os NUMEROS do contrato, cada um na sua unidade', async () => {
    renderPage();

    // `revenue: 30000` -> variant `money`.
    const receita = (await screen.findByText('Receita')).closest('div');
    expect(receita).not.toBeNull();
    expect(receita).toHaveTextContent('R$ 30.000,00');

    // `averageTicket: 1000` -> variant `money`.
    expect(screen.getByText('Ticket Médio').closest('div')).toHaveTextContent('R$ 1.000,00');

    // `conversionRate: 30` -> variant `percent`, uma casa decimal, pt-BR
    // (vírgula) — `MetricTile.tsx` corrigido na Onda 7 (pendência C3).
    expect(screen.getByText('Taxa de Conversão').closest('div')).toHaveTextContent('30,0%');

    // Soma do funil: 100+80+60+40+30+10 -> variant `number`.
    expect(screen.getByText('Propostas Criadas').closest('div')).toHaveTextContent('320');
  });

  it('renders conversion and revenue charts', async () => {
    renderPage();

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
    responses.set(
      '/analytics/conversion',
      conversionReport({
        funnel: {
          novoContato: 4,
          orcamentoEnviado: 3,
          followUp: 2,
          negociacao: 1,
          ganho: 1,
          perdido: 1,
          conversionRate: 25,
        },
        lossReasons: { preco: 1, silencio: 0, exame_indisponivel: 0, prazo: 0, outro: 0 },
        revenue: 1000,
        topPerformers: [],
        partial: true,
      }),
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/vers[aã]o parcial/i);
    });
  });

  it('não exibe o aviso de versão parcial quando partial: false', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('conversion-chart')).toBeInTheDocument();
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders loss reasons chart', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('loss-reasons-chart')).toBeInTheDocument();
    });
  });
});
