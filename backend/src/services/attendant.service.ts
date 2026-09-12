/**
 * AttendantService — SERVICES.md §22 (Onda 9 — D-112). Dono de `attendants`
 * (SCHEMA.md §24).
 */
import type {
  Attendant,
  CreateAttendantRequest,
  ListAttendantsQuery,
  ListAttendantsResponse,
  UpdateAttendantRequest,
} from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError, notFound } from '../http/errors.js';
import { findById as findUserById } from '../repositories/user.repository.js';
import {
  AttendantRepository,
  foldName,
  isUniqueViolation,
} from '../repositories/attendant.repository.js';
import type { AuditService } from './audit.service.js';

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const MAX_PAGE = 10_000;

const MANAGER_ROLES = ['manager', 'admin'] as const;
/** Papeis de laboratorio validos para ligar a um atendente (API_CONTRACTS.md §12). */
const LAB_ROLES = ['attendant', 'manager', 'admin'];

export interface AttendantService {
  list(ctx: TenantContext, query: ListAttendantsQuery): Promise<ListAttendantsResponse>;
  create(ctx: TenantContext, dto: CreateAttendantRequest): Promise<Attendant>;
  update(ctx: TenantContext, id: string, dto: UpdateAttendantRequest): Promise<Attendant>;
}

export interface AttendantServiceDeps {
  db: DbClient;
  audit: AuditService;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** "A UI esconde, o servidor recusa" — a rota ja barra, o service confere de novo. */
function assertCanWrite(ctx: TenantContext): void {
  if (ctx.role !== 'manager' && ctx.role !== 'admin') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: [...MANAGER_ROLES] });
  }
}

function conflictOnName(name: string): BusinessError {
  return new BusinessError('CONFLICT', { field: 'name', name });
}

function conflictOnUserId(userId: string): BusinessError {
  return new BusinessError('CONFLICT', { field: 'userId', userId });
}

export function createAttendantService(deps: AttendantServiceDeps): AttendantService {
  const repository = new AttendantRepository(deps.db);
  const audit = deps.audit;

  /**
   * `userId` presente precisa ser um `users.id` ATIVO do mesmo tenant, com
   * papel de laboratorio (API_CONTRACTS.md §12, SERVICES.md §22).
   */
  async function assertValidUserId(ctx: TenantContext, userId: string): Promise<void> {
    const user = await deps.db.withTenant(ctx.tenantId, (tx) => findUserById(tx, userId));
    if (!user || !user.isActive || !LAB_ROLES.includes(user.role)) {
      throw new BusinessError('VALIDATION_ERROR', {
        fields: { userId: 'usuario inexistente, inativo ou sem papel de laboratorio' },
      });
    }
  }

  return {
    async list(ctx: TenantContext, query: ListAttendantsQuery): Promise<ListAttendantsResponse> {
      const search = query.search?.trim();
      const criteria = {
        active: query.active,
        search: search !== undefined && search.length > 0 ? search : undefined,
        page: clampInt(query.page, DEFAULT_PAGE, 1, MAX_PAGE),
        limit: clampInt(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
      };
      const page = await repository.list(ctx.tenantId, criteria);
      return {
        attendants: page.rows,
        pagination: {
          page: criteria.page,
          limit: criteria.limit,
          total: page.total,
          totalPages: page.total === 0 ? 0 : Math.ceil(page.total / criteria.limit),
        },
      };
    },

    async create(ctx: TenantContext, dto: CreateAttendantRequest): Promise<Attendant> {
      assertCanWrite(ctx);
      const name = dto.name.trim();
      const folded = foldName(name);

      if (await repository.foldedNameExists(ctx.tenantId, folded)) {
        throw conflictOnName(name);
      }

      const userId = dto.userId ?? null;
      if (userId !== null) {
        await assertValidUserId(ctx, userId);
        if (await repository.userIdLinked(ctx.tenantId, userId)) {
          throw conflictOnUserId(userId);
        }
      }

      let created: Attendant;
      try {
        created = await repository.insert(ctx.tenantId, { name, userId });
      } catch (err) {
        // Corrida entre o SELECT acima e o INSERT: o indice unico decide.
        if (isUniqueViolation(err)) {
          throw userId !== null ? conflictOnUserId(userId) : conflictOnName(name);
        }
        throw err;
      }

      await audit.record(ctx, {
        action: 'create_attendant',
        entityType: 'attendant',
        entityId: created.id,
        newValues: { name: created.name, userId: created.userId, isActive: created.isActive },
      });

      return created;
    },

    async update(
      ctx: TenantContext,
      id: string,
      dto: UpdateAttendantRequest,
    ): Promise<Attendant> {
      assertCanWrite(ctx);

      const current = await repository.findById(ctx.tenantId, id);
      if (!current) throw notFound({ resource: 'attendant', id });

      const name = dto.name !== undefined ? dto.name.trim() : undefined;
      if (name !== undefined) {
        const folded = foldName(name);
        if (folded !== foldName(current.name) && (await repository.foldedNameExists(ctx.tenantId, folded))) {
          throw conflictOnName(name);
        }
      }

      if (dto.userId !== undefined && dto.userId !== null) {
        await assertValidUserId(ctx, dto.userId);
        if (
          dto.userId !== current.userId &&
          (await repository.userIdLinked(ctx.tenantId, dto.userId, id))
        ) {
          throw conflictOnUserId(dto.userId);
        }
      }

      const oldValues: Record<string, unknown> = {};
      const newValues: Record<string, unknown> = {};
      for (const [key, value] of Object.entries({
        name,
        userId: dto.userId,
        isActive: dto.isActive,
      })) {
        if (value === undefined) continue;
        const previous = (current as unknown as Record<string, unknown>)[key];
        if (previous !== value) {
          oldValues[key] = previous;
          newValues[key] = value;
        }
      }

      let updated: Attendant | null;
      try {
        updated = await repository.update(ctx.tenantId, id, {
          ...(name !== undefined ? { name } : {}),
          ...(dto.userId !== undefined ? { userId: dto.userId } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw dto.userId ? conflictOnUserId(dto.userId) : conflictOnName(name ?? current.name);
        }
        throw err;
      }

      if (!updated) throw notFound({ resource: 'attendant', id });

      if (Object.keys(newValues).length > 0) {
        await audit.record(ctx, {
          action: 'update_attendant',
          entityType: 'attendant',
          entityId: id,
          oldValues,
          newValues,
        });
      }

      return updated;
    },
  };
}
