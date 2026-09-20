import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useRoutes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthTenant, AuthUser, UserRole } from '@crm-lab/shared';
import { ToastProvider } from '@/components/ui';
import { useAuthStore, useUIStore } from '@/stores';
import { appRoutes } from './index';
import { PLATFORM_THEME } from './platform-theme';

/**
 * Guards de rota (PAGES.md — "Guard de rotas").
 * Lembrete gravado no teste: isto é UX. A barreira real é o servidor.
 *
 * O teste monta `appRoutes` — o MESMO array que `App.tsx` entrega ao
 * `createBrowserRouter` — via `useRoutes` dentro de um `MemoryRouter`.
 */

const TENANT: AuthTenant = {
  id: 't-1',
  name: 'Laboratório Vida',
  slug: 'vida',
  theme: {
    accent: '#c67139',
    accent2: '#7a8a5e',
    bg: '#f5ead8',
    surface: '#ebddc5',
    text: '#1a1a1a',
    fontId: 'figtree',
    radiusId: 'suave',
    brandName: 'Vida',
    logoUrl: null,
  },
};

function userWith(role: UserRole): AuthUser {
  return { id: 'u-1', email: 'a@lab.com', name: 'Marina Alves', role, discountLimit: 15 };
}

function login(role: UserRole): void {
  useAuthStore.setState({
    user: userWith(role),
    tenant: TENANT,
    theme: TENANT.theme,
    tokens: { accessToken: 'access-1', expiresAt: Date.now() + 60_000 },
  });
}

function logout(): void {
  useAuthStore.setState({ user: null, tenant: null, theme: null, tokens: null });
}

function RoutesUnderTest() {
  return useRoutes(appRoutes);
}

/** Espelha a localização atual no DOM para as asserções. */
function LocationProbe() {
  const location = useLocation();
  return (
    <>
      <span data-testid="location">{location.pathname}</span>
      <span data-testid="location-state">{JSON.stringify(location.state ?? null)}</span>
    </>
  );
}

function renderAt(path: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <RoutesUnderTest />
          <LocationProbe />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function expectPath(expected: string): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('location')).toHaveTextContent(expected);
  });
}

function locationState(): { from?: string } | null {
  return JSON.parse(screen.getByTestId('location-state').textContent ?? 'null') as {
    from?: string;
  } | null;
}

beforeEach(() => {
  localStorage.clear();
  logout();
  useUIStore.setState({ sidebarCollapsed: false, contextPanelOpen: true, activeModal: null });
});

describe('RequireAuth', () => {
  it('sem sessão manda para /login', async () => {
    renderAt('/proposals');
    await expectPath('/login');
  });

  it('guarda de onde o usuário veio para voltar depois do login', async () => {
    renderAt('/catalog');
    await expectPath('/login');
    expect(locationState()?.from).toBe('/catalog');
  });

  it('com sessão, renderiza a rota pedida', async () => {
    login('manager');
    renderAt('/proposals');

    await expectPath('/proposals');
    expect(screen.getByRole('heading', { name: 'Pipeline de Propostas' })).toBeInTheDocument();
  });
});

describe('RequireRoles', () => {
  it('papel errado: redireciona para a home do perfil E mostra toast', async () => {
    login('attendant');
    renderAt('/settings/users');

    await expectPath('/attendance');
    expect(
      await screen.findByText('Você não tem permissão para acessar esta área.'),
    ).toBeInTheDocument();
  });

  it('gestor não entra em rota exclusiva de admin', async () => {
    login('manager');
    renderAt('/settings/theme');
    await expectPath('/proposals');
  });

  it('gestor entra em /settings/operation', async () => {
    login('manager');
    renderAt('/settings/operation');
    await expectPath('/settings/operation');
  });

  it('admin entra em /settings/users', async () => {
    login('admin');
    renderAt('/settings/users');
    await expectPath('/settings/users');
  });

  it('operador da plataforma NÃO acessa conversas do laboratório (PAGES.md §11)', async () => {
    login('platform_operator');
    renderAt('/attendance');
    await expectPath('/platform/tenants');
  });

  it('usuário de tenant NÃO acessa o console da plataforma', async () => {
    login('admin');
    renderAt('/platform/billing');
    await expectPath('/proposals');
  });
});

describe('redirect de "/" por perfil', () => {
  it('atendente → /attendance', async () => {
    login('attendant');
    renderAt('/');
    await expectPath('/attendance');
  });

  it('gestor → /proposals', async () => {
    login('manager');
    renderAt('/');
    await expectPath('/proposals');
  });

  it('admin → /proposals', async () => {
    login('admin');
    renderAt('/');
    await expectPath('/proposals');
  });

  it('operador da plataforma → /platform/tenants', async () => {
    login('platform_operator');
    renderAt('/');
    await expectPath('/platform/tenants');
  });

  it('sem sessão, "/" cai em /login', async () => {
    renderAt('/');
    await expectPath('/login');
  });
});

describe('console da plataforma é isolado', () => {
  it('aplica identidade visual própria (não o tema do tenant)', async () => {
    login('platform_operator');
    renderAt('/platform/tenants');

    await expectPath('/platform/tenants');
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe(
      PLATFORM_THEME.accent,
    );
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
  });

  it('rota inexistente cai no placeholder de não encontrado', async () => {
    login('admin');
    renderAt('/rota-que-nao-existe');

    await expectPath('/rota-que-nao-existe');
    expect(screen.getByRole('heading', { name: 'Página não encontrada' })).toBeInTheDocument();
  });
});
