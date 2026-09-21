import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginResponse } from '@crm-lab/shared';
import { http } from '@/api/client';
import { SERVER_DATA_KEYS, useAuthStore } from './auth.store';
import { useUIStore } from './ui.store';

const LOGIN: LoginResponse = {
  accessToken: 'access-1',
  expiresIn: 900,
  user: {
    id: 'u-1',
    email: 'marina@lab.com',
    name: 'Marina Alves',
    role: 'attendant',
    discountLimit: 15,
  },
  tenant: {
    id: 't-1',
    name: 'Laboratório Vida',
    slug: 'vida',
    theme: {
      accent: '#2f6f9f',
      accent2: '#4f9d8b',
      bg: '#eef3f7',
      surface: '#dbe6ef',
      text: '#1a1a1a',
      fontId: 'figtree',
      radiusId: 'redondo',
      brandName: 'Vida',
      logoUrl: null,
    },
  },
};

function stateData(): Record<string, unknown> {
  const state = useAuthStore.getState() as unknown as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(state).filter(([, value]) => typeof value !== 'function'),
  );
}

beforeEach(() => {
  localStorage.clear();
  useAuthStore.setState({ user: null, tenant: null, theme: null, tokens: null });
});

describe('useAuthStore — sessão', () => {
  it('setSession guarda tokens, usuário e tenant', () => {
    useAuthStore.getState().setSession(LOGIN);
    const state = useAuthStore.getState();

    expect(state.user?.id).toBe('u-1');
    expect(state.tenant?.slug).toBe('vida');
    expect(state.tokens?.accessToken).toBe('access-1');
    expect(state.tokens?.expiresAt).toBeGreaterThan(Date.now());
  });

  it('aplica o tema do payload de login — sem request extra de tema', () => {
    const root = document.documentElement;
    useAuthStore.getState().setSession(LOGIN);

    expect(root.style.getPropertyValue('--color-accent')).toBe('#2f6f9f');
    expect(root.dataset.radius).toBe('redondo');
    expect(root.dataset.font).toBe('figtree');
    // As rampas 100–900 NÃO são escritas em JS (D-005).
    expect(root.style.getPropertyValue('--color-accent-200')).toBe('');
  });

  it('setAccessToken troca o access token', () => {
    useAuthStore.getState().setSession(LOGIN);
    useAuthStore.getState().setAccessToken('access-2', 900);

    expect(useAuthStore.getState().tokens).toMatchObject({ accessToken: 'access-2' });
  });

  /**
   * CRMLAB-32 + revisão do PR #44: no bootstrap de página `tokens` é nulo mas
   * `user` (persistido) existe — o access token entra. Sem `user` NENHUM
   * (deslogado, ou refresh que resolveu depois do logout), o token é
   * descartado: não se ressuscita sessão morta.
   */
  it('setAccessToken com identidade persistida e tokens nulos cria os tokens (bootstrap de página)', () => {
    useAuthStore.getState().setSession(LOGIN);
    useAuthStore.setState({ tokens: null });
    useAuthStore.getState().setAccessToken('access-2', 900);
    expect(useAuthStore.getState().tokens?.accessToken).toBe('access-2');
  });

  it('setAccessToken sem sessão é no-op (não ressuscita sessão morta depois do logout)', () => {
    useAuthStore.getState().clearSession();
    useAuthStore.getState().setAccessToken('access-fantasma', 900);
    expect(useAuthStore.getState().tokens).toBeNull();
  });

  it('clearSession zera tudo e volta ao tema padrão', () => {
    useAuthStore.getState().setSession(LOGIN);
    useAuthStore.getState().clearSession();

    expect(stateData()).toEqual({ user: null, tenant: null, theme: null, tokens: null });
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe('#c67139');
  });
});

describe('fronteira Zustand × TanStack Query', () => {
  it('o estado tem SÓ sessão — nenhuma chave de dado de servidor', () => {
    useAuthStore.getState().setSession(LOGIN);

    expect(Object.keys(stateData()).sort()).toEqual(['tenant', 'theme', 'tokens', 'user']);

    for (const forbidden of SERVER_DATA_KEYS) {
      expect(Object.keys(stateData())).not.toContain(forbidden);
    }
  });

  it('o store de UI não guarda dado de servidor', () => {
    const ui = useUIStore.getState() as unknown as Record<string, unknown>;
    const keys = Object.entries(ui)
      .filter(([, value]) => typeof value !== 'function')
      .map(([key]) => key);

    // `lisFilters` é estado de FILTRO da sessão (D-117), não dado de servidor —
    // persiste em sessionStorage, mesma fronteira das outras chaves daqui.
    expect(keys.sort()).toEqual(['activeModal', 'contextPanelOpen', 'lisFilters', 'sidebarCollapsed']);
    for (const forbidden of SERVER_DATA_KEYS) {
      expect(keys).not.toContain(forbidden);
    }
  });

  /**
   * CRMLAB-32: `tokens` (access token) FICA FORA do localStorage — só
   * identidade/preferência (`user`/`tenant`/`theme`) persiste. O access token
   * vive em memória; o refresh vive no cookie httpOnly, que o JS nem lê.
   */
  it('o que vai para o localStorage é identidade e preferência — SEM tokens', () => {
    useAuthStore.getState().setSession(LOGIN);

    const raw = localStorage.getItem('crm-lab.session');
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw as string) as { state: Record<string, unknown> };

    expect(Object.keys(persisted.state).sort()).toEqual(['tenant', 'theme', 'user']);
    expect(persisted.state).not.toHaveProperty('tokens');
  });

  it('dado de servidor empurrado por escapatória de runtime NÃO é persistido', () => {
    useAuthStore.getState().setSession(LOGIN);
    // `setState` é escapatória de runtime (o tipo do estado não tem esta chave).
    // O `partialize` do persist é a rede de proteção: só sessão vai ao disco.
    useAuthStore.setState({ proposals: [{ id: 'p-1' }] } as unknown as Partial<
      ReturnType<typeof useAuthStore.getState>
    >);

    const persisted = JSON.parse(localStorage.getItem('crm-lab.session') as string) as {
      state: Record<string, unknown>;
    };
    expect(Object.keys(persisted.state).sort()).toEqual(['tenant', 'theme', 'user']);
    expect(persisted.state).not.toHaveProperty('proposals');
  });
});

describe('useUIStore', () => {
  it('recolhe e expande a sidebar', () => {
    useUIStore.setState({ sidebarCollapsed: false });
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
    useUIStore.getState().setSidebarCollapsed(false);
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });

  it('abre e fecha o modal ativo', () => {
    useUIStore.getState().openModal({ kind: 'proposal', id: 'p-1' });
    expect(useUIStore.getState().activeModal).toEqual({ kind: 'proposal', id: 'p-1' });
    useUIStore.getState().closeModal();
    expect(useUIStore.getState().activeModal).toBeNull();
  });

  it('alterna o painel de contexto do inbox', () => {
    useUIStore.setState({ contextPanelOpen: true });
    useUIStore.getState().toggleContextPanel();
    expect(useUIStore.getState().contextPanelOpen).toBe(false);
  });
});

describe('ponte com a camada de API', () => {
  it('importar o store já registra os tokens no client HTTP (dependência invertida)', async () => {
    useAuthStore.getState().setSession(LOGIN);

    const headers: Array<Record<string, string>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit = {}) => {
        headers.push((init.headers ?? {}) as Record<string, string>);
        return { ok: true, status: 200, text: () => Promise.resolve('{}') } as unknown as Response;
      }),
    );

    await http.get('/users/me');

    expect(headers[0]?.Authorization).toBe('Bearer access-1');
    vi.unstubAllGlobals();
  });
});
