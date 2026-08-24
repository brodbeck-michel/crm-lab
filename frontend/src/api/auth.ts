import type {
  CurrentUserResponse,
  LoginRequest,
  LoginResponse,
  LogoutResponse,
  RefreshResponse,
} from '@crm-lab/shared';
import { http } from './client';

/**
 * `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` · `GET /users/me`
 * (docs/api/API_CONTRACTS.md §1).
 *
 * O tema do tenant vem DENTRO de `LoginResponse.tenant.theme` — o bootstrap
 * NÃO faz request extra de tema (docs/contracts/FRONTEND_BACKEND.md).
 */
export const authApi = {
  /** Público: sem header Authorization. */
  login: (body: LoginRequest) => http.post<LoginResponse>('/auth/login', body, { auth: false }),

  /**
   * Uso normal: o interceptor de `client.ts` chama sozinho em `TOKEN_EXPIRED`.
   * Exposto aqui só para completar o contrato.
   */
  refresh: (refreshToken: string) =>
    http.post<RefreshResponse>('/auth/refresh', { refreshToken }, { auth: false }),

  logout: () => http.post<LogoutResponse>('/auth/logout'),

  me: () => http.get<CurrentUserResponse>('/users/me'),
};
