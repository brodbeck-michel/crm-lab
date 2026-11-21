import type {
  CreateDoctorInteractionRequest,
  CreateDoctorRequest,
  CreateDoctorSpecialtyRequest,
  Doctor,
  DoctorAbcRecalculation,
  DoctorInteraction,
  DoctorSpecialty,
  DoctorTimelineQuery,
  DoctorTimelineResponse,
  ListDoctorSpecialtiesQuery,
  ListDoctorSpecialtiesResponse,
  UpdateDoctorInteractionRequest,
  UpdateDoctorSpecialtyRequest,
  ListDoctorsQuery,
  ListDoctorsResponse,
  UpdateDoctorRequest,
} from '@crm-lab/shared';
import { http } from './client';
import type { QueryParams } from './client';

/**
 * `/doctors` — médicos solicitantes (docs/api/API_CONTRACTS.md §13, CRMLAB-86,
 * D-255). O cadastro do médico vale para qualquer papel do laboratório; a
 * lista de especialidades e o recálculo da curva ABC escrevem só gestor/admin
 * (CRMLAB-188, D-328).
 */
export const doctorsApi = {
  list: (query: ListDoctorsQuery = {}) => http.get<ListDoctorsResponse>('/doctors', query as QueryParams),

  get: (id: string) => http.get<Doctor>(`/doctors/${id}`),

  create: (body: CreateDoctorRequest) => http.post<Doctor>('/doctors', body),

  update: (id: string, body: UpdateDoctorRequest) => http.patch<Doctor>(`/doctors/${id}`, body),

  inactivate: (id: string) => http.post<Doctor>(`/doctors/${id}/inactivate`),

  reactivate: (id: string) => http.post<Doctor>(`/doctors/${id}/reactivate`),

  // Linha do tempo do médico (CRMLAB-89, D-261).
  timeline: (id: string, query: DoctorTimelineQuery = {}) =>
    http.get<DoctorTimelineResponse>(`/doctors/${id}/timeline`, query as QueryParams),

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
