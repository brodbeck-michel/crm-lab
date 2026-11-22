import type {
  CreateVisitPurposeRequest,
  ListVisitPurposesResponse,
  UpdateVisitPurposeRequest,
  VisitPurpose,
} from '@crm-lab/shared';
import { useQuery } from '@tanstack/react-query';
import { http } from './client';
import { queryKeys } from './query-keys';

/**
 * `/settings/visit-purposes` — finalidades da visita (docs/api/API_CONTRACTS.md
 * §14, CRMLAB-190, D-330). `GET` todo papel do laboratório; `POST`/`PATCH`
 * manager/admin.
 */
export const visitPurposesApi = {
  list: () => http.get<ListVisitPurposesResponse>('/settings/visit-purposes'),
  create: (body: CreateVisitPurposeRequest) =>
    http.post<VisitPurpose>('/settings/visit-purposes', body),
  update: (id: string, body: UpdateVisitPurposeRequest) =>
    http.patch<VisitPurpose>(`/settings/visit-purposes/${id}`, body),
};

/** Todas as finalidades (ativas e inativas), na ordem do cadastro. Mudam pouco: 5 min. */
export function useVisitPurposes() {
  return useQuery({
    queryKey: queryKeys.visitPurposes(),
    queryFn: () => visitPurposesApi.list(),
    staleTime: 5 * 60_000,
  });
}
