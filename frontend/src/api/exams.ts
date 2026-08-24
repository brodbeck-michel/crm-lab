import type {
  CreateExamRequest,
  Exam,
  ListExamsQuery,
  ListExamsResponse,
  UpdateExamRequest,
} from '@crm-lab/shared';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from './client';
import { queryKeys } from './query-keys';
import type { QueryParams } from './client';

/** docs/api/API_CONTRACTS.md §4 — Exam Catalog. Escrita só para gestor/admin. */
export const examsApi = {
  list: (query: ListExamsQuery = {}) => http.get<ListExamsResponse>('/exams', query as QueryParams),

  create: (body: CreateExamRequest) => http.post<Exam>('/exams', body),

  update: (id: string, body: UpdateExamRequest) => http.patch<Exam>(`/exams/${id}`, body),
};

/* ── React Query Hooks ──────────────────────────────────────────────────── */

export function useExamList(filters: ListExamsQuery = {}) {
  return useQuery({
    queryKey: queryKeys.exams(filters),
    queryFn: async () => {
      const res = await examsApi.list(filters);
      return res.exams;
    },
  });
}

export function useCreateExam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateExamRequest) => {
      return await examsApi.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.exams() });
    },
  });
}

export function useUpdateExam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateExamRequest }) => {
      return await examsApi.update(id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.exams() });
    },
  });
}
