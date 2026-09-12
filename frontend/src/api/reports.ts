import type { ExecutiveReport } from '@crm-lab/shared';
import { useQuery } from '@tanstack/react-query';
import type { QueryParams } from './client';
import { http } from './client';
import { queryKeys, staleTimes } from './query-keys';

/** `GET /reports/executive` só aceita período — sem atendente/convênio (§5c). */
export interface ExecutiveReportQuery {
  startDate?: string;
  endDate?: string;
}

/**
 * `GET /reports/executive` (docs/api/API_CONTRACTS.md §5c) — fonte de dados
 * de `/results` e do PDF Executivo (D-116). O backend nunca gera PDF, só
 * este JSON — a tela e o PDF derivam do MESMO fetch, nunca de dois.
 */
export const reportsApi = {
  executive: (query: ExecutiveReportQuery = {}) =>
    http.get<ExecutiveReport>('/reports/executive', query as QueryParams),
};

export function useExecutiveReport(query: ExecutiveReportQuery = {}, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.reportsExecutive(query),
    queryFn: () => reportsApi.executive(query),
    staleTime: staleTimes.lis,
    enabled: options.enabled ?? true,
  });
}
