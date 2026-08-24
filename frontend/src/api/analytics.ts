import type { AnalyticsQuery, FunnelReport, PipelineSnapshot } from '@crm-lab/shared';
import { http } from './client';
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
