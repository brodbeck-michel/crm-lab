import type {
  LisIntegrationSettings,
  LisSyncRunResult,
  UpdateLisIntegrationRequest,
} from '@crm-lab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from './client';
import { queryKeys, queryScopes } from './query-keys';

/**
 * `/settings/lis-integration` (docs/api/API_CONTRACTS.md §10.3, CRMLAB-52) —
 * sincronização dos orçamentos pela API do Bitlab. `GET` e `/sync`
 * manager/admin, `PATCH` admin. A chave nunca volta: só `apiKeyMasked`.
 */
export const lisIntegrationApi = {
  get: () => http.get<LisIntegrationSettings>('/settings/lis-integration'),

  update: (body: UpdateLisIntegrationRequest) =>
    http.patch<LisIntegrationSettings>('/settings/lis-integration', body),

  sync: () => http.post<LisSyncRunResult>('/settings/lis-integration/sync', {}),
};

export function useLisIntegration() {
  return useQuery({
    queryKey: queryKeys.lisIntegration(),
    queryFn: () => lisIntegrationApi.get(),
  });
}

export function useUpdateLisIntegration() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: UpdateLisIntegrationRequest) => lisIntegrationApi.update(body),
    onSuccess: (data) => queryClient.setQueryData(queryKeys.lisIntegration(), data),
  });
}

export function useRunLisSync() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => lisIntegrationApi.sync(),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.lisIntegration(), result.settings);
      // Orçamentos novos mudam Resultados/Conferência/Busca Ativa e o histórico
      // — o mesmo escopo que a importação de planilha invalida (`lis.ts`).
      if (result.received > 0) {
        void queryClient.invalidateQueries({ queryKey: queryScopes.lisBudgets });
        void queryClient.invalidateQueries({ queryKey: queryScopes.lisImports });
        void queryClient.invalidateQueries({ queryKey: queryScopes.reportsExecutive });
      }
    },
  });
}
