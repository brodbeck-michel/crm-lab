import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthTenant, AuthUser, UserRole } from '@crm-lab/shared';
import { useAuthStore, useUIStore } from '@/stores';
import { Sidebar } from './Sidebar';

// Sidebar busca `pendingDecisions.total` para o sino de "Decisões" (PAGES.md §12).
// Promise que nunca resolve: os testes daqui não afirmam nada sobre o contador.
vi.mock('@/api/operation', () => ({
  operationApi: { overview: vi.fn(() => new Promise(() => {})) },
}));

/**
 * Sidebar — COMPONENTS.md (`layout/`):
 * 244/72px · ícone `flex: 0 0 38px` · hover accent-100 · ativo accent-200 + shadow-sm.
 * Conteúdo do trilho muda por perfil; a ESTRUTURA não.
 */

const TENANT: AuthTenant = {
  id: 't-1',
  name: 'Laboratório Vida',
  slug: 'vida',
  theme: {
    accent: 'var(--color-accent)',
    accent2: 'var(--color-accent-2)',
    bg: 'var(--color-bg)',
    surface: 'var(--color-surface)',
    text: 'var(--color-text)',
    fontId: 'figtree',
    radiusId: 'suave',
    brandName: 'Vida',
    logoUrl: null,
  },
};

function login(role: UserRole): void {
  const user: AuthUser = {
    id: 'u-1',
    email: 'a@lab.com',
    name: 'Marina Alves',
    role,
    discountLimit: 15,
  };
  useAuthStore.setState({
    user,
    tenant: TENANT,
    theme: TENANT.theme,
    tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 60_000 },
  });
}

function renderSidebar(path = '/proposals') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Sidebar />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useUIStore.setState({ sidebarCollapsed: false, contextPanelOpen: true, activeModal: null });
});

describe('Sidebar — larguras', () => {
  it('expandida mede 244px', () => {
    login('admin');
    renderSidebar();
    expect(screen.getByTestId('sidebar')).toHaveStyle({ width: '244px' });
  });

  it('recolhida mede 72px e esconde os rótulos', async () => {
    login('admin');
    renderSidebar();

    await userEvent.click(screen.getByRole('button', { name: 'Recolher menu' }));

    const sidebar = screen.getByTestId('sidebar');
    expect(sidebar).toHaveStyle({ width: '72px' });
    expect(sidebar.dataset.collapsed).toBe('true');
    expect(screen.queryByText('Personalização')).not.toBeInTheDocument();
  });

  it('expande de volta', async () => {
    login('admin');
    useUIStore.setState({ sidebarCollapsed: true });
    renderSidebar();

    await userEvent.click(screen.getByRole('button', { name: 'Expandir menu' }));

    expect(screen.getByTestId('sidebar')).toHaveStyle({ width: '244px' });
    expect(screen.getByText('Personalização')).toBeInTheDocument();
  });

  it('o ícone de cada item nunca comprime (flex: 0 0 38px)', () => {
    login('attendant');
    renderSidebar();

    const link = screen.getByRole('link', { name: /Propostas/ });
    const iconBox = link.firstElementChild as HTMLElement;
    expect(iconBox.style.flex).toBe('0 0 38px');
  });
});

describe('Sidebar — conteúdo por perfil (a estrutura é a mesma)', () => {
  it('atendente não vê itens de configuração', () => {
    login('attendant');
    renderSidebar();

    expect(screen.getByText('Atendimento')).toBeInTheDocument();
    expect(screen.getByText('Propostas')).toBeInTheDocument();
    expect(screen.queryByText('Usuários & Permissões')).not.toBeInTheDocument();
    expect(screen.queryByText('Gestão da Operação')).not.toBeInTheDocument();
  });

  it('gestor vê Gestão da Operação, mas não Usuários & Permissões', () => {
    login('manager');
    renderSidebar();

    expect(screen.getByText('Gestão da Operação')).toBeInTheDocument();
    expect(screen.queryByText('Usuários & Permissões')).not.toBeInTheDocument();
  });

  it('admin vê tudo do tenant', () => {
    login('admin');
    renderSidebar();

    expect(screen.getByText('Usuários & Permissões')).toBeInTheDocument();
    expect(screen.getByText('Personalização')).toBeInTheDocument();
  });

  it('operador da plataforma só vê o console — nada do laboratório', () => {
    login('platform_operator');
    renderSidebar('/platform/tenants');

    expect(screen.getByText('Laboratórios Clientes')).toBeInTheDocument();
    expect(screen.getByText('Assinaturas & Uso')).toBeInTheDocument();
    expect(screen.queryByText('Atendimento')).not.toBeInTheDocument();
    expect(screen.queryByText('Chat Interno')).not.toBeInTheDocument();
  });
});

describe('Sidebar — item ativo', () => {
  it('marca o item da rota atual com accent-200 + shadow-sm', () => {
    login('admin');
    renderSidebar('/catalog');

    const active = screen.getByRole('link', { name: /Catálogo/ });
    expect(active).toHaveAttribute('aria-current', 'page');
    expect(active.className).toContain('bg-accent-200');
    expect(active.className).toContain('shadow-sm');

    const inactive = screen.getByRole('link', { name: /Propostas/ });
    expect(inactive).not.toHaveAttribute('aria-current');
    expect(inactive.className).toContain('hover:bg-accent-100');
  });
});

describe('Sidebar — recolhe sozinha no inbox do atendente', () => {
  it('atendente em /attendance começa recolhida', () => {
    login('attendant');
    renderSidebar('/attendance');

    expect(screen.getByTestId('sidebar')).toHaveStyle({ width: '72px' });
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
  });

  it('gestor em /attendance NÃO é recolhido automaticamente', () => {
    login('manager');
    renderSidebar('/attendance');

    expect(screen.getByTestId('sidebar')).toHaveStyle({ width: '244px' });
  });

  it('atendente fora do inbox mantém o trilho expandido', () => {
    login('attendant');
    renderSidebar('/proposals');

    expect(screen.getByTestId('sidebar')).toHaveStyle({ width: '244px' });
  });
});
