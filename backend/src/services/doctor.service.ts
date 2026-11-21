/**
 * DoctorService — SERVICES.md §30 (CRMLAB-86, D-255 · ampliado no CRMLAB-188, D-328).
 *
 * Dono da tabela `doctors`: o cadastro de medicos solicitantes que o epico
 * Visitacao Medica (CRMLAB-85) usa como base.
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
 *
 * Cadastro ampliado (D-328): especialidade ATIVA da lista do laboratorio,
 * aniversario, clinica, horario estruturado, parceria, endereco estruturado e
 * secretaria. Regras que olham MAIS DE UM campo (aniversario, particulares <=
 * total) sao conferidas no estado DEPOIS do merge com o gravado. Escrita
 * dupla nas colunas antigas: `specialty` <- nome da especialidade,
 * `contact_name` <- `secretaryName`. A curva ABC nao passa por aqui.
 */
import {
  BIRTH_YEAR_MIN,
  DOCTOR_CRM_MAX_DIGITS,
  DOCTOR_LOOKUP_DEFAULT_LIMIT,
  isBrazilUf,
  isValidBirthday,
  normalizeCep,
  isVisitationResponsibleRole,
  normalizeCrm,
  normalizeUf,
  saoPauloToday,
  type CreateDoctorRequest,
  type Doctor,
  type DoctorCrmConflictDetails,
  type DoctorVisitHours,
  type DoctorLookupQuery,
  type DoctorLookupResponse,
  type ListDoctorPortfoliosResponse,
  type ListDoctorsQuery,
  type ListDoctorsResponse,
  type TransferDoctorsRequest,
  type TransferDoctorsResponse,
  type UpdateDoctorRequest,
  type Weekday,
} from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError, notFound } from '../http/errors.js';
import { DoctorSpecialtyRepository } from '../repositories/doctor-specialty.repository.js';
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
/** Teto do valor da consulta (`NUMERIC(10,2)`). */
export const MAX_CONSULTATION_FEE = 99_999_999.99;

/** Campos de texto livre opcionais: vazio vira `null`. */
const TEXT_FIELDS = [
  'clinic',
  'address',
  'phone',
  'email',
  'visitPreference',
  'partnershipNotes',
  'addressStreet',
  'addressNumber',
  'addressComplement',
  'addressDistrict',
  'addressCity',
  'secretaryName',
  'secretaryPhone',
  'secretaryNotes',
  'notes',
] as const;

/** Campos copiados como vieram (o zod da rota ja garantiu o tipo). */
const PLAIN_FIELDS = [
  'birthDay',
  'birthMonth',
  'birthYear',
  'acceptsPrivate',
  'monthlyConsultations',
  'monthlyPrivateConsultations',
  'secretaryBirthDay',
  'secretaryBirthMonth',
  'secretaryBirthYear',
] as const;

/** Colunas antigas da escrita dupla: gravadas, mas fora do audit (D-328). */
const LEGACY_MIRRORS: ReadonlyArray<keyof DoctorPatch> = ['specialty', 'contactName'];

export interface DoctorService {
  list(ctx: TenantContext, query: ListDoctorsQuery): Promise<ListDoctorsResponse>;
  getById(ctx: TenantContext, id: string): Promise<Doctor>;
  create(ctx: TenantContext, dto: CreateDoctorRequest): Promise<Doctor>;
  update(ctx: TenantContext, id: string, dto: UpdateDoctorRequest): Promise<Doctor>;
  inactivate(ctx: TenantContext, id: string): Promise<Doctor>;
  reactivate(ctx: TenantContext, id: string): Promise<Doctor>;
  /** Carteiras por responsavel (gestor/admin — D-329 item 7). */
  /** Busca do formulario de proposta: todo papel, sem carteira, so ativos (D-329 item 12). */
  lookup(ctx: TenantContext, query: DoctorLookupQuery): Promise<DoctorLookupResponse>;
  portfolios(ctx: TenantContext): Promise<ListDoctorPortfoliosResponse>;
  /** Transferencia em lote (gestor/admin — D-329 item 8). */
  transfer(ctx: TenantContext, dto: TransferDoctorsRequest): Promise<TransferDoctorsResponse>;
}

export interface DoctorServiceDeps {
  db: DbClient;
  audit: AuditService;
  /** Relogio injetavel (ano de nascimento / data de parceria "no futuro"; "visita futura" da transferencia). */
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
    specialtyId: query.specialtyId,
    abcClass: query.abcClass,
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
  const left = a ?? null;
  const right = b ?? null;
  if (typeof left === 'object' || typeof right === 'object') {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return left === right;
}

/** Faixas de horario: dias sem repeticao e ordenados, `start < end`. */
function normalizeVisitHours(
  value: DoctorVisitHours[] | null,
  errors: Record<string, string>,
): DoctorVisitHours[] {
  if (value === null) return [];
  const result: DoctorVisitHours[] = [];
  for (const entry of value) {
    const weekdays = [...new Set(entry.weekdays)].sort((a, b) => a - b) as Weekday[];
    if (weekdays.length === 0) {
      errors.visitHours = 'Escolha ao menos um dia em cada faixa';
      continue;
    }
    if (entry.start >= entry.end) {
      errors.visitHours = 'O início tem de ser antes do fim';
      continue;
    }
    result.push({ weekdays, start: entry.start, end: entry.end });
  }
  return result;
}

/** Valor com no maximo 2 casas (dinheiro no fio, regra 9). */
function hasAtMostTwoDecimals(value: number): boolean {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

/** Os campos gravaveis vistos a partir do `Doctor` atual — base do merge no PATCH. */
function currentFields(doctor: Doctor): DoctorFields {
  return {
    name: doctor.name,
    crm: doctor.crm,
    crmUf: doctor.crmUf,
    specialtyId: doctor.specialtyId,
    specialty: doctor.specialty,
    birthDay: doctor.birthDay,
    birthMonth: doctor.birthMonth,
    birthYear: doctor.birthYear,
    clinic: doctor.clinic,
    acceptsPrivate: doctor.acceptsPrivate,
    monthlyConsultations: doctor.monthlyConsultations,
    monthlyPrivateConsultations: doctor.monthlyPrivateConsultations,
    consultationFee: doctor.consultationFee,
    visitHours: doctor.visitHours,
    visitPreference: doctor.visitPreference,
    isPartner: doctor.isPartner,
    partnerSince: doctor.partnerSince,
    partnershipNotes: doctor.partnershipNotes,
    addressZip: doctor.addressZip,
    addressStreet: doctor.addressStreet,
    addressNumber: doctor.addressNumber,
    addressComplement: doctor.addressComplement,
    addressDistrict: doctor.addressDistrict,
    addressCity: doctor.addressCity,
    addressState: doctor.addressState,
    address: doctor.address,
    phone: doctor.phone,
    email: doctor.email,
    secretaryName: doctor.secretaryName,
    secretaryBirthDay: doctor.secretaryBirthDay,
    secretaryBirthMonth: doctor.secretaryBirthMonth,
    secretaryBirthYear: doctor.secretaryBirthYear,
    secretaryPhone: doctor.secretaryPhone,
    secretaryNotes: doctor.secretaryNotes,
    contactName: doctor.contactName,
    notes: doctor.notes,
    responsibleId: doctor.responsible?.id ?? null,
  };
}

/** Campos vazios de um cadastro novo. */
function emptyFields(name: string): DoctorFields {
  return {
    name,
    crm: null,
    crmUf: null,
    specialtyId: null,
    specialty: null,
    birthDay: null,
    birthMonth: null,
    birthYear: null,
    clinic: null,
    acceptsPrivate: null,
    monthlyConsultations: null,
    monthlyPrivateConsultations: null,
    consultationFee: null,
    visitHours: [],
    visitPreference: null,
    isPartner: false,
    partnerSince: null,
    partnershipNotes: null,
    addressZip: null,
    addressStreet: null,
    addressNumber: null,
    addressComplement: null,
    addressDistrict: null,
    addressCity: null,
    addressState: null,
    address: null,
    phone: null,
    email: null,
    secretaryName: null,
    secretaryBirthDay: null,
    secretaryBirthMonth: null,
    secretaryBirthYear: null,
    secretaryPhone: null,
    secretaryNotes: null,
    contactName: null,
    notes: null,
    responsibleId: null,
  };
}

/** Visao "plana" do medico para o diff do audit (responsavel por id; sem os espelhos antigos). */
function auditView(doctor: Doctor): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...currentFields(doctor) };
  for (const key of LEGACY_MIRRORS) delete fields[key];
  return fields;
}

export function createDoctorService(deps: DoctorServiceDeps): DoctorService {
  const repository = new DoctorRepository(deps.db);
  const specialties = new DoctorSpecialtyRepository(deps.db);
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

  /** Especialidade ATIVA do laboratorio; devolve o nome (escrita dupla). */
  async function specialtyName(ctx: TenantContext, specialtyId: string): Promise<string> {
    const specialty = await specialties.findById(ctx.tenantId, specialtyId);
    if (!specialty || !specialty.isActive) {
      throw invalid({ specialtyId: 'Especialidade inexistente ou inativa neste laboratório' });
    }
    return specialty.name;
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

  /**
   * Normaliza campo a campo o que veio no corpo (so as chaves presentes). Nao
   * trata nome, CRM/UF, especialidade nem responsavel (que pedem banco/par).
   */
  function normalizeInput(dto: UpdateDoctorRequest, errors: Record<string, string>): DoctorPatch {
    const patch: DoctorPatch = {};

    for (const field of TEXT_FIELDS) {
      const value = cleanText(dto[field]);
      if (value !== undefined) patch[field] = value;
    }
    for (const field of PLAIN_FIELDS) {
      const value = dto[field];
      // Cada chave de PLAIN_FIELDS tem o mesmo tipo no DTO e no patch.
      if (value !== undefined) Object.assign(patch, { [field]: value });
    }
    if (dto.isPartner !== undefined) patch.isPartner = dto.isPartner;

    if (dto.consultationFee !== undefined) {
      const fee = dto.consultationFee;
      if (fee !== null && (fee < 0 || fee > MAX_CONSULTATION_FEE || !hasAtMostTwoDecimals(fee))) {
        errors.consultationFee = 'Valor inválido (até 2 casas decimais)';
      } else {
        patch.consultationFee = fee;
      }
    }

    if (dto.visitHours !== undefined) {
      patch.visitHours = normalizeVisitHours(dto.visitHours, errors);
    }

    if (dto.partnerSince !== undefined) {
      const since = dto.partnerSince;
      if (since !== null && since > saoPauloToday(now())) {
        errors.partnerSince = 'A data não pode ser no futuro';
      } else {
        patch.partnerSince = since;
      }
    }

    if (dto.addressZip !== undefined) {
      const raw = cleanText(dto.addressZip);
      if (raw === null || raw === undefined) {
        patch.addressZip = null;
      } else {
        const cep = normalizeCep(raw);
        if (cep === null) errors.addressZip = 'CEP com 8 dígitos';
        else patch.addressZip = cep;
      }
    }

    if (dto.addressState !== undefined) {
      const uf = normalizeUf(dto.addressState);
      if (uf !== null && !isBrazilUf(uf)) errors.addressState = 'UF inválida';
      else patch.addressState = uf;
    }

    // Escrita dupla: a coluna antiga acompanha o nome da secretaria.
    if (patch.secretaryName !== undefined) patch.contactName = patch.secretaryName;

    return patch;
  }

  /** Aniversario com dia/mes juntos, data possivel e ano plausivel. */
  function checkBirthday(
    day: number | null,
    month: number | null,
    year: number | null,
    keys: { day: string; year: string },
    errors: Record<string, string>,
  ): void {
    if ((day === null) !== (month === null)) {
      errors[keys.day] = 'Informe dia e mês juntos';
      return;
    }
    if (day === null || month === null) {
      if (year !== null) errors[keys.year] = 'Ano só com dia e mês';
      return;
    }
    const currentYear = Number(saoPauloToday(now()).slice(0, 4));
    if (year !== null && (year < BIRTH_YEAR_MIN || year > currentYear)) {
      errors[keys.year] = 'Ano inválido';
      return;
    }
    if (!isValidBirthday(day, month, year)) errors[keys.day] = 'Data inválida';
  }

  /** Regras entre campos, sobre o estado final (depois do merge). */
  function checkEffective(effective: DoctorFields, errors: Record<string, string>): void {
    checkBirthday(
      effective.birthDay,
      effective.birthMonth,
      effective.birthYear,
      { day: 'birthDay', year: 'birthYear' },
      errors,
    );
    checkBirthday(
      effective.secretaryBirthDay,
      effective.secretaryBirthMonth,
      effective.secretaryBirthYear,
      { day: 'secretaryBirthDay', year: 'secretaryBirthYear' },
      errors,
    );
    const total = effective.monthlyConsultations;
    const privateCount = effective.monthlyPrivateConsultations;
    if (total !== null && privateCount !== null && privateCount > total) {
      errors.monthlyPrivateConsultations = 'Particulares não pode passar do total';
    } else if (effective.acceptsPrivate === false && privateCount !== null && privateCount > 0) {
      errors.monthlyPrivateConsultations = 'Médico não atende particular';
    }
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
      const errors: Record<string, string> = {};
      const fields: DoctorFields = { ...emptyFields(name), crm, crmUf, ...normalizeInput(dto, errors) };
      checkEffective(fields, errors);
      if (Object.keys(errors).length > 0) throw invalid(errors);

      if (dto.specialtyId !== undefined && dto.specialtyId !== null) {
        fields.specialtyId = dto.specialtyId;
        fields.specialty = await specialtyName(ctx, dto.specialtyId);
      }
      // Responsavel obrigatorio (D-329 item 6); o representante cadastra na propria carteira.
      const responsibleId = dto.responsibleId ?? portfolioOwner(ctx) ?? null;
      if (responsibleId === null) throw invalid({ responsibleId: 'Informe o responsável pela carteira' });
      await assertResponsible(ctx, responsibleId);
      fields.responsibleId = responsibleId;
      await assertCrmFree(ctx, crm, crmUf);

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
     * representante) -> `NOT_FOUND`. O responsavel e a especialidade so sao
     * revalidados quando MUDAM: um medico cujo responsavel foi desativado (ou
     * cuja especialidade foi inativada) continua editavel sem trocar. Mas a
     * edicao nao deixa o medico sem responsavel nem com um de perfil
     * inelegivel (D-329 item 6).
     */
    async update(ctx: TenantContext, id: string, dto: UpdateDoctorRequest): Promise<Doctor> {
      const current = await load(ctx, id);

      const errors: Record<string, string> = {};
      const patch: DoctorPatch = normalizeInput(dto, errors);

      if (dto.name !== undefined) {
        const name = dto.name.trim();
        if (name.length === 0) throw invalid({ name: 'Informe o nome' });
        patch.name = name;
      }

      // CRM/UF efetivos depois do PATCH (o par e validado junto, com o atual).
      let effectiveCrm = { crm: current.crm, crmUf: current.crmUf };
      if (dto.crm !== undefined || dto.crmUf !== undefined) {
        effectiveCrm = resolveCrm(dto.crm, dto.crmUf, current);
        patch.crm = effectiveCrm.crm;
        patch.crmUf = effectiveCrm.crmUf;
      }

      checkEffective({ ...currentFields(current), ...patch } as DoctorFields, errors);
      if (Object.keys(errors).length > 0) throw invalid(errors);

      if (dto.specialtyId !== undefined && dto.specialtyId !== current.specialtyId) {
        patch.specialtyId = dto.specialtyId;
        patch.specialty = dto.specialtyId === null ? null : await specialtyName(ctx, dto.specialtyId);
      }

      if (dto.responsibleId !== undefined) {
        const responsibleId = dto.responsibleId;
        if (responsibleId !== null && responsibleId !== current.responsible?.id) {
          await assertResponsible(ctx, responsibleId);
        }
        patch.responsibleId = responsibleId;
      }

      // So o que mudou de fato vai para o UPDATE e para o audit.
      const before: Record<string, unknown> = { ...currentFields(current) };
      const oldValues: Record<string, unknown> = {};
      const newValues: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch) as Array<[keyof DoctorPatch, unknown]>) {
        if (sameValue(before[key], value)) {
          delete patch[key];
          continue;
        }
        if (LEGACY_MIRRORS.includes(key)) continue;
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
        await assertCrmFree(ctx, effectiveCrm.crm, effectiveCrm.crmUf, id);
      }

      let updated: Doctor | null;
      try {
        updated = await repository.update(ctx.tenantId, id, patch);
      } catch (err) {
        if (isUniqueViolation(err) && effectiveCrm.crm !== null && effectiveCrm.crmUf !== null) {
          throw await raceConflict(ctx, effectiveCrm.crm, effectiveCrm.crmUf);
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
     * Busca do formulario de proposta (D-329 item 12). Sem `assertVisitationRole`
     * e sem `ownerId`: a atendente vincula qualquer medico ativo do laboratorio.
     * Devolve so o minimo (nada de contato, carteira ou ABC).
     */
    async lookup(ctx: TenantContext, query: DoctorLookupQuery): Promise<DoctorLookupResponse> {
      const page = await repository.list(ctx.tenantId, {
        search: query.search,
        active: true,
        page: 1,
        limit: query.limit ?? DOCTOR_LOOKUP_DEFAULT_LIMIT,
        sortBy: 'name',
        order: 'asc',
      });
      return {
        doctors: page.rows.map((d) => ({
          id: d.id,
          name: d.name,
          crm: d.crm,
          crmUf: d.crmUf,
          specialty: d.specialty,
        })),
      };
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
