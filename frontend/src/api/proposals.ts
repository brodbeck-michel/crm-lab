import type {
  CreateProposalRequest,
  CreateProposalResponse,
  ListProposalsQuery,
  ListProposalsResponse,
  ProposalDetail,
  RejectProposalRequest,
  UpdateProposalDiscountRequest,
  UpdateProposalStatusRequest,
} from '@crm-lab/shared';
import { http } from './client';
import type { QueryParams } from './client';

/**
 * docs/api/API_CONTRACTS.md §3 — Proposals.
 *
 * Os PATCH devolvem uma resposta PARCIAL (o contrato mostra só os campos
 * afetados). Aqui isso é expresso com `Pick<ProposalDetail, ...>` — derivado
 * do tipo compartilhado, nunca um shape redeclarado localmente.
 *
 * O cliente NUNCA envia `totalPrice`: ele é derivado no backend (D-003).
 */
export type UpdateProposalStatusResponse = Pick<
  ProposalDetail,
  'id' | 'status' | 'reasonLost' | 'updatedAt'
>;

export type UpdateProposalDiscountResponse = Pick<
  ProposalDetail,
  'id' | 'discountPercent' | 'totalPrice'
>;

export type ApproveProposalResponse = Pick<
  ProposalDetail,
  'id' | 'approvalStatus' | 'approvedAt'
> & { message?: string };

export const proposalsApi = {
  list: (query: ListProposalsQuery = {}) =>
    http.get<ListProposalsResponse>('/proposals', query as QueryParams),

  get: (id: string) => http.get<ProposalDetail>(`/proposals/${id}`),

  create: (body: CreateProposalRequest) => http.post<CreateProposalResponse>('/proposals', body),

  /** `perdido` exige `reasonLost` — o backend recusa sem ele (LOSS_REASON_REQUIRED). */
  updateStatus: (id: string, body: UpdateProposalStatusRequest) =>
    http.patch<UpdateProposalStatusResponse>(`/proposals/${id}/status`, body),

  updateDiscount: (id: string, body: UpdateProposalDiscountRequest) =>
    http.patch<UpdateProposalDiscountResponse>(`/proposals/${id}/discount`, body),

  /** gestor/admin — alçada validada no servidor. */
  approve: (id: string) => http.patch<ApproveProposalResponse>(`/proposals/${id}/approve`),

  reject: (id: string, body: RejectProposalRequest) =>
    http.patch<ApproveProposalResponse>(`/proposals/${id}/reject`, body),
};
