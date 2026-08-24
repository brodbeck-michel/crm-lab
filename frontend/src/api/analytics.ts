import type { AnalyticsQuery, FunnelReport, PipelineSnapshot } from '@crm-lab/shared';
import { useQuery } from '@tanstack/react-query';
import { http } from './client';
import { queryKeys, staleTimes } from './query-keys';
import type { QueryParams } from './client';

/**
 * docs/api/API_CONTRACTS.md §5 — Analytics.
 * Atendente recebe `partial: true` (só as próprias métricas) — quem recorta é
 * o servidor; a tela apenas reflete a flag.
 */
export const analyticsApi = {
  conversion: (query: AnalyticsQuery = {}) =>
    http.get<FunnelReport>('/analytics/conversion', query as QueryParams),

  pipeline: () => http.get<PipelineSnapshot>('/analytics/pipeline'),
};

/* ── React Query Hooks ──────────────────────────────────────────────────── */

export function useAnalyticsConversion(filters: AnalyticsQuery = {}) {
  return useQuery({
    queryKey: queryKeys.analytics(filters),
    queryFn: async () => {
      return await analyticsApi.conversion(filters);
    },
    staleTime: staleTimes.analytics,
  });
}

export function useAnalyticsPipeline() {
  return useQuery({
    queryKey: queryKeys.analyticsPipeline(),
    queryFn: async () => {
      return await analyticsApi.pipeline();
    },
    staleTime: staleTimes.analytics,
  });
}
