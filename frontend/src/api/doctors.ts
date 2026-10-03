import type {
  CreateDoctorRequest,
  Doctor,
  ListDoctorsQuery,
  ListDoctorsResponse,
  UpdateDoctorRequest,
} from '@crm-lab/shared';
import { http } from './client';
import type { QueryParams } from './client';

/**
 * `/doctors` — médicos solicitantes (docs/api/API_CONTRACTS.md §13, CRMLAB-86,
 * D-255). Todas as rotas valem para qualquer papel do laboratório: não há
 * controle de escrita a esconder por perfil.
 */
export const doctorsApi = {
  list: (query: ListDoctorsQuery = {}) => http.get<ListDoctorsResponse>('/doctors', query as QueryParams),

  get: (id: string) => http.get<Doctor>(`/doctors/${id}`),

  create: (body: CreateDoctorRequest) => http.post<Doctor>('/doctors', body),

  update: (id: string, body: UpdateDoctorRequest) => http.patch<Doctor>(`/doctors/${id}`, body),

  inactivate: (id: string) => http.post<Doctor>(`/doctors/${id}/inactivate`),

  reactivate: (id: string) => http.post<Doctor>(`/doctors/${id}/reactivate`),
};
