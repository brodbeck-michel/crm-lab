/**
 * DoctorSpecialtyService — lista de especialidades por laboratorio
 * (SERVICES.md §30, CRMLAB-188, D-328 item 1).
 *
 *  - laboratorio sem nenhuma especialidade e semeado com a lista padrao do CFM
 *    na primeira leitura (a migracao 071 semeou os que ja existiam);
 *  - nome unico por laboratorio sem acento/caixa/espaco repetido ->
 *    `DOCTOR_SPECIALTY_ALREADY_EXISTS` (409), inclusive contra inativa;
 *  - criar/renomear/inativar: gestor/admin (a rota garante); sem DELETE;
 *  - audit `create_doctor_specialty` / `update_doctor_specialty`.
 */
import {
  DEFAULT_DOCTOR_SPECIALTIES,
  normalizeLookupName,
  type CreateDoctorSpecialtyRequest,
  type DoctorSpecialty,
  type DoctorSpecialtyConflictDetails,
  type ListDoctorSpecialtiesQuery,
  type ListDoctorSpecialtiesResponse,
  type UpdateDoctorSpecialtyRequest,
} from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError, notFound } from '../http/errors.js';
import { DoctorSpecialtyRepository } from '../repositories/doctor-specialty.repository.js';
import { isUniqueViolation } from '../repositories/doctor.repository.js';
import type { AuditService } from './audit.service.js';

export interface DoctorSpecialtyService {
  list(ctx: TenantContext, query: ListDoctorSpecialtiesQuery): Promise<ListDoctorSpecialtiesResponse>;
  create(ctx: TenantContext, dto: CreateDoctorSpecialtyRequest): Promise<DoctorSpecialty>;
  update(ctx: TenantContext, id: string, dto: UpdateDoctorSpecialtyRequest): Promise<DoctorSpecialty>;
}

export interface DoctorSpecialtyServiceDeps {
  db: DbClient;
  audit: AuditService;
}

function cleanName(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function createDoctorSpecialtyService(deps: DoctorSpecialtyServiceDeps): DoctorSpecialtyService {
  const repository = new DoctorSpecialtyRepository(deps.db);
  const audit = deps.audit;

  async function ensureSeeded(tenantId: string): Promise<void> {
    if ((await repository.count(tenantId)) > 0) return;
    await repository.seed(
      tenantId,
      DEFAULT_DOCTOR_SPECIALTIES.map((name) => ({ name, normalizedName: normalizeLookupName(name) })),
    );
  }

  function validName(raw: string): { name: string; normalizedName: string } {
    const name = cleanName(raw);
    if (name.length === 0) {
      throw new BusinessError('VALIDATION_ERROR', { fields: { name: 'Informe o nome' } });
    }
    return { name, normalizedName: normalizeLookupName(name) };
  }

  async function conflict(ctx: TenantContext, normalizedName: string, exceptId?: string): Promise<BusinessError | null> {
    const existing = await repository.findByNormalizedName(ctx.tenantId, normalizedName, exceptId);
    if (!existing) return null;
    const details: DoctorSpecialtyConflictDetails = { existingSpecialty: existing };
    return new BusinessError('DOCTOR_SPECIALTY_ALREADY_EXISTS', { ...details });
  }

  return {
    async list(ctx, query) {
      await ensureSeeded(ctx.tenantId);
      return { specialties: await repository.list(ctx.tenantId, query.active) };
    },

    async create(ctx, dto) {
      const { name, normalizedName } = validName(dto.name);
      const duplicate = await conflict(ctx, normalizedName);
      if (duplicate) throw duplicate;

      let created: DoctorSpecialty;
      try {
        created = await repository.insert(ctx.tenantId, name, normalizedName);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw (await conflict(ctx, normalizedName)) ?? err;
        }
        throw err;
      }

      await audit.record(ctx, {
        action: 'create_doctor_specialty',
        entityType: 'doctor_specialty',
        entityId: created.id,
        newValues: { name: created.name },
      });
      return created;
    },

    async update(ctx, id, dto) {
      const current = await repository.findById(ctx.tenantId, id);
      if (!current) throw notFound({ resource: 'doctor_specialty', id });

      const patch: { name?: string; normalizedName?: string; isActive?: boolean } = {};
      const oldValues: Record<string, unknown> = {};
      const newValues: Record<string, unknown> = {};

      if (dto.name !== undefined) {
        const { name, normalizedName } = validName(dto.name);
        if (name !== current.name) {
          const duplicate = await conflict(ctx, normalizedName, id);
          if (duplicate) throw duplicate;
          patch.name = name;
          patch.normalizedName = normalizedName;
          oldValues.name = current.name;
          newValues.name = name;
        }
      }
      if (dto.isActive !== undefined && dto.isActive !== current.isActive) {
        patch.isActive = dto.isActive;
        oldValues.isActive = current.isActive;
        newValues.isActive = dto.isActive;
      }

      if (Object.keys(newValues).length === 0) return current;

      let updated: DoctorSpecialty | null;
      try {
        updated = await repository.update(ctx.tenantId, id, patch);
      } catch (err) {
        if (isUniqueViolation(err) && patch.normalizedName !== undefined) {
          throw (await conflict(ctx, patch.normalizedName, id)) ?? err;
        }
        throw err;
      }
      if (!updated) throw notFound({ resource: 'doctor_specialty', id });

      await audit.record(ctx, {
        action: 'update_doctor_specialty',
        entityType: 'doctor_specialty',
        entityId: id,
        oldValues,
        newValues,
      });
      return updated;
    },
  };
}
