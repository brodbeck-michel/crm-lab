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

/**
 * CRMLAB-32 — SÓ o access token. O refresh token não passa mais pelo
 * frontend: vive exclusivamente no cookie httpOnly `crm_refresh`, gravado
 * pelo backend e ilegível por JavaScript.
 */
export interface SessionTokens {
  accessToken: string;
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
            expiresAt: Date.now() + response.expiresIn * 1000,
          },
        });
        applyTheme(response.tenant.theme);
      },

      /**
       * Troca (ou cria) só o access token. Também é o caminho do BOOTSTRAP de
       * página (`useSessionBootstrap`): como `tokens` não é persistido, toda
       * carga de página chega aqui com `tokens: null` até o
       * `POST /auth/refresh` (cookie) responder.
       *
       * A guarda é por `user`, não por `tokens` (revisão do PR #44): `user`
       * É persistido, então o bootstrap legítimo (identidade restaurada do
       * localStorage, tokens ainda nulos) passa; um refresh que resolve
       * DEPOIS do `clearSession()` do logout encontra `user: null` e não
       * ressuscita a sessão — antes ele repopulava `tokens` num cliente já
       * deslogado, e o cookie rotacionado por esse mesmo refresh continuava
       * válido no navegador.
       */
      setAccessToken: (accessToken, expiresIn) => {
        if (get().user === null) return;
        set({ tokens: { accessToken, expiresAt: Date.now() + expiresIn * 1000 } });
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
      // Persistimos identidade/preferência (user/tenant/theme). `tokens` FICA
      // DE FORA de propósito (CRMLAB-32): access token só em memória, nunca
      // em localStorage — `useSessionBootstrap` (App.tsx) troca o cookie
      // httpOnly por um access token novo a cada carga de página.
      partialize: (state) => ({
        user: state.user,
        tenant: state.tenant,
        theme: state.theme,
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
  setAccessToken: (accessToken, expiresIn) =>
    useAuthStore.getState().setAccessToken(accessToken, expiresIn),
  clearSession: () => useAuthStore.getState().clearSession(),
});
