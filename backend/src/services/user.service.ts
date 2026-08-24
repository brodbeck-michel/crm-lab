/**
 * UserService — tela `/settings/users` (admin) + `GET /users/me`.
 *
 * Regras que sao contrato:
 *
 * - Alcada padrao por papel vem de `DEFAULT_DISCOUNT_LIMIT` de `@crm-lab/shared`
 *   (BUSINESS_RULES.md §2). Nunca redeclarada aqui.
 * - NINGUEM eleva o proprio papel, a propria alcada ou o proprio status —
 *   incluindo admin (D-013). Escalonamento de privilegio nao vira "confio no
 *   admin": e um alvo de sequestro de sessao.
 * - Usuario de outro tenant nao existe: `NOT_FOUND`, nunca `FORBIDDEN`
 *   (SECURITY.md camada 2). O RLS ja devolve zero linhas; o service so traduz.
 * - Desativa em vez de deletar. Nao existe DELETE de usuario nesta API.
 * - Toda mudanca de papel / alcada / status gera audit log (BUSINESS_RULES §9).
 */
import { randomUUID } from 'node:crypto';
import type {
  CreateUserRequest,
  CurrentUserResponse,
  ListUsersResponse,
  ManagedUser,
  PaginationMeta,
  UpdateUserRequest,
  UserRole,
} from '@crm-lab/shared';
import { DEFAULT_DISCOUNT_LIMIT } from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError, notFound } from '../http/errors.js';
import { hashPassword } from '../lib/password.js';
import * as userRepo from '../repositories/user.repository.js';
import type { UserEntity } from '../repositories/user.repository.js';
import type { AuditService } from './audit.service.js';

/**
 * Papeis que um admin de laboratorio pode atribuir. `platform_operator` NAO
 * esta na lista: ele pertence ao console da plataforma e concede-lo aqui seria
 * escalonamento para fora do tenant (SECURITY.md "Console de Plataforma").
 */
export const ASSIGNABLE_ROLES: readonly UserRole[] = ['attendant', 'manager', 'admin'];

export const MIN_PASSWORD_LENGTH = 8;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface ListUsersFilters {
  page?: number;
  limit?: number;
  search?: string;
  isActive?: boolean;
}

export interface UserService {
  getMe(ctx: TenantContext): Promise<CurrentUserResponse>;
  list(ctx: TenantContext, filters: ListUsersFilters): Promise<ListUsersResponse>;
  create(ctx: TenantContext, dto: CreateUserRequest): Promise<ManagedUser>;
  update(ctx: TenantContext, id: string, dto: UpdateUserRequest): Promise<ManagedUser>;
}

export interface UserServiceDeps {
  db: DbClient;
  audit: AuditService;
}

function toManagedUser(user: UserEntity): ManagedUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    discountLimit: user.discountLimit,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

function paginate(page: number, limit: number, total: number): PaginationMeta {
  return { page, limit, total, totalPages: total === 0 ? 0 : Math.ceil(total / limit) };
}

function clampPage(value: number | undefined): number {
  const n = Number(value ?? 1);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function clampLimit(value: number | undefined): number {
  const n = Number(value ?? DEFAULT_LIMIT);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function assertAdmin(ctx: TenantContext): void {
  if (ctx.role !== 'admin') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: ['admin'] });
  }
}

function assertAssignableRole(role: UserRole): void {
  if (!ASSIGNABLE_ROLES.includes(role)) {
    throw new BusinessError('VALIDATION_ERROR', {
      fields: { role: `Papel deve ser um de: ${ASSIGNABLE_ROLES.join(', ')}` },
    });
  }
}

function assertValidDiscountLimit(limit: number): void {
  if (!Number.isFinite(limit) || limit < 0 || limit > 100) {
    throw new BusinessError('VALIDATION_ERROR', {
      fields: { discountLimit: 'Alçada deve estar entre 0 e 100' },
    });
  }
}

/** Violacao de `UNIQUE (tenant_id, email)` -> 409 CONFLICT (API_ERRORS.md). */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === '23505') return true;
  const message = err instanceof Error ? err.message : '';
  return message.includes('duplicate key value') || message.includes('users_tenant_id_email_key');
}

export function createUserService(deps: UserServiceDeps): UserService {
  const { db, audit } = deps;

  const getMe = async (ctx: TenantContext): Promise<CurrentUserResponse> => {
    const user = await db.withTenant(ctx.tenantId, (tx) => userRepo.findById(tx, ctx.userId));
    // Usuario removido/desativado com token ainda vivo: nao inventamos o perfil.
    if (!user) throw notFound({ resource: 'user' });
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      discountLimit: user.discountLimit,
      createdAt: user.createdAt,
    };
  };

  const list = async (
    ctx: TenantContext,
    filters: ListUsersFilters,
  ): Promise<ListUsersResponse> => {
    assertAdmin(ctx);
    const page = clampPage(filters.page);
    const limit = clampLimit(filters.limit);

    const { users, total } = await db.withTenant(ctx.tenantId, (tx) =>
      userRepo.list(tx, { page, limit, search: filters.search, isActive: filters.isActive }),
    );

    return { users: users.map(toManagedUser), pagination: paginate(page, limit, total) };
  };

  const create = async (ctx: TenantContext, dto: CreateUserRequest): Promise<ManagedUser> => {
    assertAdmin(ctx);
    assertAssignableRole(dto.role);

    if (dto.password.length < MIN_PASSWORD_LENGTH) {
      throw new BusinessError('VALIDATION_ERROR', {
        fields: { password: `Senha deve ter ao menos ${MIN_PASSWORD_LENGTH} caracteres` },
      });
    }

    const discountLimit = dto.discountLimit ?? DEFAULT_DISCOUNT_LIMIT[dto.role];
    assertValidDiscountLimit(discountLimit);

    const passwordHash = await hashPassword(dto.password);
    const id = randomUUID();

    let created: UserEntity;
    try {
      created = await db.withTenant(ctx.tenantId, (tx) =>
        userRepo.insert(tx, {
          id,
          tenantId: ctx.tenantId,
          email: dto.email.trim().toLowerCase(),
          passwordHash,
          name: dto.name.trim(),
          role: dto.role,
          discountLimit,
        }),
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BusinessError('CONFLICT', { field: 'email' });
      }
      throw err;
    }

    await audit.record(ctx, {
      action: 'create_user',
      entityType: 'user',
      entityId: created.id,
      newValues: {
        email: created.email,
        name: created.name,
        role: created.role,
        discountLimit: created.discountLimit,
        isActive: created.isActive,
      },
    });

    return toManagedUser(created);
  };

  const update = async (
    ctx: TenantContext,
    id: string,
    dto: UpdateUserRequest,
  ): Promise<ManagedUser> => {
    assertAdmin(ctx);
    if (dto.role !== undefined) assertAssignableRole(dto.role);
    if (dto.discountLimit !== undefined) assertValidDiscountLimit(dto.discountLimit);

    const outcome = await db.withTenant(ctx.tenantId, async (tx) => {
      const current = await userRepo.findById(tx, id);
      // Inexistente OU de outro tenant (o RLS esconde) — mesma resposta.
      if (!current) return { kind: 'not_found' as const };

      // D-013: auto-elevacao de privilegio bloqueada para qualquer papel.
      if (current.id === ctx.userId) {
        const escalating: string[] = [];
        if (dto.role !== undefined && dto.role !== current.role) escalating.push('role');
        if (dto.discountLimit !== undefined && dto.discountLimit !== current.discountLimit) {
          escalating.push('discountLimit');
        }
        if (dto.isActive !== undefined && dto.isActive !== current.isActive) {
          escalating.push('isActive');
        }
        if (escalating.length > 0) {
          return { kind: 'self_escalation' as const, fields: escalating };
        }
      }

      const updated = await userRepo.update(tx, id, {
        name: dto.name?.trim(),
        role: dto.role,
        discountLimit: dto.discountLimit,
        isActive: dto.isActive,
      });
      if (!updated) return { kind: 'not_found' as const };
      return { kind: 'updated' as const, previous: current, updated };
    });

    if (outcome.kind === 'not_found') throw notFound({ resource: 'user' });
    if (outcome.kind === 'self_escalation') {
      throw new BusinessError('FORBIDDEN', {
        reason: 'self_privilege_change',
        fields: outcome.fields,
      });
    }

    const { previous, updated } = outcome;

    // Auditoria SO quando papel, alcada ou status mudaram (BUSINESS_RULES §9);
    // renomear-se nao e mudanca de permissao.
    const oldValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};
    if (previous.role !== updated.role) {
      oldValues.role = previous.role;
      newValues.role = updated.role;
    }
    if (previous.discountLimit !== updated.discountLimit) {
      oldValues.discountLimit = previous.discountLimit;
      newValues.discountLimit = updated.discountLimit;
    }
    if (previous.isActive !== updated.isActive) {
      oldValues.isActive = previous.isActive;
      newValues.isActive = updated.isActive;
    }
    if (Object.keys(newValues).length > 0) {
      await audit.record(ctx, {
        action: 'update_user_permissions',
        entityType: 'user',
        entityId: updated.id,
        oldValues,
        newValues,
      });
    }

    return toManagedUser(updated);
  };

  return { getMe, list, create, update };
}
