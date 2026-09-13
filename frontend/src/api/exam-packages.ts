import type {
  CreateExamPackageRequest,
  ExamPackage,
  ListExamPackagePricesResponse,
  ListExamPackagesQuery,
  ListExamPackagesResponse,
  UpdateExamPackagePricesRequest,
  UpdateExamPackageRequest,
} from '@crm-lab/shared';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from './client';
import { queryKeys } from './query-keys';
import type { QueryParams } from './client';

/**
 * docs/api/API_CONTRACTS.md §4b — Pacotes de exames (CRMLAB-10). Escrita só
 * para gestor/admin, mesma alçada de `examsApi`.
 */
export const examPackagesApi = {
  list: (query: ListExamPackagesQuery = {}) =>
    http.get<ListExamPackagesResponse>('/exam-packages', query as QueryParams),

  create: (body: CreateExamPackageRequest) => http.post<ExamPackage>('/exam-packages', body),

  update: (id: string, body: UpdateExamPackageRequest) =>
    http.patch<ExamPackage>(`/exam-packages/${id}`, body),

  prices: (id: string) => http.get<ListExamPackagePricesResponse>(`/exam-packages/${id}/prices`),

  updatePrices: (id: string, body: UpdateExamPackagePricesRequest) =>
    http.put<ListExamPackagePricesResponse>(`/exam-packages/${id}/prices`, body),
};

/* ── React Query Hooks ──────────────────────────────────────────────────── */

export function useExamPackageList(filters: ListExamPackagesQuery = {}) {
  return useQuery({
    queryKey: queryKeys.examPackages(filters),
    queryFn: async () => {
      return await examPackagesApi.list(filters);
    },
  });
}

export function useCreateExamPackage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateExamPackageRequest) => {
      return await examPackagesApi.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.examPackages() });
    },
  });
}

export function useUpdateExamPackage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateExamPackageRequest }) => {
      return await examPackagesApi.update(id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.examPackages() });
    },
  });
}

/** Preço do pacote por convênio — aba "Preços por convênio" de `PackageModal`. */
export function useExamPackagePrices(packageId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.examPackagePrices(packageId ?? ''),
    queryFn: async () => {
      return await examPackagesApi.prices(packageId as string);
    },
    enabled: !!packageId,
  });
}

export function useUpdateExamPackagePrices() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateExamPackagePricesRequest }) => {
      return await examPackagesApi.updatePrices(id, data);
    },
    onSuccess: (result, { id }) => {
      queryClient.setQueryData(queryKeys.examPackagePrices(id), result);
      queryClient.invalidateQueries({ queryKey: queryKeys.examPackages() });
    },
  });
}
