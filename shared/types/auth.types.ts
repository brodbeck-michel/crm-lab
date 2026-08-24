import type { Theme } from './theme.types.js';
import type { IsoDateTime } from './api.types.js';

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

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  /** Segundos ate expirar o accessToken. */
  expiresIn: number;
  user: AuthUser;
  tenant: AuthTenant;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface RefreshResponse {
  accessToken: string;
  expiresIn: number;
}

export interface LogoutResponse {
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
  pagination: import('./api.types.js').PaginationMeta;
}
