import type {
  VisitationReport,
  VisitationReportQuery,
  VisitationReportStaleQuery,
  VisitationReportStaleResponse,
} from '@crm-lab/shared';
import { useQuery } from '@tanstack/react-query';
import type { QueryParams } from './client';
import { http } from './client';
import { queryKeys, staleTimes } from './query-keys';

/**
 * `/visitation-reports` — Relatório de Visitação (docs/api/API_CONTRACTS.md §14b,
 * CRMLAB-193, D-333). Representante (os dele), gestor e admin. O servidor recorta
 * o representante e ignora o `responsibleId` dele — aqui só não mandamos.
 */
export const visitationReportsApi = {
  summary: (query: VisitationReportQuery) =>
    http.get<VisitationReport>('/visitation-reports/summary', query as unknown as QueryParams),
  staleDoctors: (query: VisitationReportStaleQuery = {}) =>
    http.get<VisitationReportStaleResponse>('/visitation-reports/stale-doctors', query as QueryParams),
};

export function useVisitationReport(query: VisitationReportQuery, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.visitationReport(query),
    queryFn: () => visitationReportsApi.summary(query),
    staleTime: staleTimes.analytics,
    enabled: options.enabled ?? true,
  });
}

export function useVisitationStaleDoctors(query: VisitationReportStaleQuery, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.visitationStaleDoctors(query),
    queryFn: () => visitationReportsApi.staleDoctors(query),
    staleTime: staleTimes.analytics,
    enabled: options.enabled ?? true,
  });
}
