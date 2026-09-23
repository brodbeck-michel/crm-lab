import type {
  CurrentUserResponse,
  ForgotPasswordRequest,
  ForgotPasswordResponse,
  LoginRequest,
  LoginResponse,
  LogoutResponse,
  ResetPasswordRequest,
  ResetPasswordResponse,
} from '@crm-lab/shared';
import { useMutation } from '@tanstack/react-query';
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

  /** Público. Sempre 200 — não confirma se o e-mail existe (CRMLAB-39). */
  forgotPassword: (body: ForgotPasswordRequest) =>
    http.post<ForgotPasswordResponse>('/auth/forgot-password', body, { auth: false }),

  /** Público: o token do link já autoriza a troca (CRMLAB-39). */
  resetPassword: (body: ResetPasswordRequest) =>
    http.post<ResetPasswordResponse>('/auth/reset-password', body, { auth: false }),
};

/* ── React Query Hooks ──────────────────────────────────────────────────── */

export function useForgotPassword() {
  return useMutation({
    mutationFn: async (data: ForgotPasswordRequest) => authApi.forgotPassword(data),
  });
}

export function useResetPassword() {
  return useMutation({
    mutationFn: async (data: ResetPasswordRequest) => authApi.resetPassword(data),
  });
}
