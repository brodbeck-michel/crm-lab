import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthUser, LoginRequest, UserRole } from '@crm-lab/shared';
import { api } from '@/api';
import { refreshAccessToken } from '@/api/client';
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

/**
 * Bootstrap de página (CRMLAB-32): o access token não é persistido (só
 * `user`/`tenant`/`theme` vão para o localStorage), então toda carga de
 * página troca o cookie httpOnly `crm_refresh` por um access token novo via
 * `POST /auth/refresh` — o cookie viaja sozinho, same-origin.
 *
 * Devolve `false` enquanto a troca está em voo (e enquanto o `persist` do
 * Zustand ainda não reidratou o `localStorage`), para o App NÃO renderizar o
 * router — e portanto os guards de rota — antes disso: sem esta espera,
 * `RequireAuth` leria `tokens: null` e mandaria uma sessão válida para
 * `/login` no primeiro render. 401 (sem cookie ou cookie expirado) também
 * conta como "terminou": os guards tratam a ausência de sessão normalmente.
 */
export function useSessionBootstrap(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    const finish = (): void => {
      if (alive) setReady(true);
    };
    const bootstrap = (): void => {
      refreshAccessToken()
        .catch(() => undefined)
        .finally(finish);
    };

    if (useAuthStore.persist.hasHydrated()) {
      bootstrap();
      return undefined;
    }
    const unsubscribe = useAuthStore.persist.onFinishHydration(() => {
      unsubscribe();
      bootstrap();
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  return ready;
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
