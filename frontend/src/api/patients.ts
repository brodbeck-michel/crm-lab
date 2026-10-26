import type {
  AnonymizePatientRequest,
  AnonymizePatientResponse,
  CreatePatientRequest,
  InactivatePatientRequest,
  ListPatientTimelineQuery,
  ListPatientTimelineResponse,
  ListPatientsQuery,
  ListPatientsResponse,
  PatientDetail,
  PatientExport,
  ReactivatePatientRequest,
  UpdatePatientRequest,
} from '@crm-lab/shared';
import { http } from './client';
import type { QueryParams } from './client';

/**
 * `/patients` — ficha do paciente (docs/api/API_CONTRACTS.md §2c, PAGES.md §3).
 *
 * A ficha são TRÊS chamadas, não uma (D-060): cadastro+contadores aqui,
 * timeline em rota própria paginada, e as propostas do paciente em
 * `GET /proposals?patientId=` (`proposalsApi.list`) — não existe
 * `GET /patients/:id/proposals`.
 *
 * `create` (CRMLAB-121, D-287) cadastra o contato antes da primeira
 * mensagem; telefone já cadastrado volta `409 CONFLICT`
 * (`details.reason: "phone_already_in_use"`, com `patientId` quando visível).
 * Não existe `remove`: o apagamento LGPD é `anonymize` (D-063).
 *
 * `update` é PATCH parcial: campo ausente PRESERVA, `null` APAGA.
 */
export const patientsApi = {
  list: (query: ListPatientsQuery = {}) =>
    http.get<ListPatientsResponse>('/patients', query as QueryParams),

  create: (body: CreatePatientRequest) => http.post<PatientDetail>('/patients', body),

  get: (id: string) => http.get<PatientDetail>(`/patients/${id}`),

  update: (id: string, body: UpdatePatientRequest) =>
    http.patch<PatientDetail>(`/patients/${id}`, body),

  timeline: (id: string, query: ListPatientTimelineQuery = {}) =>
    http.get<ListPatientTimelineResponse>(`/patients/${id}/timeline`, query as QueryParams),

  /** LGPD, admin apenas (D-062). Gera audit log `export_patient_data` no servidor. */
  export: (id: string) => http.get<PatientExport>(`/patients/${id}/export`),

  /** LGPD, admin apenas (D-063). Irreversível e idempotente; `reason` obrigatório. */
  anonymize: (id: string, body: AnonymizePatientRequest) =>
    http.post<AnonymizePatientResponse>(`/patients/${id}/anonymize`, body),

  /** Qualquer papel de laboratório (D-132). `reason` obrigatório. Idempotente. */
  inactivate: (id: string, body: InactivatePatientRequest) =>
    http.post<PatientDetail>(`/patients/${id}/inactivate`, body),

  /** Qualquer papel de laboratório (D-132). `reason` obrigatório. Idempotente. */
  reactivate: (id: string, body: ReactivatePatientRequest) =>
    http.post<PatientDetail>(`/patients/${id}/reactivate`, body),
};
