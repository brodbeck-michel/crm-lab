/**
 * DoctorService — SERVICES.md §30 (CRMLAB-86, D-255).
 *
 * Dono da tabela `doctors`: o cadastro de medicos solicitantes que o epico
 * Visitacao Medica (CRMLAB-85) usa como base (agenda, check-in/out e linha do
 * tempo vao referenciar `doctors.id`).
 *
 * Regras (D-255):
 *  - todo papel de laboratorio ve, cadastra, edita e inativa (sem perfil novo);
 *    o `platform_operator` ja fica na rota (`denyPlatformOperator`);
 *  - CRM opcional, normalizado para so digitos; com CRM a UF e obrigatoria e
 *    tem de ser uma das 27; (tenant, CRM, UF) e unico, ativo ou inativo ->
 *    `DOCTOR_CRM_ALREADY_EXISTS` (409);
 *  - responsavel pela carteira: usuario ATIVO do MESMO laboratorio, com papel
 *    de tenant; senao `VALIDATION_ERROR` em `responsibleId`;
 *  - sem DELETE: inativar/reativar, idempotentes;
 *  - audit log em criar, editar, inativar e reativar.
 */
import {
  isBrazilUf,
  normalizeCrm,
  normalizeUf,
  DOCTOR_CRM_MAX_DIGITS,
  type CreateDoctorRequest,
  type Doctor,
  type DoctorCrmConflictDetails,
  type ListDoctorsQuery,
  type ListDoctorsResponse,
  type UpdateDoctorRequest,
} from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError, notFound } from '../http/errors.js';
import {
  DoctorRepository,
  isDoctorSortBy,
  isUniqueViolation,
  type DoctorFields,
  type DoctorListCriteria,
  type DoctorPatch,
} from '../repositories/doctor.repository.js';
import type { AuditService } from './audit.service.js';

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
/** Teto de `page` (mesmo padrao de `/insurances`): acima dele a lista vem vazia. */
export const MAX_PAGE = 10_000;

/** Quem pode ser responsavel pela carteira: qualquer papel de laboratorio. */
const RESPONSIBLE_ROLES = ['attendant', 'manager', 'admin'];

/** Campos de texto livre opcionais: vazio vira `null`. */
const TEXT_FIELDS = [
  'specialty',
  'clinic',
  'address',
  'phone',
  'email',
  'contactName',
  'visitPreference',
  'notes',
] as const;

export interface DoctorService {
  list(ctx: TenantContext, query: ListDoctorsQuery): Promise<ListDoctorsResponse>;
  getById(ctx: TenantContext, id: string): Promise<Doctor>;
  create(ctx: TenantContext, dto: CreateDoctorRequest): Promise<Doctor>;
  update(ctx: TenantContext, id: string, dto: UpdateDoctorRequest): Promise<Doctor>;
  inactivate(ctx: TenantContext, id: string): Promise<Doctor>;
  reactivate(ctx: TenantContext, id: string): Promise<Doctor>;
}

export interface DoctorServiceDeps {
  db: DbClient;
  audit: AuditService;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function toCriteria(query: ListDoctorsQuery): DoctorListCriteria {
  const search = query.search?.trim();
  return {
    search: search !== undefined && search.length > 0 ? search : undefined,
    active: query.active,
    responsibleId: query.responsibleId,
    page: clampInt(query.page, DEFAULT_PAGE, 1, MAX_PAGE),
    limit: clampInt(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
    sortBy: query.sortBy !== undefined && isDoctorSortBy(query.sortBy) ? query.sortBy : 'name',
    order: query.order === 'desc' ? 'desc' : 'asc',
  };
}

/** Texto opcional: `undefined` fica `undefined` (PATCH nao mexe); vazio/`null` vira `null`. */
function cleanText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function invalid(fields: Record<string, string>): BusinessError {
  return new BusinessError('VALIDATION_ERROR', { fields });
}

/**
 * CRM/UF efetivos depois do merge com o estado atual (no PATCH), ja
 * normalizados e validados. A validacao olha o PAR, por isso nao cabe no zod
 * da rota: `PATCH { crm }` vale se o medico ja tem UF.
 */
function resolveCrm(
  crmInput: string | null | undefined,
  ufInput: string | null | undefined,
  current?: Pick<Doctor, 'crm' | 'crmUf'>,
): { crm: string | null; crmUf: string | null } {
  const crm = crmInput !== undefined ? normalizeCrm(crmInput) : (current?.crm ?? null);
  const crmUf = ufInput !== undefined ? normalizeUf(ufInput) : (current?.crmUf ?? null);

  if (crm !== null && crm.length > DOCTOR_CRM_MAX_DIGITS) {
    throw invalid({ crm: `CRM com no máximo ${DOCTOR_CRM_MAX_DIGITS} dígitos` });
  }
  if (crmUf !== null && !isBrazilUf(crmUf)) {
    throw invalid({ crmUf: 'UF inválida' });
  }
  if (crm !== null && crmUf === null) {
    throw invalid({ crmUf: 'Informe a UF do CRM' });
  }
  return { crm, crmUf };
}

function sameValue(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

/** Visao "plana" do medico para o diff do audit (responsavel por id). */
function auditView(doctor: Doctor): Record<string, unknown> {
  return {
    name: doctor.name,
    crm: doctor.crm,
    crmUf: doctor.crmUf,
    specialty: doctor.specialty,
    clinic: doctor.clinic,
    address: doctor.address,
    phone: doctor.phone,
    email: doctor.email,
    contactName: doctor.contactName,
    visitPreference: doctor.visitPreference,
    notes: doctor.notes,
    responsibleId: doctor.responsible?.id ?? null,
  };
}

export function createDoctorService(deps: DoctorServiceDeps): DoctorService {
  const repository = new DoctorRepository(deps.db);
  const audit = deps.audit;

  /** Responsavel valido: usuario ativo, papel de tenant, do MESMO laboratorio. */
  async function assertResponsible(ctx: TenantContext, userId: string): Promise<void> {
    const user = await repository.findTenantUser(ctx.tenantId, userId);
    if (!user || !user.isActive || !RESPONSIBLE_ROLES.includes(user.role)) {
      throw invalid({ responsibleId: 'Usuário inexistente ou inativo neste laboratório' });
    }
  }

  /** (CRM, UF) ja usado por OUTRO medico do tenant -> 409 com quem e. */
  async function assertCrmFree(
    ctx: TenantContext,
    crm: string | null,
    crmUf: string | null,
    exceptId?: string,
  ): Promise<void> {
    if (crm === null || crmUf === null) return;
    const existing = await repository.findByCrm(ctx.tenantId, crm, crmUf, exceptId);
    if (existing) throw crmConflict(crm, crmUf, existing);
  }

  function crmConflict(
    crm: string,
    crmUf: string,
    existingDoctor: DoctorCrmConflictDetails['existingDoctor'],
  ): BusinessError {
    const details: DoctorCrmConflictDetails = { crm, crmUf, existingDoctor };
    return new BusinessError('DOCTOR_CRM_ALREADY_EXISTS', { ...details });
  }

  /** Corrida entre o SELECT de duplicidade e a escrita: o indice unico decide. */
  async function raceConflict(ctx: TenantContext, crm: string, crmUf: string): Promise<BusinessError> {
    const existing = await repository.findByCrm(ctx.tenantId, crm, crmUf);
    return crmConflict(crm, crmUf, existing ?? { id: '', name: '', isActive: true });
  }

  async function setActive(ctx: TenantContext, id: string, isActive: boolean): Promise<Doctor> {
    const current = await repository.findById(ctx.tenantId, id);
    if (!current) throw notFound({ resource: 'doctor', id });
    // Idempotente: o mesmo estado devolve 200 sem segundo audit.
    if (current.isActive === isActive) return current;

    const updated = await repository.update(ctx.tenantId, id, { isActive });
    if (!updated) throw notFound({ resource: 'doctor', id });

    await audit.record(ctx, {
      action: isActive ? 'reactivate_doctor' : 'inactivate_doctor',
      entityType: 'doctor',
      entityId: id,
      oldValues: { isActive: current.isActive },
      newValues: { isActive },
    });
    return updated;
  }

  return {
    async list(ctx: TenantContext, query: ListDoctorsQuery): Promise<ListDoctorsResponse> {
      const criteria = toCriteria(query);
      const page = await repository.list(ctx.tenantId, criteria);
      return {
        doctors: page.rows,
        pagination: {
          page: criteria.page,
          limit: criteria.limit,
          total: page.total,
          totalPages: page.total === 0 ? 0 : Math.ceil(page.total / criteria.limit),
        },
      };
    },

    /** Inexistente ou de outro tenant -> `NOT_FOUND` (nunca `FORBIDDEN`). */
    async getById(ctx: TenantContext, id: string): Promise<Doctor> {
      const doctor = await repository.findById(ctx.tenantId, id);
      if (!doctor) throw notFound({ resource: 'doctor', id });
      return doctor;
    },

    async create(ctx: TenantContext, dto: CreateDoctorRequest): Promise<Doctor> {
      const name = dto.name.trim();
      if (name.length === 0) throw invalid({ name: 'Informe o nome' });

      const { crm, crmUf } = resolveCrm(dto.crm, dto.crmUf);
      const responsibleId = dto.responsibleId ?? null;
      if (responsibleId !== null) await assertResponsible(ctx, responsibleId);
      await assertCrmFree(ctx, crm, crmUf);

      const fields: DoctorFields = {
        name,
        crm,
        crmUf,
        specialty: cleanText(dto.specialty) ?? null,
        clinic: cleanText(dto.clinic) ?? null,
        address: cleanText(dto.address) ?? null,
        phone: cleanText(dto.phone) ?? null,
        email: cleanText(dto.email) ?? null,
        contactName: cleanText(dto.contactName) ?? null,
        visitPreference: cleanText(dto.visitPreference) ?? null,
        notes: cleanText(dto.notes) ?? null,
        responsibleId,
      };

      let created: Doctor;
      try {
        created = await repository.insert(ctx.tenantId, ctx.userId, fields);
      } catch (err) {
        if (isUniqueViolation(err) && crm !== null && crmUf !== null) {
          throw await raceConflict(ctx, crm, crmUf);
        }
        throw err;
      }

      await audit.record(ctx, {
        action: 'create_doctor',
        entityType: 'doctor',
        entityId: created.id,
        newValues: auditView(created),
      });
      return created;
    },

    /**
     * PATCH parcial. Id de outro tenant -> `NOT_FOUND` (o RLS ja escondeu a
     * linha). O responsavel so e revalidado quando MUDA: um medico cujo
     * responsavel foi desativado continua editavel sem trocar a carteira.
     */
    async update(ctx: TenantContext, id: string, dto: UpdateDoctorRequest): Promise<Doctor> {
      const current = await repository.findById(ctx.tenantId, id);
      if (!current) throw notFound({ resource: 'doctor', id });

      const patch: DoctorPatch = {};

      if (dto.name !== undefined) {
        const name = dto.name.trim();
        if (name.length === 0) throw invalid({ name: 'Informe o nome' });
        patch.name = name;
      }

      // CRM/UF efetivos depois do PATCH (o par e validado junto, com o atual).
      let effective = { crm: current.crm, crmUf: current.crmUf };
      if (dto.crm !== undefined || dto.crmUf !== undefined) {
        effective = resolveCrm(dto.crm, dto.crmUf, current);
        patch.crm = effective.crm;
        patch.crmUf = effective.crmUf;
      }

      for (const field of TEXT_FIELDS) {
        const value = cleanText(dto[field]);
        if (value !== undefined) patch[field] = value;
      }

      if (dto.responsibleId !== undefined) {
        const responsibleId = dto.responsibleId;
        if (responsibleId !== null && responsibleId !== current.responsible?.id) {
          await assertResponsible(ctx, responsibleId);
        }
        patch.responsibleId = responsibleId;
      }

      // So o que mudou de fato vai para o UPDATE e para o audit.
      const before = auditView(current);
      const oldValues: Record<string, unknown> = {};
      const newValues: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch) as Array<[keyof DoctorPatch, unknown]>) {
        if (sameValue(before[key], value)) {
          delete patch[key];
          continue;
        }
        oldValues[key] = before[key] ?? null;
        newValues[key] = value;
      }

      if (Object.keys(newValues).length === 0) return current;

      if (patch.crm !== undefined || patch.crmUf !== undefined) {
        await assertCrmFree(ctx, effective.crm, effective.crmUf, id);
      }

      let updated: Doctor | null;
      try {
        updated = await repository.update(ctx.tenantId, id, patch);
      } catch (err) {
        if (isUniqueViolation(err) && effective.crm !== null && effective.crmUf !== null) {
          throw await raceConflict(ctx, effective.crm, effective.crmUf);
        }
        throw err;
      }
      if (!updated) throw notFound({ resource: 'doctor', id });

      await audit.record(ctx, {
        action: 'update_doctor',
        entityType: 'doctor',
        entityId: id,
        oldValues,
        newValues,
      });
      return updated;
    },

    async inactivate(ctx: TenantContext, id: string): Promise<Doctor> {
      return setActive(ctx, id, false);
    },

    async reactivate(ctx: TenantContext, id: string): Promise<Doctor> {
      return setActive(ctx, id, true);
    },
  };
}
