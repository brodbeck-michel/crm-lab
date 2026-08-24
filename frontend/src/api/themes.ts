import type { Theme, ThemePreset, UpdateThemeRequest } from '@crm-lab/shared';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from './client';
import { queryKeys } from './query-keys';
import { useAuthStore } from '@/stores/auth.store';

/**
 * `GET /themes/current` · `PATCH /themes/current`
 * (docs/domain/WORKFLOWS.md §9 — Fluxo de Personalização).
 *
 * ATENÇÃO: o bootstrap NÃO usa `current()`. O tema chega dentro do
 * `LoginResponse.tenant.theme` e é aplicado por `applyTheme()`
 * (docs/contracts/FRONTEND_BACKEND.md: "O tema vem no login — o frontend NÃO
 * faz request extra de tema no bootstrap"). `current()` existe para a tela de
 * Personalização recarregar o tema salvo.
 */
export const themesApi = {
  current: () => http.get<{ theme: Theme }>('/themes/current'),

  update: (body: UpdateThemeRequest) => http.patch<{ theme: Theme }>('/themes/current', body),

  presets: () => http.get<{ presets: ThemePreset[] }>('/themes/presets'),
};

/* ── React Query Hooks ──────────────────────────────────────────────────── */

export function useThemeCurrent() {
  return useQuery({
    queryKey: queryKeys.theme(),
    queryFn: async () => {
      const res = await themesApi.current();
      return res.theme;
    },
  });
}

export function useThemePresets() {
  return useQuery({
    queryKey: ['themePresets'] as const,
    queryFn: async () => {
      const res = await themesApi.presets();
      return res.presets;
    },
    staleTime: Infinity, // Presets nunca mudam
  });
}

/**
 * Salvar personalização (WORKFLOWS.md §9, passos 5-7).
 *
 * O servidor persiste; o cliente precisa fazer as DUAS coisas com o tema que
 * volta: aplicar nas CSS vars agora e trocar o tema da SESSÃO — senão o
 * `onRehydrateStorage` do `auth.store` reaplica no reload o tema do login e
 * desfaz a troca. `setTheme` faz as duas.
 */
export function useUpdateTheme() {
  const queryClient = useQueryClient();
  const setTheme = useAuthStore((state) => state.setTheme);

  return useMutation({
    mutationFn: async (data: UpdateThemeRequest) => {
      const res = await themesApi.update(data);
      return res.theme;
    },
    onSuccess: (theme) => {
      setTheme(theme);
      queryClient.invalidateQueries({ queryKey: queryKeys.theme() });
    },
  });
}
