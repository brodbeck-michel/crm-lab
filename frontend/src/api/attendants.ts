import type {
  Attendant,
  CreateAttendantRequest,
  ListAttendantsQuery,
  ListAttendantsResponse,
  UpdateAttendantRequest,
} from '@crm-lab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryParams } from './client';
import { http } from './client';
import { queryKeys, queryScopes } from './query-keys';

/**
 * `/attendants` (docs/api/API_CONTRACTS.md §12) — cadastro do atendente do
 * LIS, ligável opcionalmente a um login do CRM (D-112). Manager/admin apenas;
 * sem `DELETE` (D-004) — desativação é `PATCH { isActive: false }`.
 */
export const attendantsApi = {
  list: (query: ListAttendantsQuery = {}) =>
    http.get<ListAttendantsResponse>('/attendants', query as QueryParams),

  create: (body: CreateAttendantRequest) => http.post<Attendant>('/attendants', body),

  update: (id: string, body: UpdateAttendantRequest) =>
    http.patch<Attendant>(`/attendants/${id}`, body),
};

/* ── React Query Hooks ──────────────────────────────────────────────────── */

export function useAttendantList(query: ListAttendantsQuery = {}) {
  return useQuery({
    queryKey: queryKeys.attendants(query),
    queryFn: () => attendantsApi.list(query),
  });
}

export function useCreateAttendant() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: CreateAttendantRequest) => attendantsApi.create(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryScopes.attendants }),
  });
}

export function useUpdateAttendant() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, dto }: { id: string; dto: UpdateAttendantRequest }) =>
      attendantsApi.update(id, dto),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryScopes.attendants }),
  });
}
