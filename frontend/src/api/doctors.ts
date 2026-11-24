import type {
  CreateDoctorInteractionRequest,
  CreateDoctorTimelineCommentRequest,
  DoctorTimelineComment,
  UpdateDoctorTimelineCommentRequest,
  CreateDoctorRequest,
  CreateDoctorSpecialtyRequest,
  Doctor,
  DoctorRevenue,
  DoctorAbcRecalculation,
  DoctorInteraction,
  DoctorSpecialty,
  DoctorTimelineQuery,
  DoctorTimelineResponse,
  ListDoctorSpecialtiesQuery,
  ListDoctorSpecialtiesResponse,
  UpdateDoctorInteractionRequest,
  UpdateDoctorSpecialtyRequest,
  DoctorLookupQuery,
  DoctorLookupResponse,
  ListDoctorPortfoliosResponse,
  ListDoctorsQuery,
  ListDoctorsResponse,
  TransferDoctorsRequest,
  TransferDoctorsResponse,
  UpdateDoctorRequest,
} from '@crm-lab/shared';
import { http } from './client';
import type { QueryParams } from './client';

/**
 * `/doctors` — médicos solicitantes (docs/api/API_CONTRACTS.md §13, CRMLAB-86,
 * D-255). Desde D-329: representante (só a carteira dele — o servidor recorta),
 * gestor e admin; a atendente recebe 403. Carteiras e transferência: gestor/admin.
 * A lista de especialidades e o recálculo da curva ABC escrevem só gestor/admin
 * (CRMLAB-188, D-328).
 */
export const doctorsApi = {
  list: (query: ListDoctorsQuery = {}) => http.get<ListDoctorsResponse>('/doctors', query as QueryParams),

  get: (id: string) => http.get<Doctor>(`/doctors/${id}`),

  // Faturamento no LIS, 12 meses (CRMLAB-198, D-336).
  revenue: (id: string) => http.get<DoctorRevenue>(`/doctors/${id}/revenue`),

  create: (body: CreateDoctorRequest) => http.post<Doctor>('/doctors', body),

  update: (id: string, body: UpdateDoctorRequest) => http.patch<Doctor>(`/doctors/${id}`, body),

  inactivate: (id: string) => http.post<Doctor>(`/doctors/${id}/inactivate`),

  reactivate: (id: string) => http.post<Doctor>(`/doctors/${id}/reactivate`),

  // Carteiras e transferência em lote (CRMLAB-189, D-329 — gestor/admin).
  portfolios: () => http.get<ListDoctorPortfoliosResponse>('/doctors/portfolios'),
  // Busca do formulário de proposta: todo papel, sem carteira (D-329 item 12).
  lookup: (query: DoctorLookupQuery) => http.get<DoctorLookupResponse>('/doctors/lookup', { search: query.search, limit: query.limit }),

  transfer: (body: TransferDoctorsRequest) => http.post<TransferDoctorsResponse>('/doctors/transfer', body),

  // Linha do tempo do médico (CRMLAB-89, D-261).
  // `types` vai separado por vírgula (`?types=visita,ligacao`, CRMLAB-192/D-332).
  timeline: (id: string, query: DoctorTimelineQuery = {}) => {
    const { types, ...rest } = query;
    const params: QueryParams = { ...rest };
    if (types && types.length > 0) params.types = types.join(',');
    return http.get<DoctorTimelineResponse>(`/doctors/${id}/timeline`, params);
  },

  // Comentários do feed (CRMLAB-192, D-332).
  createComment: (id: string, body: CreateDoctorTimelineCommentRequest) =>
    http.post<DoctorTimelineComment>(`/doctors/${id}/comments`, body),

  updateComment: (id: string, commentId: string, body: UpdateDoctorTimelineCommentRequest) =>
    http.patch<DoctorTimelineComment>(`/doctors/${id}/comments/${commentId}`, body),

  deleteComment: (id: string, commentId: string) => http.delete<void>(`/doctors/${id}/comments/${commentId}`),

  createInteraction: (id: string, body: CreateDoctorInteractionRequest) =>
    http.post<DoctorInteraction>(`/doctors/${id}/interactions`, body),

  updateInteraction: (id: string, interactionId: string, body: UpdateDoctorInteractionRequest) =>
    http.patch<DoctorInteraction>(`/doctors/${id}/interactions/${interactionId}`, body),

  deleteInteraction: (id: string, interactionId: string) =>
    http.delete<void>(`/doctors/${id}/interactions/${interactionId}`),

  // Especialidades e curva ABC (CRMLAB-188, D-328).
  specialties: (query: ListDoctorSpecialtiesQuery = {}) =>
    http.get<ListDoctorSpecialtiesResponse>('/doctors/specialties', query as QueryParams),

  createSpecialty: (body: CreateDoctorSpecialtyRequest) => http.post<DoctorSpecialty>('/doctors/specialties', body),

  updateSpecialty: (id: string, body: UpdateDoctorSpecialtyRequest) =>
    http.patch<DoctorSpecialty>(`/doctors/specialties/${id}`, body),

  recalculateAbc: () => http.post<DoctorAbcRecalculation>('/doctors/abc/recalculate'),
};
