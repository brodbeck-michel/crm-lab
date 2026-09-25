import type {
  CreateProposalRequest,
  CreateProposalResponse,
  ListProposalsQuery,
  ListProposalsResponse,
  ProposalDetail,
  RejectProposalRequest,
  UpdateProposalDiscountRequest,
  UpdateProposalItemsRequest,
  UpdateProposalItemsResponse,
  UpdateProposalLisReferenceRequest,
  UpdateProposalStatusRequest,
} from '@crm-lab/shared';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from './client';
import { queryKeys, queryScopes } from './query-keys';
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

  /** CRMLAB-12/D-132 — substitui itens inteiros; desconto/médico opcionais. */
  updateItems: (id: string, body: UpdateProposalItemsRequest) =>
    http.patch<UpdateProposalItemsResponse>(`/proposals/${id}/items`, body),

  /** CRMLAB-52/D-119 — dona ou gestor+. Concilia na hora; devolve o detalhe inteiro. */
  updateLisReference: (id: string, body: UpdateProposalLisReferenceRequest) =>
    http.patch<ProposalDetail>(`/proposals/${id}/lis-reference`, body),

  /** gestor/admin — alçada validada no servidor. */
  approve: (id: string) => http.patch<ApproveProposalResponse>(`/proposals/${id}/approve`),

  reject: (id: string, body: RejectProposalRequest) =>
    http.patch<ApproveProposalResponse>(`/proposals/${id}/reject`, body),
};

/* ── React Query Hooks ──────────────────────────────────────────────────── */

/**
 * Devolve a resposta INTEIRA (`proposals` + `pagination`).
 *
 * Antes devolvia só `res.proposals` e jogava fora o `pagination` — com isso a
 * tela não tinha como saber que existia página 2, e toda proposta fora das
 * primeiras 20 ficava inalcançável pela UI (D7 da Onda 5).
 */
export function useProposalList(filters: ListProposalsQuery = {}) {
  return useQuery({
    queryKey: queryKeys.proposals(filters),
    queryFn: async () => {
      return await proposalsApi.list(filters);
    },
  });
}

export function useProposalDetail(proposalId: string) {
  return useQuery({
    queryKey: queryKeys.proposal(proposalId),
    queryFn: async () => {
      return await proposalsApi.get(proposalId);
    },
  });
}

export function useCreateProposal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateProposalRequest) => {
      return await proposalsApi.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.proposals() });
    },
  });
}

export function useUpdateProposalStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: { proposalId: string } & UpdateProposalStatusRequest) => {
      const { proposalId, ...body } = data;
      return await proposalsApi.updateStatus(proposalId, body);
    },
    onSuccess: (_, { proposalId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.proposal(proposalId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.proposals() });
    },
  });
}

export function useUpdateProposalDiscount() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: { proposalId: string } & UpdateProposalDiscountRequest) => {
      const { proposalId, ...body } = data;
      return await proposalsApi.updateDiscount(proposalId, body);
    },
    onSuccess: (_, { proposalId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.proposal(proposalId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.proposals() });
    },
  });
}

export function useUpdateProposalItems() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: { proposalId: string } & UpdateProposalItemsRequest) => {
      const { proposalId, ...body } = data;
      return await proposalsApi.updateItems(proposalId, body);
    },
    onSuccess: (_, { proposalId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.proposal(proposalId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.proposals() });
    },
  });
}

export function useApproveProposal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (proposalId: string) => {
      return await proposalsApi.approve(proposalId);
    },
    onSuccess: (_, proposalId) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.proposal(proposalId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.proposals() });
    },
  });
}

export function useRejectProposal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: { proposalId: string; reason: string }) => {
      const { proposalId, reason } = data;
      return await proposalsApi.reject(proposalId, { reason });
    },
    onSuccess: (_, { proposalId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.proposal(proposalId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.proposals() });
    },
  });
}

export function useUpdateProposalLisReference() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: { proposalId: string } & UpdateProposalLisReferenceRequest) => {
      const { proposalId, ...body } = data;
      return await proposalsApi.updateLisReference(proposalId, body);
    },
    onSuccess: (detail, { proposalId }) => {
      queryClient.setQueryData(queryKeys.proposal(proposalId), detail);
      queryClient.invalidateQueries({ queryKey: queryKeys.proposals() });
      // A conciliação pode ter levado a proposta a `ganho`: funil e receita mudam.
      queryClient.invalidateQueries({ queryKey: queryScopes.analytics });
    },
  });
}
