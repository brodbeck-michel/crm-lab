import type {
  CreateUserRequest,
  ListUsersResponse,
  ManagedUser,
  PaginationQuery,
  UpdateUserRequest,
} from '@crm-lab/shared';
import { http } from './client';
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
