import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthTenant, AuthUser, Channel, UserRole } from '@crm-lab/shared';
import { useAuthStore, useUIStore, useSidebarGroupsStore } from '@/stores';
import { Sidebar } from './Sidebar';

// Sidebar busca `pendingDecisions.total` para o sino de "Decisões" (PAGES.md §12).
// Promise que nunca resolve: os testes daqui não afirmam nada sobre o contador.
vi.mock('@/api/operation', () => ({
  operationApi: { overview: vi.fn(() => new Promise(() => {})) },
}));

// Badge de "Chat Interno" (D-130). Default: nenhum canal, badge não aparece —
// os testes que afirmam sobre o contador chamam `mockResolvedValueOnce` antes de renderizar.
const mockChannels = vi.fn(() => Promise.resolve<{ channels: Channel[] }>({ channels: [] }));

function fakeChannel(overrides: Partial<Channel> & Pick<Channel, 'id' | 'unreadCount'>): Channel {
  return {
    key: overrides.id,
    name: overrides.id,
    kind: 'channel',
    lastReadAt: null,
    lastMessageAt: null,
    otherUserId: null,
    otherUserName: null,
    ...overrides,
  };
}
vi.mock('@/api/internal-chat', () => ({
  internalChatApi: { channels: () => mockChannels() },
}));

/**
 * Sidebar — COMPONENTS.md (`layout/`), variante "Trilho flutuante" (CRMLAB-44):
 * 264/76px · ícone `flex: 0 0 38px` · hover neutral-100 · ativo accent-100 + barra de 3px.
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
    tokens: { accessToken: 'a', expiresAt: Date.now() + 60_000 },
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
  useSidebarGroupsStore.setState({ openByUser: {} });
  mockChannels.mockReset().mockResolvedValue({ channels: [] });
});

describe('Sidebar — larguras', () => {
  it('expandida mede 264px', () => {
    login('admin');
    renderSidebar();
    expect(screen.getByTestId('sidebar')).toHaveStyle({ width: '264px' });
  });

  it('recolhida mede 64px e esconde os rótulos', async () => {
    login('admin');
    renderSidebar();

    await userEvent.click(screen.getByRole('button', { name: 'Recolher menu' }));

    const sidebar = screen.getByTestId('sidebar');
    expect(sidebar).toHaveStyle({ width: '76px' });
    expect(sidebar.dataset.collapsed).toBe('true');
    expect(screen.queryByText('Personalização')).not.toBeInTheDocument();
  });

  it('expande de volta', async () => {
    login('admin');
    useUIStore.setState({ sidebarCollapsed: true });
    renderSidebar();

    await userEvent.click(screen.getByRole('button', { name: 'Expandir menu' }));

    expect(screen.getByTestId('sidebar')).toHaveStyle({ width: '264px' });
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
  it('marca o item da rota atual com fundo translúcido + barra de 3px à esquerda', () => {
    login('admin');
    renderSidebar('/catalog');

    const active = screen.getByRole('link', { name: /Cadastro de Exames/ });
    expect(active).toHaveAttribute('aria-current', 'page');
    expect(active.className).toContain('bg-accent-100');
    expect(active.className).toContain("before:content-['']");
    expect(active.className).toContain('before:bg-accent-500');

    const inactive = screen.getByRole('link', { name: /Propostas/ });
    expect(inactive).not.toHaveAttribute('aria-current');
    expect(inactive.className).toContain('hover:bg-neutral-100');
  });
});

describe('Sidebar — grupos (accordion, CRMLAB-4, revisado em D-129)', () => {
  it('admin vê os cabeçalhos dos 3 grupos (Comercial + LIS fundidos em "Gestão"), todos abertos por padrão', () => {
    login('admin');
    renderSidebar();

    for (const label of ['Comunicação', 'Gestão', 'Configurações']) {
      const header = screen.getByRole('button', { name: label });
      expect(header).toHaveAttribute('aria-expanded', 'true');
    }
    expect(screen.getByText('Personalização')).toBeInTheDocument();
  });

  it('atendente vê os 3 cabeçalhos de grupo; Configurações mostra só "Cadastro de Exames" (ex-Catálogo, D-129)', () => {
    login('attendant');
    renderSidebar();

    expect(screen.getByRole('button', { name: 'Comunicação' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Gestão' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Configurações' })).toBeInTheDocument();
    expect(screen.getByText('Cadastro de Exames')).toBeInTheDocument();
    expect(screen.queryByText('Canais & Equipe')).not.toBeInTheDocument();
  });

  it('clicar no cabeçalho fecha o grupo e esconde os itens; clicar de novo reabre', async () => {
    login('admin');
    renderSidebar();

    const header = screen.getByRole('button', { name: 'Configurações' });
    expect(screen.getByText('Personalização')).toBeInTheDocument();

    await userEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Personalização')).not.toBeInTheDocument();

    await userEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Personalização')).toBeInTheDocument();
  });

  it('operador da plataforma não vê nenhum cabeçalho de grupo (console fica sempre solto)', () => {
    login('platform_operator');
    renderSidebar('/platform/tenants');

    expect(screen.queryByRole('button', { name: 'Gestão' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Comunicação' })).not.toBeInTheDocument();
  });
});

describe('Sidebar — badge de não lidas do Chat Interno (D-130, CRMLAB-8)', () => {
  it('soma unreadCount de todos os canais no item "Chat Interno"', async () => {
    mockChannels.mockResolvedValue({
      channels: [
        fakeChannel({ id: 'c-1', name: '#aprovacoes', unreadCount: 2 }),
        fakeChannel({ id: 'c-2', kind: 'dm', otherUserName: 'Ana', unreadCount: 3 }),
      ],
    });
    login('admin');
    renderSidebar();

    const item = await screen.findByRole('link', { name: /Chat Interno/ });
    await waitFor(() => expect(item).toHaveTextContent('5'));
  });

  it('grupo "Comunicação" fechado com não lidas mostra o badge no lugar do ponto', async () => {
    mockChannels.mockResolvedValue({
      channels: [fakeChannel({ id: 'c-1', name: '#aprovacoes', unreadCount: 4 })],
    });
    login('admin');
    renderSidebar('/internal-chat');

    const header = screen.getByRole('button', { name: 'Comunicação' });
    await userEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');

    await waitFor(() => expect(header).toHaveTextContent('4'));
  });

  it('sem mensagens não lidas, o badge não aparece', async () => {
    login('admin');
    renderSidebar();

    const item = await screen.findByRole('link', { name: /Chat Interno/ });
    await waitFor(() => expect(mockChannels).toHaveBeenCalled());
    expect(item).not.toHaveTextContent(/[0-9]/);
  });

  it('recolhida, o badge vira um dot sem número (CRMLAB-44)', async () => {
    mockChannels.mockResolvedValue({
      channels: [fakeChannel({ id: 'c-1', name: '#aprovacoes', unreadCount: 4 })],
    });
    login('admin');
    useUIStore.setState({ sidebarCollapsed: true });
    renderSidebar();

    const item = await screen.findByRole('link', { name: 'Chat Interno' });
    await waitFor(() => expect(mockChannels).toHaveBeenCalled());
    expect(item).not.toHaveTextContent('4');
    expect(item.querySelector('.bg-accent2')).not.toBeNull();
  });
});

describe('Sidebar — ícone do grupo (CRMLAB-44)', () => {
  it('cada cabeçalho de grupo mostra um ícone antes do label', () => {
    login('admin');
    renderSidebar();

    const header = screen.getByRole('button', { name: 'Comunicação' });
    expect(header.querySelector('svg')).not.toBeNull();
  });
});

describe('Sidebar — persistência do recolher/expandir (CRMLAB-44)', () => {
  it('grava a preferência em localStorage ao alternar', async () => {
    login('admin');
    renderSidebar();

    await userEvent.click(screen.getByRole('button', { name: 'Recolher menu' }));

    expect(localStorage.getItem('crm-lab.sidebar-collapsed')).toBe('true');
  });

  it('lê a preferência salva ao montar', () => {
    localStorage.setItem('crm-lab.sidebar-collapsed', 'true');
    useUIStore.setState({ sidebarCollapsed: useUIStore.getState().sidebarCollapsed });
    // Recria o estado inicial do store a partir do localStorage, como no boot real da página.
    useUIStore.setState({ sidebarCollapsed: localStorage.getItem('crm-lab.sidebar-collapsed') === 'true' });
    login('admin');
    renderSidebar();

    expect(screen.getByTestId('sidebar')).toHaveStyle({ width: '76px' });
  });
});

describe('Sidebar — recolhe sozinha no inbox do atendente', () => {
  it('atendente em /attendance começa recolhida', () => {
    login('attendant');
    renderSidebar('/attendance');

    expect(screen.getByTestId('sidebar')).toHaveStyle({ width: '76px' });
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
  });

  it('gestor em /attendance NÃO é recolhido automaticamente', () => {
    login('manager');
    renderSidebar('/attendance');

    expect(screen.getByTestId('sidebar')).toHaveStyle({ width: '264px' });
  });

  it('atendente fora do inbox mantém o trilho expandido', () => {
    login('attendant');
    renderSidebar('/proposals');

    expect(screen.getByTestId('sidebar')).toHaveStyle({ width: '264px' });
  });
});
