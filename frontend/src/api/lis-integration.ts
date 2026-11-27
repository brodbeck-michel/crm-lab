import type {
  LisIntegrationSettings,
  LisSyncRunResult,
  UpdateLisIntegrationRequest,
} from '@crm-lab/shared';
import { useEffect, useRef } from 'react';
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

  /** Requisições (CRMLAB-200, D-338): responde 202 na hora e roda em segundo plano. */
  syncRequisitions: () =>
    http.post<LisIntegrationSettings>('/settings/lis-integration/requisitions/sync', {}),
};

/** Enquanto as requisições sincronizam, consulta a cada 5 s (PAGES §20). */
const REQUISITIONS_POLL_MS = 5000;

export function useLisIntegration() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.lisIntegration(),
    queryFn: () => lisIntegrationApi.get(),
    refetchInterval: (q) => (q.state.data?.requisitions.running ? REQUISITIONS_POLL_MS : false),
  });

  // Quando a rodada de requisições termina, o faturamento por médico (Resultados) e a ficha do
  // médico mudam (D-338): invalida os dois.
  const running = query.data?.requisitions.running ?? false;
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) {
      void queryClient.invalidateQueries({ queryKey: queryScopes.lisBudgets });
      void queryClient.invalidateQueries({ queryKey: ['doctors', 'revenue'] });
    }
    wasRunning.current = running;
  }, [running, queryClient]);

  return query;
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

export function useRunLisRequisitionsSync() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => lisIntegrationApi.syncRequisitions(),
    onSuccess: (settings) => queryClient.setQueryData(queryKeys.lisIntegration(), settings),
  });
}
