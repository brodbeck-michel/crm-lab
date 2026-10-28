import type {
  ChangePasswordRequest,
  ChangePasswordResponse,
  CreateUserRequest,
  ListUsersResponse,
  ManagedUser,
  PaginationQuery,
  UpdateMyPresenceRequest,
  UpdateUserRequest,
  UserPresenceResponse,
  UserPresenceStatus,
} from '@crm-lab/shared';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from './client';
import { queryKeys, queryScopes } from './query-keys';
import type { QueryParams } from './client';
import { useAuthStore, selectRole } from '@/stores/auth.store';

/**
 * `/users` — tela `/settings/users` (admin).
 * O limite de desconto (`discountLimit`) é alçada: a UI mostra, o servidor
 * decide (docs/contracts/FRONTEND_BACKEND.md §4).
 */
export const usersApi = {
  list: (query: PaginationQuery = {}) => http.get<ListUsersResponse>('/users', query as QueryParams),

  create: (body: CreateUserRequest) => http.post<ManagedUser>('/users', body),

  update: (id: string, body: UpdateUserRequest) => http.patch<ManagedUser>(`/users/${id}`, body),

  /** Status da equipe (CRMLAB-120, D-286) — qualquer papel de laboratório. */
  presence: () => http.get<UserPresenceResponse>('/users/presence'),

  updateMyPresence: (body: UpdateMyPresenceRequest) =>
    http.patch<UserPresenceResponse>('/users/me/presence', body),
};

/* ── React Query Hooks ──────────────────────────────────────────────────── */

export function useUserList(filters?: PaginationQuery) {
  return useQuery({
    queryKey: queryKeys.users(filters),
    queryFn: async () => {
      const res = await usersApi.list(filters);
      return res;
    },
    staleTime: 60000, // 1 minuto
  });
}

export function useCreateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateUserRequest) => {
      return usersApi.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryScopes.users });
      // CRMLAB-122 (D-288): a lista de quem recebe conversa saiu do escopo
      // `conversations` e não é mais refeita por mensagem do WS.
      queryClient.invalidateQueries({ queryKey: queryKeys.conversationAssignees() });
    },
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateUserRequest }) => {
      return usersApi.update(id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryScopes.users });
      queryClient.invalidateQueries({ queryKey: queryKeys.conversationAssignees() });
    },
  });
}

/**
 * Troca da própria senha (`PATCH /users/me/password`, CRMLAB-35).
 * O refresh da sessão atual vai sozinho no cookie httpOnly — o servidor usa
 * ele para preservar ESTA sessão e derrubar as outras do mesmo usuário.
 */
export function useChangePassword() {
  return useMutation({
    mutationFn: async (data: ChangePasswordRequest) => {
      return http.patch<ChangePasswordResponse>('/users/me/password', data);
    },
  });
}

/**
 * Status da equipe (CRMLAB-120, D-286). O WS `user.presence_changed` invalida;
 * o operador da plataforma não tem rota de laboratório, então não pergunta.
 */
export function useUsersPresence() {
  const role = useAuthStore(selectRole);
  return useQuery({
    queryKey: queryKeys.usersPresence(),
    queryFn: () => usersApi.presence(),
    enabled: role !== null && role !== 'platform_operator',
    staleTime: 60_000,
  });
}

/** `(userId) => status` — `undefined` enquanto carrega ou para quem não está na lista. */
export function usePresenceOf(): (userId: string | null | undefined) => UserPresenceStatus | undefined {
  const { data } = useUsersPresence();
  const byId = new Map(data?.items.map((item) => [item.userId, item.status]));
  return (userId) => (userId ? byId.get(userId) : undefined);
}

/** Troca o próprio status ou avisa inatividade — a resposta já é a lista nova. */
export function useUpdateMyPresence() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateMyPresenceRequest) => usersApi.updateMyPresence(body),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.usersPresence(), data);
    },
  });
}
