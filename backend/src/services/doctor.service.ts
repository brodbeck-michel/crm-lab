/**
 * DoctorService — SERVICES.md §30 (CRMLAB-86, D-255).
 *
 * Dono da tabela `doctors`: o cadastro de medicos solicitantes que o epico
 * Visitacao Medica (CRMLAB-85) usa como base (agenda, check-in/out e linha do
 * tempo vao referenciar `doctors.id`).
 *
 * Regras (D-255, com o escopo de D-329):
 *  - so representante, gestor e admin (a atendente recebe 403). Gestor/admin
 *    veem e mexem em todos; o representante so na PROPRIA carteira (outro
 *    medico -> 404), cadastra sempre nela e nao troca o responsavel;
 *  - responsavel obrigatorio e de perfil elegivel (`VISITATION_RESPONSIBLE_ROLES`);
 *    responsavel inativo e inalterado continua tolerado (D-255 item 9);
 *  - carteiras e transferencia em lote: so gestor/admin;
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
  isVisitationResponsibleRole,
  normalizeCrm,
  normalizeUf,
  DOCTOR_CRM_MAX_DIGITS,
  type CreateDoctorRequest,
  type Doctor,
  type DoctorCrmConflictDetails,
  type ListDoctorPortfoliosResponse,
  type ListDoctorsQuery,
  type ListDoctorsResponse,
  type TransferDoctorsRequest,
  type TransferDoctorsResponse,
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
import { assertSeesAllVisitation, assertVisitationRole, portfolioOwner } from './visitation-access.js';

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
/** Teto de `page` (mesmo padrao de `/insurances`): acima dele a lista vem vazia. */
export const MAX_PAGE = 10_000;

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
  /** Carteiras por responsavel (gestor/admin — D-329 item 7). */
  portfolios(ctx: TenantContext): Promise<ListDoctorPortfoliosResponse>;
  /** Transferencia em lote (gestor/admin — D-329 item 8). */
  transfer(ctx: TenantContext, dto: TransferDoctorsRequest): Promise<TransferDoctorsResponse>;
}

export interface DoctorServiceDeps {
  db: DbClient;
  audit: AuditService;
  /** Relogio injetavel ("visita futura" da transferencia). */
  now?: () => Date;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function toCriteria(query: ListDoctorsQuery, ownerId: string | undefined): DoctorListCriteria {
  const search = query.search?.trim();
  return {
    search: search !== undefined && search.length > 0 ? search : undefined,
    active: query.active,
    responsibleId: query.responsibleId,
    unassigned: query.unassigned === true ? true : undefined,
    ownerId,
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
  const now = deps.now ?? ((): Date => new Date());

  const RESPONSIBLE_MESSAGE = 'Escolha um representante, gestor ou admin ativo deste laboratório';

  /**
   * Responsavel valido: usuario ativo, de perfil elegivel (D-329), do MESMO
   * laboratorio. O representante so pode por ele mesmo (carteira propria).
   */
  async function assertResponsible(ctx: TenantContext, userId: string): Promise<void> {
    const owner = portfolioOwner(ctx);
    if (owner !== undefined && userId !== owner) {
      throw invalid({ responsibleId: 'O representante só cadastra médicos na própria carteira' });
    }
    const user = await repository.findTenantUser(ctx.tenantId, userId);
    if (!user || !user.isActive || !isVisitationResponsibleRole(user.role)) {
      throw invalid({ responsibleId: RESPONSIBLE_MESSAGE });
    }
  }

  /** Medico do tenant e do escopo de quem pede; senao `NOT_FOUND`. */
  async function load(ctx: TenantContext, id: string): Promise<Doctor> {
    assertVisitationRole(ctx);
    const doctor = await repository.findById(ctx.tenantId, id, portfolioOwner(ctx));
    if (!doctor) throw notFound({ resource: 'doctor', id });
    return doctor;
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
    const current = await load(ctx, id);
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
      assertVisitationRole(ctx);
      const criteria = toCriteria(query, portfolioOwner(ctx));
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
      return load(ctx, id);
    },

    async create(ctx: TenantContext, dto: CreateDoctorRequest): Promise<Doctor> {
      assertVisitationRole(ctx);
      const name = dto.name.trim();
      if (name.length === 0) throw invalid({ name: 'Informe o nome' });

      const { crm, crmUf } = resolveCrm(dto.crm, dto.crmUf);
      // Responsavel obrigatorio (D-329 item 6); o representante cadastra na propria carteira.
      const responsibleId = dto.responsibleId ?? portfolioOwner(ctx) ?? null;
      if (responsibleId === null) throw invalid({ responsibleId: 'Informe o responsável pela carteira' });
      await assertResponsible(ctx, responsibleId);
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
     * PATCH parcial. Id de outro tenant (ou de outra carteira, para o
     * representante) -> `NOT_FOUND`. O responsavel so e revalidado quando MUDA:
     * um medico cujo responsavel foi desativado continua editavel sem trocar a
     * carteira. Mas a edicao nao deixa o medico sem responsavel nem com um de
     * perfil inelegivel (D-329 item 6).
     */
    async update(ctx: TenantContext, id: string, dto: UpdateDoctorRequest): Promise<Doctor> {
      const current = await load(ctx, id);

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

      // Responsavel efetivo depois do PATCH: obrigatorio e de perfil elegivel.
      // Trocado ja foi validado acima; inalterado so precisa ter perfil elegivel
      // (inativo continua tolerado — D-255 item 9).
      if (patch.responsibleId === undefined) {
        const keptId = current.responsible?.id ?? null;
        const kept = keptId !== null ? await repository.findTenantUser(ctx.tenantId, keptId) : null;
        if (!kept || !isVisitationResponsibleRole(kept.role)) {
          throw invalid({ responsibleId: RESPONSIBLE_MESSAGE });
        }
      } else if (patch.responsibleId === null) {
        throw invalid({ responsibleId: 'Informe o responsável pela carteira' });
      }

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

    /**
     * Carteiras (D-329 item 7). O corte ABC (`abc`) so entra quando a
     * classificacao do medico existir (CRMLAB-188); ate la a chave nao vem.
     */
    async portfolios(ctx: TenantContext): Promise<ListDoctorPortfoliosResponse> {
      assertSeesAllVisitation(ctx);
      const { rows, unassigned } = await repository.portfolios(ctx.tenantId);
      return { portfolios: rows, unassigned };
    },

    /**
     * Transferencia em lote (D-329 item 8): tudo ou nada; id inexistente ou de
     * outro tenant -> `NOT_FOUND`. Audit por medico e por visita levada.
     */
    async transfer(ctx: TenantContext, dto: TransferDoctorsRequest): Promise<TransferDoctorsResponse> {
      assertSeesAllVisitation(ctx);
      const doctorIds = [...new Set(dto.doctorIds)];
      if (doctorIds.length !== dto.doctorIds.length) {
        throw invalid({ doctorIds: 'Médico repetido na lista' });
      }
      const target = await repository.findTenantUser(ctx.tenantId, dto.toUserId);
      if (!target || !target.isActive || !isVisitationResponsibleRole(target.role)) {
        throw invalid({ toUserId: RESPONSIBLE_MESSAGE });
      }

      const result = await repository.transfer(
        ctx.tenantId,
        doctorIds,
        dto.toUserId,
        dto.includeFutureVisits === true,
        now(),
      );
      if (!result) throw notFound({ resource: 'doctor' });

      for (const doctor of result.doctors) {
        await audit.record(ctx, {
          action: 'transfer_doctor',
          entityType: 'doctor',
          entityId: doctor.id,
          oldValues: { responsibleId: doctor.previousResponsibleId },
          newValues: { responsibleId: dto.toUserId, movedVisitIds: doctor.movedVisitIds },
        });
      }
      for (const visit of result.visits) {
        await audit.record(ctx, {
          action: 'transfer_visit',
          entityType: 'visit',
          entityId: visit.id,
          oldValues: { responsibleId: visit.previousResponsibleId },
          newValues: { responsibleId: dto.toUserId, doctorId: visit.doctorId },
        });
      }
      return { transferredDoctors: result.doctors.length, movedVisits: result.visits.length };
    },
  };
}
