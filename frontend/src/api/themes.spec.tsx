import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Theme } from '@crm-lab/shared';
import { useUpdateTheme } from './themes';
import type * as clientModule from './client';
import { http } from './client';
import { useAuthStore } from '@/stores/auth.store';
import { DEFAULT_THEME } from '@/lib/theme';

vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof clientModule>('./client');
  return {
    ...actual,
    http: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  };
});

/** Tema salvo pelo servidor após aplicar o preset "Azul Jaleco". */
const savedTheme: Theme = {
  accent: '#2f6f9f',
  accent2: '#4f9d8b',
  bg: '#eef3f7',
  surface: '#dbe6ef',
  text: '#1a1a1a',
  fontId: 'playfair',
  radiusId: 'suave',
  brandName: null,
  logoUrl: null,
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * Defeito QA-E2E #2 (docs/domain/WORKFLOWS.md §9): salvar o tema só invalidava
 * a query. As CSS vars continuavam com o tema do login e, no reload,
 * `onRehydrateStorage` reaplicava o tema antigo guardado na sessão.
 */
describe('useUpdateTheme', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ theme: DEFAULT_THEME });
    // Estado inicial: tema do login já aplicado no documento.
    document.documentElement.style.setProperty('--color-accent', DEFAULT_THEME.accent);
    vi.mocked(http.patch).mockResolvedValue({ theme: savedTheme });
  });

  it('aplica o tema salvo nas CSS vars', async () => {
    const { result } = renderHook(() => useUpdateTheme(), { wrapper });

    result.current.mutate({ accent: savedTheme.accent });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe('#2f6f9f');
  });

  it('atualiza o tema da sessão — a troca sobrevive ao reload', async () => {
    const { result } = renderHook(() => useUpdateTheme(), { wrapper });

    result.current.mutate({ accent: savedTheme.accent });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(useAuthStore.getState().theme?.accent).toBe('#2f6f9f');

    // Simula o reload: onRehydrateStorage chama applySessionTheme().
    document.documentElement.style.setProperty('--color-accent', '#000000');
    useAuthStore.getState().applySessionTheme();
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe('#2f6f9f');
  });
});
