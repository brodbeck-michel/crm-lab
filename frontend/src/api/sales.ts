import type {
  CreateSaleRequest,
  ListSalesQuery,
  ListSalesResponse,
  Sale,
  SalesSummary,
  SalesSummaryQuery,
} from '@crm-lab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryParams } from './client';
import { http } from './client';
import { queryKeys, queryScopes } from './query-keys';

/**
 * `/sales` (docs/api/API_CONTRACTS.md §11) — vendas avulsas de exame/check-up
 * e a comissão calculada sobre elas. Atendente vê e lança só as próprias
 * (recorte de `attendants.user_id`, D-112); manager/admin veem/lançam para
 * qualquer atendente do tenant. A UI não decide esse recorte — só evita pedir
 * um `attendantId` que o próprio atendente não escolhe.
 */
export const salesApi = {
  list: (query: ListSalesQuery = {}) => http.get<ListSalesResponse>('/sales', query as QueryParams),

  create: (body: CreateSaleRequest) => http.post<Sale>('/sales', body),

  remove: (id: string) => http.delete<void>(`/sales/${id}`),

  summary: (query: SalesSummaryQuery = {}) =>
    http.get<SalesSummary>('/sales/summary', query as QueryParams),
};

/* ── React Query Hooks ──────────────────────────────────────────────────── */

export function useSaleList(query: ListSalesQuery = {}) {
  return useQuery({
    queryKey: queryKeys.sales(query),
    queryFn: () => salesApi.list(query),
  });
}

export function useSalesSummary(query: SalesSummaryQuery = {}) {
  return useQuery({
    queryKey: queryKeys.salesSummary(query),
    queryFn: () => salesApi.summary(query),
  });
}

export function useCreateSale() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: CreateSaleRequest) => salesApi.create(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryScopes.sales }),
  });
}

export function useDeleteSale() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => salesApi.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryScopes.sales }),
  });
}
