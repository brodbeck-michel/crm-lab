import type {
  CloseVisitRequest,
  CreateVisitAttachmentRequest,
  CreateVisitRequest,
  ListVisitsQuery,
  ListVisitsResponse,
  RescheduleVisitRequest,
  UpdateVisitReportRequest,
  UpdateVisitRequest,
  VisitAttachment,
  VisitDetail,
} from '@crm-lab/shared';
import { apiBaseUrl, fetchAuthenticatedBlob, http, resolveMediaUrl } from './client';
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

  // Registro da visita (CRMLAB-88, D-258).
  checkIn: (id: string) => http.post<VisitDetail>(`/visits/${id}/check-in`, {}),

  checkOut: (id: string) => http.post<VisitDetail>(`/visits/${id}/check-out`, {}),

  updateReport: (id: string, body: UpdateVisitReportRequest) =>
    http.patch<VisitDetail>(`/visits/${id}/report`, body),

  addAttachment: (id: string, body: CreateVisitAttachmentRequest) =>
    http.post<VisitAttachment>(`/visits/${id}/attachments`, body),

  deleteAttachment: (id: string, attachmentId: string) =>
    http.delete<void>(`/visits/${id}/attachments/${attachmentId}`),

  /** Bytes do anexo com o token (a rota exige `Authorization`). */
  downloadAttachment: (id: string, attachmentId: string) =>
    fetchAuthenticatedBlob(resolveMediaUrl(`${apiBaseUrl()}/visits/${id}/attachments/${attachmentId}`)),
};
