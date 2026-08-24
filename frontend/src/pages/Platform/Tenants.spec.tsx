import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListTenantsResponse, UserRole } from '@crm-lab/shared';
import { ApiError } from '@/api/client';
import { platformApi } from '@/api/platform';
import { useAuthStore } from '@/stores';
import PlatformTenants from './Tenants';

vi.mock('@/api/platform', () => ({
  platformApi: {
    tenants: vi.fn(),
    createTenant: vi.fn(),
    billing: vi.fn(),
  },
}));

const tenantsMock = vi.mocked(platformApi.tenants);
const createTenantMock = vi.mocked(platformApi.createTenant);

const listResponse: ListTenantsResponse = {
  tenants: [
    {
      id: 'tenant-1',
      name: 'Laboratório Vida',
      slug: 'lab-vida',
      isActive: true,
      subscriptionPlan: 'pro',
      subscriptionUntil: '2026-12-31',
      userCount: 8,
      createdAt: '2026-01-10T12:00:00.000Z',
    },
    {
      id: 'tenant-2',
      name: 'Laboratório Norte',
      slug: 'lab-norte',
      isActive: false,
      subscriptionPlan: 'starter',
      subscriptionUntil: null,
      userCount: 2,
      createdAt: '2026-02-10T12:00:00.000Z',
    },
  ],
  pagination: { page: 1, limit: 20, total: 2, totalPages: 1 },
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
        <PlatformTenants />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PlatformTenants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signIn('platform_operator');
    tenantsMock.mockResolvedValue(listResponse);
  });

  afterEach(() => {
    useAuthStore.setState({ user: null });
  });

  it('lista os laboratórios com plano, situação e validade', async () => {
    renderPage();

    expect(await screen.findByText('Laboratório Vida')).toBeInTheDocument();

    // Escopo na tabela: "Pro"/"Starter" também são opções do filtro de plano.
    const table = within(screen.getByRole('table'));
    expect(table.getByText('lab-vida')).toBeInTheDocument();
    expect(table.getByText('Pro')).toBeInTheDocument();
    expect(table.getByText('31/12/2026')).toBeInTheDocument();
    expect(table.getByText('Ativo')).toBeInTheDocument();
    expect(table.getByText('Inativo')).toBeInTheDocument();
    expect(table.getByText('Sem validade')).toBeInTheDocument();
  });

  it('consome GET /platform/tenants com página e limite do contrato', async () => {
    renderPage();

    await waitFor(() => expect(tenantsMock).toHaveBeenCalled());
    expect(tenantsMock).toHaveBeenCalledWith(expect.objectContaining({ page: 1, limit: 20 }));
  });

  it('mostra o estado vazio quando não há laboratórios', async () => {
    tenantsMock.mockResolvedValue({
      tenants: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });

    renderPage();

    expect(await screen.findByText('Nenhum laboratório encontrado')).toBeInTheDocument();
  });

  it('mostra o estado de erro com ação de nova tentativa', async () => {
    tenantsMock.mockRejectedValue(new ApiError('INTERNAL_ERROR', 'boom', 500));

    renderPage();

    expect(await screen.findByText('Não foi possível carregar os laboratórios')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeInTheDocument();
  });

  it('não busca nada e bloqueia quem não é operador da plataforma', async () => {
    signIn('admin');

    renderPage();

    expect(screen.getByText('Acesso restrito ao operador da plataforma')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Novo laboratório' })).not.toBeInTheDocument();
    await waitFor(() => expect(tenantsMock).not.toHaveBeenCalled());
  });

  it('envia o onboarding completo em um único POST', async () => {
    /**
     * `delay: null` (mesmo recurso já usado em InternalChat.spec.tsx).
     *
     * O padrão do userEvent espera ~1 tick de timer ENTRE CADA TECLA; este
     * teste digita 5 campos (≈60 caracteres), o que sozinho respondia por
     * quase todo o tempo de execução — 4622 ms contra um `testTimeout` de
     * 5000 ms, e vermelho numa máquina fria. O que se está verificando aqui é
     * o PAYLOAD do POST, não o ritmo da digitação, então o atraso entre
     * teclas não cobre risco nenhum. Aumentar o timeout esconderia a margem
     * em vez de devolvê-la.
     */
    const user = userEvent.setup({ delay: null });
    createTenantMock.mockResolvedValue({ tenant: listResponse.tenants[0]! });

    renderPage();
    await screen.findByText('Laboratório Vida');

    await user.click(screen.getByRole('button', { name: '+ Novo laboratório' }));

    await user.type(screen.getByLabelText('Nome do laboratório'), 'Laboratório Sul');
    await user.type(screen.getByLabelText('Slug'), 'lab-sul');
    await user.type(screen.getByLabelText('Nome do administrador'), 'Admin Sul');
    await user.type(screen.getByLabelText('E-mail do administrador'), 'admin@labsul.com.br');
    await user.type(screen.getByLabelText('Senha inicial'), 'senha-super-segura');
    await user.selectOptions(screen.getByLabelText('Plano'), 'pro');

    await user.click(screen.getByRole('button', { name: 'Criar laboratório' }));

    await waitFor(() =>
      expect(createTenantMock).toHaveBeenCalledWith({
        name: 'Laboratório Sul',
        slug: 'lab-sul',
        plan: 'pro',
        adminName: 'Admin Sul',
        adminEmail: 'admin@labsul.com.br',
        adminPassword: 'senha-super-segura',
      }),
    );
  });

  it('marca o campo slug quando o backend responde CONFLICT', async () => {
    const user = userEvent.setup();
    createTenantMock.mockRejectedValue(
      new ApiError('CONFLICT', 'Slug já existe', 409, { field: 'slug' }),
    );

    renderPage();
    await screen.findByText('Laboratório Vida');

    await user.click(screen.getByRole('button', { name: '+ Novo laboratório' }));
    await user.click(screen.getByRole('button', { name: 'Criar laboratório' }));

    expect(
      await screen.findByText('Já existe um laboratório com este slug'),
    ).toBeInTheDocument();
  });

  it('espalha details.fields de VALIDATION_ERROR nos campos do formulário', async () => {
    const user = userEvent.setup();
    createTenantMock.mockRejectedValue(
      new ApiError('VALIDATION_ERROR', 'Dados inválidos', 400, {
        fields: { adminEmail: 'E-mail invalido' },
      }),
    );

    renderPage();
    await screen.findByText('Laboratório Vida');

    await user.click(screen.getByRole('button', { name: '+ Novo laboratório' }));
    await user.click(screen.getByRole('button', { name: 'Criar laboratório' }));

    expect(await screen.findByText('E-mail invalido')).toBeInTheDocument();
  });
});
