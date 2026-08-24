import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { AuthTenant, AuthUser, LoginResponse, Theme, UserRole } from '@crm-lab/shared';
import { setSessionBridge } from '@/api/client';
import { applyTheme, DEFAULT_THEME } from '@/lib/theme';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  FRONTEIRA — a regra que mais se viola sem perceber
 * ═══════════════════════════════════════════════════════════════════════════
 * Zustand guarda SESSÃO e ESTADO DE UI. Dados de servidor (conversas,
 * propostas, exames, analytics, usuários, auditoria) vivem SEMPRE no
 * TanStack Query e NUNCA são copiados para cá
 * (docs/frontend/PAGES.md — "Estado Global" · CONVENTIONS.md — "Proibido").
 *
 * `user`, `tenant` e `theme` ficam aqui porque são o resultado do LOGIN —
 * identidade da sessão, não uma listagem que o servidor atualiza. Eles chegam
 * dentro do `LoginResponse` e não têm endpoint de refetch no bootstrap
 * (o tema NÃO é buscado de novo: FRONTEND_BACKEND.md é explícito).
 *
 * Teste de fronteira: `auth.store.spec.ts` falha se aparecer no estado
 * qualquer chave de coleção de servidor.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms de expiração do access token (derivado de `expiresIn`). */
  expiresAt: number;
}

export interface AuthState {
  user: AuthUser | null;
  tenant: AuthTenant | null;
  theme: Theme | null;
  tokens: SessionTokens | null;

  /** Login concluído: guarda a sessão e aplica o tema que veio no payload. */
  setSession: (response: LoginResponse) => void;
  /** Só o access token — usado pelo interceptor de refresh. */
  setAccessToken: (accessToken: string, expiresIn: number) => void;
  /**
   * Personalização salva (`PATCH /themes/current`): guarda o tema novo na
   * sessão E o aplica. Sem isso a troca não sobrevive ao reload — o
   * `onRehydrateStorage` reaplicaria o tema que veio do login
   * (docs/domain/WORKFLOWS.md §9).
   */
  setTheme: (theme: Theme) => void;
  /** Logout / refresh inválido. Volta ao tema padrão. */
  clearSession: () => void;
  /** Reaplica o tema da sessão restaurada (chamado no bootstrap). */
  applySessionTheme: () => void;
}

/** Chaves de dados de SERVIDOR — nunca podem existir neste store. */
export const SERVER_DATA_KEYS = [
  'conversations',
  'conversation',
  'messages',
  'proposals',
  'proposal',
  'exams',
  'analytics',
  'users',
  'audit',
  'channels',
  'tenants',
] as const;

const EMPTY = { user: null, tenant: null, theme: null, tokens: null } as const;

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      ...EMPTY,

      setSession: (response) => {
        set({
          user: response.user,
          tenant: response.tenant,
          theme: response.tenant.theme,
          tokens: {
            accessToken: response.accessToken,
            refreshToken: response.refreshToken,
            expiresAt: Date.now() + response.expiresIn * 1000,
          },
        });
        applyTheme(response.tenant.theme);
      },

      setAccessToken: (accessToken, expiresIn) => {
        const current = get().tokens;
        if (!current) return;
        set({
          tokens: { ...current, accessToken, expiresAt: Date.now() + expiresIn * 1000 },
        });
      },

      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },

      clearSession: () => {
        set({ ...EMPTY });
        applyTheme(DEFAULT_THEME);
      },

      applySessionTheme: () => {
        applyTheme(get().theme ?? DEFAULT_THEME);
      },
    }),
    {
      name: 'crm-lab.session',
      storage: createJSONStorage(() => localStorage),
      // Persistimos SOMENTE sessão. Nenhum dado de servidor entra aqui.
      partialize: (state) => ({
        user: state.user,
        tenant: state.tenant,
        theme: state.theme,
        tokens: state.tokens,
      }),
      onRehydrateStorage: () => (state) => {
        // Restaurar sessão reaplica o tema — sem request extra (D-005).
        state?.applySessionTheme();
      },
    },
  ),
);

/* ── Seletores (evitam re-render por objeto novo) ───────────────────────── */

export const selectUser = (state: AuthState): AuthUser | null => state.user;
export const selectRole = (state: AuthState): UserRole | null => state.user?.role ?? null;
export const selectIsAuthenticated = (state: AuthState): boolean =>
  state.tokens !== null && state.user !== null;

/* ── Ponte com a camada de API ──────────────────────────────────────────── */

/**
 * Registra o store como fonte dos tokens do `client.ts`.
 * O client NÃO importa o store (evitaria ciclo) — a dependência é invertida.
 */
setSessionBridge({
  getAccessToken: () => useAuthStore.getState().tokens?.accessToken ?? null,
  getRefreshToken: () => useAuthStore.getState().tokens?.refreshToken ?? null,
  setAccessToken: (accessToken, expiresIn) =>
    useAuthStore.getState().setAccessToken(accessToken, expiresIn),
  clearSession: () => useAuthStore.getState().clearSession(),
});
