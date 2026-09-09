import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantDetail, UserRole } from '@crm-lab/shared';
import { ApiError } from '@/api/client';
import { platformApi } from '@/api/platform';
import { useAuthStore } from '@/stores';
import PlatformTenantDetail from './TenantDetail';

/**
 * `/platform/tenants/:id` (D-102, PAGES.md §11.1) — drill-down do console da
 * plataforma. Cobre: render dos 3 blocos (integrações, saúde de uso, admins),
 * os 3 fluxos de mutation (suspender, trocar plano, resetar senha) e o modal
 * de senha temporária.
 */
vi.mock('@/api/platform', () => ({
  platformApi: {
    tenants: vi.fn(),
    createTenant: vi.fn(),
    billing: vi.fn(),
    tenant: vi.fn(),
    updateTenant: vi.fn(),
    resetAdminPassword: vi.fn(),
  },
}));

const tenantMock = vi.mocked(platformApi.tenant);
const updateTenantMock = vi.mocked(platformApi.updateTenant);
const resetPasswordMock = vi.mocked(platformApi.resetAdminPassword);

const TENANT_ID = 'tenant-1';

const DETAIL: TenantDetail = {
  id: TENANT_ID,
  name: 'Laboratório Vida',
  slug: 'lab-vida',
  isActive: true,
  subscriptionPlan: 'pro',
  subscriptionUntil: '2026-12-31',
  userCount: 8,
  createdAt: '2026-01-10T12:00:00.000Z',
  channels: [
    {
      channel: 'whatsapp',
      isActive: true,
      connectionMode: 'cloud_api',
      connectedAt: '2026-02-01T09:00:00.000Z',
    },
  ],
  admins: [{ id: 'admin-1', email: 'admin@labvida.com.br' }],
  usage: {
    activeUsers: 6,
    totalUsers: 8,
    lastLoginAt: '2026-09-08T18:22:00.000Z',
    proposalsThisMonth: 44,
    messagesThisMonth: 5250,
  },
};

function signIn(role: UserRole) {
  useAuthStore.setState({
    user: { id: 'user-1', email: 'op@plataforma.com.br', name: 'Operador', role, discountLimit: 0 },
  });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/platform/tenants/${TENANT_ID}`]}>
        <Routes>
          <Route path="/platform/tenants/:id" element={<PlatformTenantDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PlatformTenantDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signIn('platform_operator');
    tenantMock.mockResolvedValue(DETAIL);
  });

  afterEach(() => {
    useAuthStore.setState({ user: null });
  });

  it('mostra cadastro, status de canal e saúde de uso', async () => {
    renderPage();

    expect(await screen.findByText('Laboratório Vida')).toBeInTheDocument();
    expect(screen.getByText('/lab-vida')).toBeInTheDocument();
    expect(screen.getByText('WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('Conectado')).toBeInTheDocument();

    // Saúde de uso
    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.getByText('44')).toBeInTheDocument();
    expect(screen.getByText('5250')).toBeInTheDocument();
  });

  it('não busca nada e bloqueia quem não é operador da plataforma', async () => {
    signIn('admin');
    renderPage();

    expect(screen.getByText('Acesso restrito ao operador da plataforma')).toBeInTheDocument();
    await waitFor(() => expect(tenantMock).not.toHaveBeenCalled());
  });

  it('suspende o laboratório após confirmação', async () => {
    const user = userEvent.setup({ delay: null });
    updateTenantMock.mockResolvedValue({ ...DETAIL, isActive: false });
    renderPage();
    await screen.findByText('Laboratório Vida');

    await user.click(screen.getByRole('button', { name: 'Suspender' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Suspender laboratório' }));
    await user.click(dialog.getByRole('button', { name: 'Suspender' }));

    await waitFor(() =>
      expect(updateTenantMock).toHaveBeenCalledWith(TENANT_ID, { isActive: false }),
    );
  });

  it('troca o plano após confirmação', async () => {
    const user = userEvent.setup({ delay: null });
    updateTenantMock.mockResolvedValue({ ...DETAIL, subscriptionPlan: 'enterprise' });
    renderPage();
    await screen.findByText('Laboratório Vida');

    await user.click(screen.getByRole('button', { name: 'Trocar plano' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Trocar plano' }));
    await user.selectOptions(dialog.getByLabelText('Novo plano'), 'enterprise');
    await user.click(dialog.getByRole('button', { name: 'Confirmar' }));

    await waitFor(() =>
      expect(updateTenantMock).toHaveBeenCalledWith(TENANT_ID, { subscriptionPlan: 'enterprise' }),
    );
  });

  it('reseta a senha do único admin e mostra a senha temporária uma vez', async () => {
    const user = userEvent.setup({ delay: null });
    resetPasswordMock.mockResolvedValue({
      userId: 'admin-1',
      email: 'admin@labvida.com.br',
      temporaryPassword: 'kQ7f2m9Xp1zR',
    });
    renderPage();
    await screen.findByText('Laboratório Vida');

    await user.click(screen.getByRole('button', { name: 'Resetar senha do admin' }));
    const confirmDialog = within(screen.getByRole('dialog', { name: 'Resetar senha do admin' }));
    await user.click(confirmDialog.getByRole('button', { name: 'Resetar senha' }));

    await waitFor(() =>
      expect(resetPasswordMock).toHaveBeenCalledWith(TENANT_ID, 'admin-1'),
    );
    expect(await screen.findByText('kQ7f2m9Xp1zR')).toBeInTheDocument();
  });

  it('desabilita o reset quando não há admin cadastrado', async () => {
    tenantMock.mockResolvedValue({ ...DETAIL, admins: [] });
    renderPage();

    expect(await screen.findByText('Nenhum admin cadastrado')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resetar senha do admin' })).toBeDisabled();
  });

  it('mostra erro quando o reset de senha falha', async () => {
    const user = userEvent.setup({ delay: null });
    resetPasswordMock.mockRejectedValue(new ApiError('NOT_FOUND', 'not found', 404));
    renderPage();
    await screen.findByText('Laboratório Vida');

    await user.click(screen.getByRole('button', { name: 'Resetar senha do admin' }));
    const confirmDialog = within(screen.getByRole('dialog', { name: 'Resetar senha do admin' }));
    await user.click(confirmDialog.getByRole('button', { name: 'Resetar senha' }));

    expect(await screen.findByText('Não foi possível resetar a senha.')).toBeInTheDocument();
  });
});
