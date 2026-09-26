import {
  DEFAULT_FUNNEL_RULES,
  type FunnelRules,
  type UpdateFunnelRulesRequest,
} from '@crm-lab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from './client';
import { queryKeys } from './query-keys';

/**
 * `/settings/funnel-rules` (docs/api/API_CONTRACTS.md §6c, CRMLAB-56) — regras
 * do funil do laboratório. `GET` todo perfil de laboratório, `PATCH`
 * manager/admin. Recurso único, cru (D-070).
 */
export const funnelRulesApi = {
  get: () => http.get<FunnelRules>('/settings/funnel-rules'),

  update: (body: UpdateFunnelRulesRequest) =>
    http.patch<FunnelRules>('/settings/funnel-rules', body),
};

export function useFunnelRules() {
  return useQuery({
    queryKey: queryKeys.funnelRules(),
    queryFn: () => funnelRulesApi.get(),
    staleTime: 60_000,
  });
}

export function useUpdateFunnelRules() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: UpdateFunnelRulesRequest) => funnelRulesApi.update(body),
    onSuccess: (data) => queryClient.setQueryData(queryKeys.funnelRules(), data),
  });
}

function isFunnelRules(value: unknown): value is FunnelRules {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<Record<keyof FunnelRules, unknown>>;
  return (
    typeof v.origin === 'object' &&
    v.origin !== null &&
    typeof v.manualMoves === 'object' &&
    v.manualMoves !== null
  );
}

/**
 * As regras para as telas que só as CONSULTAM (travas, botão de nova proposta).
 * Enquanto carrega — ou se falhar — valem os padrões, que são o comportamento
 * de antes do card (D-191). Quem decide continua sendo o backend.
 */
export function useEffectiveFunnelRules(): FunnelRules {
  const { data } = useFunnelRules();
  return isFunnelRules(data) ? data : DEFAULT_FUNNEL_RULES;
}
