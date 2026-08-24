import type {
  CreateUserRequest,
  ListUsersResponse,
  ManagedUser,
  PaginationQuery,
  UpdateUserRequest,
} from '@crm-lab/shared';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from './client';
import { queryKeys, queryScopes } from './query-keys';
import type { QueryParams } from './client';

/**
 * `/users` — tela `/settings/users` (admin).
 * O limite de desconto (`discountLimit`) é alçada: a UI mostra, o servidor
 * decide (docs/contracts/FRONTEND_BACKEND.md §4).
 */
export const usersApi = {
  list: (query: PaginationQuery = {}) => http.get<ListUsersResponse>('/users', query as QueryParams),

  create: (body: CreateUserRequest) => http.post<ManagedUser>('/users', body),

  update: (id: string, body: UpdateUserRequest) => http.patch<ManagedUser>(`/users/${id}`, body),
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
    },
  });
}
