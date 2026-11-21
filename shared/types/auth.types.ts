import type { Theme } from './theme.types.js';
import type { IsoDateTime, PaginationMeta } from './api.types.js';

/**
 * Perfis de usuario (README.md "Perfis de Usuario"). `representative`
 * (Representante, CRMLAB-189/D-329): visitacao medica pela propria carteira; fora
 * da Visitacao tem exatamente as permissoes da `attendant` (`isFrontlineRole`).
 */
export type UserRole = 'attendant' | 'representative' | 'manager' | 'admin' | 'platform_operator';

/** Papeis de laboratorio (todos menos o operador da plataforma). */
export type TenantRole = Exclude<UserRole, 'platform_operator'>;

/** Todos os papeis de laboratorio, na ordem de exibicao. */
export const TENANT_USER_ROLES: readonly TenantRole[] = ['attendant', 'representative', 'manager', 'admin'] as const;

/** Rotulo pt-BR de cada perfil — fonte unica para as telas. */
export const USER_ROLE_LABELS: Record<UserRole, string> = {
  attendant: 'Atendente',
  representative: 'Representante',
  manager: 'Gestor',
  admin: 'Administrador',
  platform_operator: 'Operador da plataforma',
};

/**
 * Linha de frente (atendente OU representante): quem, fora da Visitacao, ve so o
 * proprio recorte (propostas, vendas, conversao) — D-329 item 2. Use isto no lugar
 * de `role === 'attendant'` quando o sentido for "nao e gestor/admin".
 */
export function isFrontlineRole(role: UserRole | null | undefined): role is 'attendant' | 'representative' {
  return role === 'attendant' || role === 'representative';
}

/** Quem acessa a Visitacao Medica (D-329 item 3). A atendente fica de fora (403). */
export const VISITATION_ROLES: readonly TenantRole[] = ['representative', 'manager', 'admin'] as const;

/** Quem pode ser responsavel por medico (carteira) e por visita (D-329 item 5). */
export const VISITATION_RESPONSIBLE_ROLES: readonly TenantRole[] = VISITATION_ROLES;

export function canAccessVisitation(role: UserRole | null | undefined): boolean {
  return role !== null && role !== undefined && (VISITATION_ROLES as readonly string[]).includes(role);
}

/** Gestor/admin veem e alteram toda a Visitacao; o representante, so a carteira dele. */
export function seesAllVisitation(role: UserRole | null | undefined): boolean {
  return role === 'manager' || role === 'admin';
}

export function isVisitationResponsibleRole(role: string): boolean {
  return (VISITATION_RESPONSIBLE_ROLES as readonly string[]).includes(role);
}

/** Limites de desconto padrao por perfil (BUSINESS_RULES.md §2). */
export const DEFAULT_DISCOUNT_LIMIT: Record<UserRole, number> = {
  attendant: 15,
  representative: 15,
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
  /**
   * Senha atual é provisória (reset por admin ou console — CRMLAB-186, D-326): o usuário
   * precisa trocá-la antes de usar o sistema. Opcional só para tolerar sessão persistida
   * antes do campo existir; o backend sempre envia.
   */
  mustChangePassword?: boolean;
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
  /** Só presente (e `true`) com senha provisória — CRMLAB-186, D-326. */
  mustChangePassword?: boolean;
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

/** `POST /users/:id/reset-password` (admin — CRMLAB-186, D-326). Senha aparece uma única vez. */
export interface ResetUserPasswordResponse {
  userId: string;
  email: string;
  temporaryPassword: string;
}

export interface ListUsersResponse {
  users: ManagedUser[];
  pagination: PaginationMeta;
}
