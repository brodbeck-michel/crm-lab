import type { CurrentUserResponse, LoginRequest, LoginResponse, LogoutResponse } from '@crm-lab/shared';
import { http, refreshAccessToken } from './client';

/**
 * `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` · `GET /users/me`
 * (docs/api/API_CONTRACTS.md §1).
 *
 * O tema do tenant vem DENTRO de `LoginResponse.tenant.theme` — o bootstrap
 * NÃO faz request extra de tema (docs/contracts/FRONTEND_BACKEND.md).
 *
 * CRMLAB-32: `refresh` não recebe mais `refreshToken` — ele viaja só no
 * cookie httpOnly `crm_refresh`, anexado automaticamente pelo browser. Não
 * há mais parâmetro para passar.
 */
export const authApi = {
  /** Público: sem header Authorization. */
  login: (body: LoginRequest) => http.post<LoginResponse>('/auth/login', body, { auth: false }),

  /**
   * Uso normal: o interceptor de `client.ts` (e o bootstrap de página,
   * `useSessionBootstrap`) chamam `refreshAccessToken()` sozinhos.
   * Reexportado aqui só para completar o namespace `api.auth.*`.
   */
  refresh: refreshAccessToken,

  logout: () => http.post<LogoutResponse>('/auth/logout'),

  me: () => http.get<CurrentUserResponse>('/users/me'),
};
