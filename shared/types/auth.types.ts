import type { Theme } from './theme.types.js';
import type { IsoDateTime, PaginationMeta } from './api.types.js';

/** Perfis de usuario (README.md "Perfis de Usuario"). */
export type UserRole = 'attendant' | 'manager' | 'admin' | 'platform_operator';

/** Limites de desconto padrao por perfil (BUSINESS_RULES.md §2). */
export const DEFAULT_DISCOUNT_LIMIT: Record<UserRole, number> = {
  attendant: 15,
  manager: 30,
  admin: 100,
  platform_operator: 0,
};

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  discountLimit: number;
}

export interface AuthTenant {
  id: string;
  name: string;
  slug: string;
  theme: Theme;
}

export interface LoginRequest {
  email: string;
  password: string;
}

/**
 * Resposta de `POST /auth/login` (CRMLAB-32).
 *
 * NAO carrega mais `refreshToken`: o refresh viaja em `Set-Cookie` httpOnly
 * (`crm_refresh`, `Path=/api/v1/auth`), nunca legivel por JavaScript. O access
 * token continua no corpo — vive so em memoria no frontend (nao e persistido).
 */
export interface LoginResponse {
  accessToken: string;
  /** Segundos ate expirar o accessToken. */
  expiresIn: number;
  user: AuthUser;
  tenant: AuthTenant;
}

/**
 * `refreshToken` no corpo e o caminho DEPRECIADO de transicao (CRMLAB-32): o
 * cookie `crm_refresh` e a fonte primaria e o backend le dali primeiro. Este
 * campo e so fallback enquanto clientes antigos (sem o cookie) ainda existem —
 * remover apos 2026-10-04 (2 semanas de janela, ver API_CONTRACTS.md §1).
 */
export interface RefreshRequest {
  /** @deprecated Use o cookie httpOnly `crm_refresh`. Remocao prevista: 2026-10-04. */
  refreshToken?: string;
}

/**
 * Resposta de `POST /auth/refresh` (API_CONTRACTS.md §1, CRMLAB-32).
 *
 * NAO carrega mais `refreshToken`: a rotacao (D-014/SECURITY.md) continua
 * incondicional, mas o token novo vai só no `Set-Cookie`, nunca no corpo JSON.
 */
export interface RefreshResponse {
  accessToken: string;
  /** Segundos ate expirar o accessToken. */
  expiresIn: number;
}

export interface LogoutResponse {
  message: string;
}

/**
 * `PATCH /users/me/password` (CRMLAB-35). `newPassword` mínimo 10 caracteres
 * — validado nos dois lados (frontend so para UX, backend sempre).
 */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface ChangePasswordResponse {
  message: string;
}

/**
 * `POST /auth/forgot-password` (CRMLAB-39). Resposta é SEMPRE 200 com a mesma
 * mensagem, exista ou não o e-mail — não é oráculo de conta (D-172).
 */
export interface ForgotPasswordRequest {
  email: string;
}

export interface ForgotPasswordResponse {
  message: string;
}

/**
 * `POST /auth/reset-password` (CRMLAB-39). `token` vem do link recebido por
 * e-mail; `newPassword` segue a mesma política de `checkPasswordPolicy`
 * (D-153) usada em `PATCH /users/me/password`.
 */
export interface ResetPasswordRequest {
  token: string;
  newPassword: string;
}

export interface ResetPasswordResponse {
  message: string;
}

/** Conteudo do JWT. tenantId e obrigatorio — base do isolamento (BUSINESS_RULES.md §4). */
export interface JwtPayload {
  userId: string;
  tenantId: string;
  role: UserRole;
  discountLimit: number;
  iat?: number;
  exp?: number;
}

export interface CurrentUserResponse {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  discountLimit: number;
  createdAt: IsoDateTime;
}

/** Usuario na tela /settings/users. */
export interface ManagedUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  discountLimit: number;
  isActive: boolean;
  lastLoginAt: IsoDateTime | null;
  createdAt: IsoDateTime;
}

export interface CreateUserRequest {
  email: string;
  name: string;
  password: string;
  role: UserRole;
  discountLimit?: number;
}

export interface UpdateUserRequest {
  name?: string;
  role?: UserRole;
  discountLimit?: number;
  isActive?: boolean;
}

export interface ListUsersResponse {
  users: ManagedUser[];
  pagination: PaginationMeta;
}
