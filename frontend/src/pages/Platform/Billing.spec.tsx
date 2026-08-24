import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingResponse, UserRole } from '@crm-lab/shared';
import { ApiError } from '@/api/client';
import { platformApi } from '@/api/platform';
import { useAuthStore } from '@/stores';
import PlatformBilling from './Billing';

vi.mock('@/api/platform', () => ({
  platformApi: {
    tenants: vi.fn(),
    createTenant: vi.fn(),
    billing: vi.fn(),
  },
}));

const billingMock = vi.mocked(platformApi.billing);

const billingResponse: BillingResponse = {
  usage: [
    {
      tenantId: 'tenant-1',
      tenantName: 'Laboratório Vida',
      plan: 'pro',
      messagesIncluded: 5000,
      messagesUsed: 5250,
      extraMessages: 250,
      proposalCount: 44,
      monthlyPrice: 824,
    },
    {
      tenantId: 'tenant-2',
      tenantName: 'Laboratório Norte',
      plan: 'starter',
      messagesIncluded: 1000,
      messagesUsed: 500,
      extraMessages: 0,
      proposalCount: 7,
      monthlyPrice: 299,
    },
  ],
  totals: { mrr: 1123, tenants: 2, messages: 5750 },
};

function signIn(role: UserRole) {
  useAuthStore.setState({
    user: {
      id: 'user-1',
      email: 'op@plataforma.com.br',
      name: 'Operador',
      role,
      discountLimit: 0,
    },
  });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PlatformBilling />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PlatformBilling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signIn('platform_operator');
    billingMock.mockResolvedValue(billingResponse);
  });

  afterEach(() => {
    useAuthStore.setState({ user: null });
  });

  it('consome GET /platform/billing e formata o MRR em pt-BR', async () => {
    renderPage();

    await waitFor(() => expect(billingMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('R$ 1,1 mil')).toBeInTheDocument();
    expect(screen.getByText('Laboratórios ativos')).toBeInTheDocument();
  });

  it('exibe plano, franquia, excedente e mensalidade de cada laboratório', async () => {
    renderPage();

    expect(await screen.findByText('Laboratório Vida')).toBeInTheDocument();
    expect(screen.getByText('Pro')).toBeInTheDocument();
    expect(screen.getByText('5000')).toBeInTheDocument();
    expect(screen.getByText('250')).toBeInTheDocument();
    expect(screen.getByText('R$ 824,00')).toBeInTheDocument();
    expect(screen.getByText('R$ 299,00')).toBeInTheDocument();
  });

  it('mostra o consumo da franquia como percentual', async () => {
    renderPage();

    expect(await screen.findByText('(105%)')).toBeInTheDocument();
    expect(screen.getByText('(50%)')).toBeInTheDocument();
  });

  it('mostra o estado vazio quando não há assinatura no mês', async () => {
    billingMock.mockResolvedValue({ usage: [], totals: { mrr: 0, tenants: 0, messages: 0 } });

    renderPage();

    expect(
      await screen.findByText('Nenhuma assinatura para faturar neste mês'),
    ).toBeInTheDocument();
  });

  it('mostra o estado de erro com ação de nova tentativa', async () => {
    billingMock.mockRejectedValue(new ApiError('INTERNAL_ERROR', 'boom', 500));

    renderPage();

    expect(await screen.findByText('Não foi possível carregar o faturamento')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeInTheDocument();
  });

  it('não busca faturamento para quem não é operador da plataforma', async () => {
    signIn('manager');

    renderPage();

    expect(screen.getByText('Acesso restrito ao operador da plataforma')).toBeInTheDocument();
    await waitFor(() => expect(billingMock).not.toHaveBeenCalled());
  });
});
