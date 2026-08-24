import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthUser, LoginRequest, UserRole } from '@crm-lab/shared';
import { api } from '@/api';
import { useAuthStore, selectIsAuthenticated, selectRole, selectUser } from '@/stores';
import { homeFor } from '@/routes/route-config';

/**
 * Sessão — leitura e transições. NENHUM dado de servidor passa por aqui:
 * `user`/`tenant`/`theme` são o payload do login (identidade da sessão).
 */

export const useCurrentUser = (): AuthUser | null => useAuthStore(selectUser);
export const useCurrentRole = (): UserRole | null => useAuthStore(selectRole);
export const useIsAuthenticated = (): boolean => useAuthStore(selectIsAuthenticated);

/**
 * Login: guarda a sessão e aplica o tema que veio no MESMO payload
 * (sem request extra de tema — FRONTEND_BACKEND.md).
 * Devolve o destino do redirect por perfil.
 */
export function useLogin() {
  const setSession = useAuthStore((state) => state.setSession);

  return useCallback(
    async (credentials: LoginRequest): Promise<string> => {
      const response = await api.auth.login(credentials);
      setSession(response); // aplica o tema aqui dentro
      return homeFor(response.user.role);
    },
    [setSession],
  );
}

/** Logout: avisa o servidor (best-effort), limpa sessão e zera o cache. */
export function useLogout() {
  const clearSession = useAuthStore((state) => state.clearSession);
  const queryClient = useQueryClient();

  return useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      // Sessão local sai de qualquer jeito — servidor indisponível não prende ninguém.
    }
    clearSession();
    queryClient.clear();
  }, [clearSession, queryClient]);
}
