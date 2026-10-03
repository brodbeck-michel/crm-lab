import type {
  CloseVisitRequest,
  CreateVisitRequest,
  ListVisitsQuery,
  ListVisitsResponse,
  RescheduleVisitRequest,
  UpdateVisitRequest,
  VisitDetail,
} from '@crm-lab/shared';
import { http } from './client';
import type { QueryParams } from './client';

/**
 * `/visits` — agenda de visitas a médicos (docs/api/API_CONTRACTS.md §14,
 * CRMLAB-87, D-256). Todas as rotas valem para qualquer papel do laboratório.
 */
export const visitsApi = {
  list: (query: ListVisitsQuery) => {
    const params: QueryParams = { ...query };
    return http.get<ListVisitsResponse>('/visits', params);
  },

  get: (id: string) => http.get<VisitDetail>(`/visits/${id}`),

  create: (body: CreateVisitRequest) => http.post<VisitDetail>('/visits', body),

  update: (id: string, body: UpdateVisitRequest) => http.patch<VisitDetail>(`/visits/${id}`, body),

  reschedule: (id: string, body: RescheduleVisitRequest) =>
    http.post<VisitDetail>(`/visits/${id}/reschedule`, body),

  cancel: (id: string, body: CloseVisitRequest) => http.post<VisitDetail>(`/visits/${id}/cancel`, body),

  notReceived: (id: string, body: CloseVisitRequest) =>
    http.post<VisitDetail>(`/visits/${id}/not-received`, body),
};
