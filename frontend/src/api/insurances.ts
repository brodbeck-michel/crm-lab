import type {
  CreateInsuranceRequest,
  Insurance,
  ListInsurancesQuery,
  ListInsurancesResponse,
  UpdateInsuranceRequest,
} from '@crm-lab/shared';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from './client';
import { queryKeys, queryScopes } from './query-keys';
import type { QueryParams } from './client';

/**
 * `/insurances` — tela `/settings/insurances` (docs/api/API_CONTRACTS.md §8, D-081/D-082).
 * `GET` é para todos os papéis do tenant (alimenta o seletor de convênio de
 * `/budget/new`); `POST`/`PATCH` são manager/admin — o servidor recusa, a UI
 * só esconde o controle.
 */
export const insurancesApi = {
  list: (query: ListInsurancesQuery = {}) =>
    http.get<ListInsurancesResponse>('/insurances', query as QueryParams),

  create: (body: CreateInsuranceRequest) => http.post<Insurance>('/insurances', body),

  update: (id: string, body: UpdateInsuranceRequest) =>
    http.patch<Insurance>(`/insurances/${id}`, body),
};

/* ── React Query Hooks ──────────────────────────────────────────────────── */

export function useInsuranceList(params: ListInsurancesQuery = {}) {
  return useQuery({
    queryKey: queryKeys.insurances(params),
    queryFn: async () => {
      return await insurancesApi.list(params);
    },
  });
}

export function useCreateInsurance() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateInsuranceRequest) => {
      return await insurancesApi.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryScopes.insurances });
    },
  });
}

export function useUpdateInsurance() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, dto }: { id: string; dto: UpdateInsuranceRequest }) => {
      return await insurancesApi.update(id, dto);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryScopes.insurances });
    },
  });
}
