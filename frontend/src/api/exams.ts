import type {
  CreateExamRequest,
  Exam,
  ListExamsQuery,
  ListExamsResponse,
  UpdateExamRequest,
} from '@crm-lab/shared';
import { http } from './client';
import type { QueryParams } from './client';

/** docs/api/API_CONTRACTS.md §4 — Exam Catalog. Escrita só para gestor/admin. */
export const examsApi = {
  list: (query: ListExamsQuery = {}) => http.get<ListExamsResponse>('/exams', query as QueryParams),

  create: (body: CreateExamRequest) => http.post<Exam>('/exams', body),

  update: (id: string, body: UpdateExamRequest) => http.patch<Exam>(`/exams/${id}`, body),
};
