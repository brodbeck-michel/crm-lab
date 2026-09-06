import type {
  CreateQuickReplyRequest,
  ListQuickRepliesResponse,
  QuickReply,
  UpdateQuickReplyRequest,
} from '@crm-lab/shared';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from './client';
import { queryKeys, queryScopes } from './query-keys';

/**
 * `/quick-replies` — tela `/quick-replies` e o menu `/` do Composer
 * (docs/api/API_CONTRACTS.md §9, Onda 8 §3).
 *
 * Escrita aberta a QUALQUER papel de tenant: a atendente é quem mais usa
 * macro, e uma tela em que ela só lê seria uma tela que ela pede para a gestora
 * editar todo dia.
 */
export const quickRepliesApi = {
  list: () => http.get<ListQuickRepliesResponse>('/quick-replies'),

  create: (body: CreateQuickReplyRequest) => http.post<QuickReply>('/quick-replies', body),

  update: (id: string, body: UpdateQuickReplyRequest) =>
    http.patch<QuickReply>(`/quick-replies/${id}`, body),

  remove: (id: string) => http.delete<void>(`/quick-replies/${id}`),
};

/* ── React Query Hooks ──────────────────────────────────────────────────── */

/**
 * A lista inteira, sem filtro nem página — é ela que o Composer filtra em
 * memória enquanto a pessoa digita depois da `/`. Uma busca por request a cada
 * tecla seria uma ida ao servidor por caractere para escolher entre 20 textos.
 */
export function useQuickReplyList() {
  return useQuery({
    queryKey: queryKeys.quickReplies(),
    queryFn: async () => {
      return await quickRepliesApi.list();
    },
  });
}

export function useCreateQuickReply() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateQuickReplyRequest) => {
      return await quickRepliesApi.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryScopes.quickReplies });
    },
  });
}

export function useUpdateQuickReply() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, dto }: { id: string; dto: UpdateQuickReplyRequest }) => {
      return await quickRepliesApi.update(id, dto);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryScopes.quickReplies });
    },
  });
}

export function useDeleteQuickReply() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      return await quickRepliesApi.remove(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryScopes.quickReplies });
    },
  });
}
