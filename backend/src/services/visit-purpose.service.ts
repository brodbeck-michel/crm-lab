/**
 * VisitPurposeService — SERVICES.md §31 (CRMLAB-190, D-330).
 *
 * Dono de `visit_purposes`: as finalidades da visita, cadastro de cada
 * laboratorio. Regras:
 *  - todo papel do laboratorio le (a agenda precisa); so manager/admin
 *    escrevem — conferido na rota E aqui (a UI esconde, o servidor recusa);
 *  - nome unico no laboratorio sem diferenciar maiuscula -> erro de CAMPO
 *    (`fields.name`), como o atalho repetido da resposta rapida;
 *  - cor so da paleta (`isVisitPurposeColor`) — o banco tambem confere;
 *  - sem exclusao: inativa. A semente dos laboratorios novos e do banco
 *    (trigger em `tenants`), nao daqui;
 *  - audit `create_visit_purpose` e `update_visit_purpose` (so o diff).
 */
import {
  isVisitPurposeColor,
  VISIT_PURPOSE_NAME_MAX_LENGTH,
  type CreateVisitPurposeRequest,
  type ListVisitPurposesResponse,
  type UpdateVisitPurposeRequest,
  type VisitPurpose,
} from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError, notFound } from '../http/errors.js';
import {
  isUniqueViolation,
  VisitPurposeRepository,
  type VisitPurposePatch,
} from '../repositories/visit-purpose.repository.js';
import type { AuditService } from './audit.service.js';

export interface VisitPurposeService {
  list(ctx: TenantContext): Promise<ListVisitPurposesResponse>;
  create(ctx: TenantContext, dto: CreateVisitPurposeRequest): Promise<VisitPurpose>;
  update(ctx: TenantContext, id: string, dto: UpdateVisitPurposeRequest): Promise<VisitPurpose>;
}

export interface VisitPurposeServiceDeps {
  db: DbClient;
  audit: AuditService;
}

const EDITOR_ROLES = ['manager', 'admin'];

function invalid(fields: Record<string, string>): BusinessError {
  return new BusinessError('VALIDATION_ERROR', { fields });
}

function cleanName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length === 0) throw invalid({ name: 'Informe o nome' });
  if (name.length > VISIT_PURPOSE_NAME_MAX_LENGTH) {
    throw invalid({ name: `No máximo ${VISIT_PURPOSE_NAME_MAX_LENGTH} caracteres` });
  }
  return name;
}

function checkColor(color: string): void {
  if (!isVisitPurposeColor(color)) throw invalid({ color: 'Escolha uma cor da paleta' });
}

function auditView(purpose: VisitPurpose): Record<string, unknown> {
  return {
    name: purpose.name,
    color: purpose.color,
    isActive: purpose.isActive,
    sortOrder: purpose.sortOrder,
  };
}

export function createVisitPurposeService(deps: VisitPurposeServiceDeps): VisitPurposeService {
  const repository = new VisitPurposeRepository(deps.db);
  const audit = deps.audit;

  function assertEditor(ctx: TenantContext): void {
    if (!EDITOR_ROLES.includes(ctx.role)) throw new BusinessError('FORBIDDEN');
  }

  /** A corrida entre dois cadastros com o mesmo nome quem decide e o indice unico. */
  function rethrow(err: unknown): never {
    if (isUniqueViolation(err)) throw invalid({ name: 'Já existe uma finalidade com esse nome' });
    throw err;
  }

  return {
    async list(ctx: TenantContext): Promise<ListVisitPurposesResponse> {
      return { purposes: await repository.list(ctx.tenantId) };
    },

    async create(ctx: TenantContext, dto: CreateVisitPurposeRequest): Promise<VisitPurpose> {
      assertEditor(ctx);
      const name = cleanName(dto.name);
      checkColor(dto.color);

      let created: VisitPurpose;
      try {
        created = await repository.insert(ctx.tenantId, ctx.userId, { name, color: dto.color });
      } catch (err) {
        rethrow(err);
      }

      await audit.record(ctx, {
        action: 'create_visit_purpose',
        entityType: 'visit_purpose',
        entityId: created.id,
        newValues: auditView(created),
      });
      return created;
    },

    /** Inexistente ou de outro tenant -> `NOT_FOUND` (nunca `FORBIDDEN`). */
    async update(ctx: TenantContext, id: string, dto: UpdateVisitPurposeRequest): Promise<VisitPurpose> {
      assertEditor(ctx);
      const current = await repository.findById(ctx.tenantId, id);
      if (!current) throw notFound({ resource: 'visit_purpose', id });

      const patch: VisitPurposePatch = {};
      if (dto.name !== undefined) {
        const name = cleanName(dto.name);
        if (name !== current.name) patch.name = name;
      }
      if (dto.color !== undefined) {
        checkColor(dto.color);
        if (dto.color !== current.color) patch.color = dto.color;
      }
      if (dto.isActive !== undefined && dto.isActive !== current.isActive) patch.isActive = dto.isActive;
      if (dto.sortOrder !== undefined && dto.sortOrder !== current.sortOrder) patch.sortOrder = dto.sortOrder;

      if (Object.keys(patch).length === 0) return current;

      let updated: VisitPurpose | null;
      try {
        updated = await repository.update(ctx.tenantId, id, patch);
      } catch (err) {
        rethrow(err);
      }
      if (!updated) throw notFound({ resource: 'visit_purpose', id });

      const before = auditView(current);
      const after = auditView(updated);
      const oldValues: Record<string, unknown> = {};
      const newValues: Record<string, unknown> = {};
      for (const key of Object.keys(after)) {
        if (before[key] === after[key]) continue;
        oldValues[key] = before[key];
        newValues[key] = after[key];
      }
      await audit.record(ctx, {
        action: 'update_visit_purpose',
        entityType: 'visit_purpose',
        entityId: id,
        oldValues,
        newValues,
      });
      return updated;
    },
  };
}
