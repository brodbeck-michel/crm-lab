import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationOverviewResponse } from '@crm-lab/shared';
import type * as ApiModule from '@/api';

const overviewMock = vi.fn();
const approveMock = vi.fn();
const rejectMock = vi.fn();

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    operationApi: { ...actual.operationApi, overview: overviewMock },
    api: {
      ...actual.api,
      proposals: { ...actual.api.proposals, approve: approveMock, reject: rejectMock },
    },
  };
});

const { ApiError } = await import('@/api');
const { ToastProvider } = await import('@/components/ui');
const { useAuthStore } = await import('@/stores');
const { default: Decisions } = await import('./Decisions');

/**
 * Decisões — PAGES.md §12. Desde o CRMLAB-146 (D-318) é aqui que o gestor
 * aprova ou rejeita (antes era no chat interno). Protege: os PATCH certos, a
 * rejeição SEMPRE com motivo e a auto-aprovação (D-046) virando um toast
 * explicativo — nunca um estado otimista de "aprovado".
 */

const PROPOSAL_ID = '44444444-4444-4444-8444-444444444444';
const T0 = '2026-11-12T10:00:00Z';

const OVERVIEW: OperationOverviewResponse = {
  generatedAt: T0,
  queue: { unassigned: 0, waiting: 0, oldestWaitSeconds: null, items: [] },
  workload: [],
  pendingDecisions: {
    total: 1,
    items: [
      {
        proposalId: PROPOSAL_ID,
        patientName: 'Marina Alves',
        createdBy: 'u-9',
        createdByName: 'Carla Souza',
        status: 'novo_contato',
        discountPercent: 40,
        totalPrice: 179.8,
        createdAt: T0,
        waitingSeconds: 120,
      },
    ],
    pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
  },
};

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/decisions']}>
          <Decisions />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({
    user: { id: 'u-1', email: 'gestor@lab.com', name: 'Ana', role: 'manager', discountLimit: 30 },
    tenant: null,
    theme: null,
    tokens: { accessToken: 'a', expiresAt: Date.now() + 60_000 },
  });
  overviewMock.mockResolvedValue(OVERVIEW);
  approveMock.mockResolvedValue({ id: PROPOSAL_ID, approvalStatus: 'approved', approvedAt: T0 });
  rejectMock.mockResolvedValue({ id: PROPOSAL_ID, approvalStatus: 'rejected', approvedAt: null });
});

describe('Decisões — aprovar e rejeitar (CRMLAB-146)', () => {
  it('aprova pelo PATCH /proposals/:id/approve', async () => {
    const user = userEvent.setup({ delay: null });
    renderScreen();

    await user.click(await screen.findByRole('button', { name: 'Aprovar desconto de Marina Alves' }));

    await waitFor(() => expect(approveMock).toHaveBeenCalledWith(PROPOSAL_ID));
    expect(await screen.findByText('Desconto aprovado.')).toBeInTheDocument();
  });

  it('exige motivo para rejeitar e envia o motivo digitado', async () => {
    const user = userEvent.setup({ delay: null });
    renderScreen();

    await user.click(await screen.findByRole('button', { name: 'Rejeitar desconto de Marina Alves' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar rejeição' }));

    expect(rejectMock).not.toHaveBeenCalled();
    expect(await screen.findByText('Informe o motivo da rejeição.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Motivo da rejeição'), 'Desconto fora da tabela');
    await user.click(screen.getByRole('button', { name: 'Confirmar rejeição' }));

    await waitFor(() =>
      expect(rejectMock).toHaveBeenCalledWith(PROPOSAL_ID, { reason: 'Desconto fora da tabela' }),
    );
  });

  it('explica a recusa de auto-aprovação (D-046) em vez de fingir sucesso', async () => {
    approveMock.mockRejectedValue(
      new ApiError('FORBIDDEN', 'Acesso negado', 403, { reason: 'self_approval' }),
    );
    const user = userEvent.setup({ delay: null });
    renderScreen();

    await user.click(await screen.findByRole('button', { name: 'Aprovar desconto de Marina Alves' }));

    expect(await screen.findByText(/Você não pode aprovar a própria proposta/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Aprovar desconto de Marina Alves' }),
    ).toBeInTheDocument();
  });
});
