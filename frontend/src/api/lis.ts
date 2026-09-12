import type {
  ImportLisSpreadsheetRequest,
  LisBudgetsFilters,
  LisBudgetsSummary,
  LisBudgetsSummaryQuery,
  LisImport,
  ListLisBudgetsQuery,
  ListLisBudgetsResponse,
  ListLisImportsQuery,
  ListLisImportsResponse,
  ListPendingLisBudgetsQuery,
  ListPendingLisBudgetsResponse,
  PendingLisBudgetsSummary,
  PendingLisBudgetsSummaryQuery,
  PurgeLisBudgetsRequest,
} from '@crm-lab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryParams } from './client';
import { http } from './client';
import { queryKeys, queryScopes, staleTimes } from './query-keys';

/**
 * Domínio "Orçamentos do LIS" — importação de planilha e leitura dos
 * orçamentos resultantes (docs/api/API_CONTRACTS.md §10, Onda 9).
 * Não existe escrita direta em `lis_budgets`: a única forma de uma linha
 * nascer ou mudar é por importação (ou por purge, que apaga todas).
 */
export const lisImportsApi = {
  list: (query: ListLisImportsQuery = {}) =>
    http.get<ListLisImportsResponse>('/lis-imports', query as QueryParams),

  latest: () => http.get<LisImport | null>('/lis-imports/latest'),

  create: (body: ImportLisSpreadsheetRequest) => http.post<LisImport>('/lis-imports', body),

  purge: (body: PurgeLisBudgetsRequest) => http.post<LisImport>('/lis-imports/purge', body),
};

export const lisBudgetsApi = {
  list: (query: ListLisBudgetsQuery = {}) =>
    http.get<ListLisBudgetsResponse>('/lis-budgets', query as QueryParams),

  summary: (query: LisBudgetsSummaryQuery = {}) =>
    http.get<LisBudgetsSummary>('/lis-budgets/summary', query as QueryParams),

  pending: (query: ListPendingLisBudgetsQuery = {}) =>
    http.get<ListPendingLisBudgetsResponse>('/lis-budgets/pending', query as QueryParams),

  pendingSummary: (query: PendingLisBudgetsSummaryQuery = {}) =>
    http.get<PendingLisBudgetsSummary>('/lis-budgets/pending/summary', query as QueryParams),

  filters: () => http.get<LisBudgetsFilters>('/lis-budgets/filters'),
};

/* ── React Query Hooks ──────────────────────────────────────────────────── */

export function useLisBudgetList(
  query: ListLisBudgetsQuery = {},
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.lisBudgets(query),
    queryFn: () => lisBudgetsApi.list(query),
    staleTime: staleTimes.lis,
    enabled: options.enabled ?? true,
  });
}

export function useLisBudgetsSummary(
  query: LisBudgetsSummaryQuery = {},
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.lisBudgetsSummary(query),
    queryFn: () => lisBudgetsApi.summary(query),
    staleTime: staleTimes.lis,
    enabled: options.enabled ?? true,
  });
}

export function useLisBudgetsPending(
  query: ListPendingLisBudgetsQuery = {},
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.lisBudgetsPending(query),
    queryFn: () => lisBudgetsApi.pending(query),
    staleTime: staleTimes.lis,
    enabled: options.enabled ?? true,
  });
}

export function useLisBudgetsPendingSummary(query: PendingLisBudgetsSummaryQuery = {}) {
  return useQuery({
    queryKey: queryKeys.lisBudgetsPendingSummary(query),
    queryFn: () => lisBudgetsApi.pendingSummary(query),
    staleTime: staleTimes.lis,
  });
}

export function useLisBudgetsFilters() {
  return useQuery({
    queryKey: queryKeys.lisBudgetsFilters(),
    queryFn: () => lisBudgetsApi.filters(),
    staleTime: staleTimes.lis,
  });
}

export function useLisImportsLatest() {
  return useQuery({
    queryKey: queryKeys.lisImportsLatest(),
    queryFn: () => lisImportsApi.latest(),
    staleTime: staleTimes.lis,
  });
}

export function useLisImportList(query: ListLisImportsQuery = {}) {
  return useQuery({
    queryKey: queryKeys.lisImports(query),
    queryFn: () => lisImportsApi.list(query),
    staleTime: staleTimes.lis,
  });
}

/**
 * Invalida TODO o escopo LIS (`lis-budgets*`, `lis-imports*`,
 * `reports-executive`) — usada após import e após purge, os dois únicos
 * eventos que mudam `lis_budgets`. Três prefixos distintos, não um só
 * (`invalidateQueries` faz prefix-match).
 */
function invalidateLisScope(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: queryScopes.lisBudgets });
  queryClient.invalidateQueries({ queryKey: queryScopes.lisImports });
  queryClient.invalidateQueries({ queryKey: queryScopes.reportsExecutive });
}

export function useImportLisSpreadsheet() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: ImportLisSpreadsheetRequest) => lisImportsApi.create(body),
    onSuccess: () => invalidateLisScope(queryClient),
  });
}

export function usePurgeLisBudgets() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: PurgeLisBudgetsRequest) => lisImportsApi.purge(body),
    onSuccess: () => invalidateLisScope(queryClient),
  });
}
