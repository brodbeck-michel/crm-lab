/**
 * Rotas de medicos solicitantes — API_CONTRACTS.md §13 (CRMLAB-86, D-255).
 *
 *   GET   /api/v1/doctors                  lista paginada (busca, ativos, responsavel)
 *   GET   /api/v1/doctors/:id              um medico
 *   POST  /api/v1/doctors                  cadastra
 *   PATCH /api/v1/doctors/:id              edita (parcial)
 *   POST  /api/v1/doctors/:id/inactivate   inativa (idempotente)
 *   POST  /api/v1/doctors/:id/reactivate   reativa (idempotente)
 *
 * Linha do tempo do medico (CRMLAB-89, D-261):
 *
 *   GET    /api/v1/doctors/:id/timeline                         visitas + registros manuais
 *   POST   /api/v1/doctors/:id/interactions                     lanca registro manual
 *   PATCH  /api/v1/doctors/:id/interactions/:interactionId      edita (parcial)
 *   DELETE /api/v1/doctors/:id/interactions/:interactionId      exclui
 *
 * Cadastro ampliado (CRMLAB-188, D-328):
 *
 *   GET   /api/v1/doctors/specialties        lista do laboratorio (perfis da Visitacao)
 *   POST  /api/v1/doctors/specialties        cria (gestor/admin)
 *   PATCH /api/v1/doctors/specialties/:id    renomeia/inativa (gestor/admin)
 *   POST  /api/v1/doctors/abc/recalculate    recalcula a curva ABC (gestor/admin)
 *
 * Carteiras (CRMLAB-189, D-329 — gestor/admin):
 *
 *   GET   /api/v1/doctors/portfolios       medicos por responsavel
 *   POST  /api/v1/doctors/transfer         transferencia em lote
 *
 * TODAS exigem representante, gestor ou admin (D-329; a atendente recebe 403).
 * O representante so alcanca a propria carteira (o service recorta; fora -> 404).
 * NAO existe DELETE: a agenda de visitas (CRMLAB-85) vai referenciar o medico.
 *
 * Controller fino (CONVENTIONS.md): valida o DTO, chama o service, responde.
 * `tenantId` vem SEMPRE de `getContext(req)` — nunca de query/body/header.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  DOCTOR_ABC_CLASSES,
  DOCTOR_INTERACTION_DESCRIPTION_MAX_LENGTH,
  DOCTOR_INTERACTION_TYPES,
  DOCTOR_SPECIALTY_NAME_MAX_LENGTH,
  DOCTOR_TIMELINE_MAX_LIMIT,
  DOCTOR_VISIT_HOURS_MAX,
  isValidTimeHHMM,
  DOCTOR_LOOKUP_DEFAULT_LIMIT,
  DOCTOR_LOOKUP_MAX_LIMIT,
  DOCTOR_TRANSFER_MAX,
  TENANT_USER_ROLES,
  VISITATION_ROLES,
  type CreateDoctorInteractionRequest,
  type CreateDoctorRequest,
  type CreateDoctorSpecialtyRequest,
  type Doctor,
  type DoctorAbcRecalculation,
  type DoctorSpecialty,
  type ListDoctorSpecialtiesQuery,
  type ListDoctorSpecialtiesResponse,
  type UpdateDoctorSpecialtyRequest,
  type DoctorInteraction,
  type DoctorTimelineQuery,
  type DoctorTimelineResponse,
  type DoctorLookupQuery,
  type DoctorLookupResponse,
  type ListDoctorPortfoliosResponse,
  type ListDoctorsQuery,
  type ListDoctorsResponse,
  type TransferDoctorsRequest,
  type TransferDoctorsResponse,
  type UpdateDoctorInteractionRequest,
  type UpdateDoctorRequest,
} from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { createAuditService } from '../services/audit.service.js';
import { createDoctorAbcService, type DoctorAbcService } from '../services/doctor-abc.service.js';
import {
  createDoctorSpecialtyService,
  type DoctorSpecialtyService,
} from '../services/doctor-specialty.service.js';
import {
  createDoctorInteractionService,
  type DoctorInteractionService,
} from '../services/doctor-interaction.service.js';
import { createDoctorService, MAX_LIMIT, type DoctorService } from '../services/doctor.service.js';

/** `?active=true` chega como string; no JSON de teste pode chegar como boolean. */
const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => (typeof value === 'boolean' ? value : value === 'true' || value === '1'));

/** String de filtro: vazia (`?search=`) vale como ausente, nao como erro. */
const optionalFilter = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
    });

/**
 * Texto opcional do cadastro: string (vazia limpa) ou `null`. A normalizacao
 * (trim, vazio -> null, CRM so digitos, UF maiuscula) e do service, que e quem
 * tambem valida o PAR CRM/UF.
 */
const optionalText = (max: number) => z.string().max(max).nullable().optional();

/** E-mail opcional: vazio vale como "sem e-mail"; preenchido tem de ser e-mail. */
const optionalEmail = z
  .string()
  .max(255)
  .nullable()
  .optional()
  .refine((value) => value === undefined || value === null || value.trim() === '' || z.string().email().safeParse(value.trim()).success, {
    message: 'E-mail inválido',
  });

/** Busca do formulario de proposta (D-329 item 12). */
export const doctorLookupQuerySchema = z.object({
  search: z.string().trim().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(DOCTOR_LOOKUP_MAX_LIMIT).default(DOCTOR_LOOKUP_DEFAULT_LIMIT),
});

export const listDoctorsQuerySchema = z.object({
  search: optionalFilter(120),
  active: booleanish.optional(),
  responsibleId: z.uuid().optional(),
  specialtyId: z.uuid().optional(),
  abcClass: z.enum(DOCTOR_ABC_CLASSES).optional(),
  unassigned: booleanish.optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  sortBy: z.enum(['name', 'createdAt', 'updatedAt']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

/** Dia/mes/ano de aniversario: o par e a data possivel sao do service. */
const optionalInt = (min: number, max: number) => z.number().int().min(min).max(max).nullable().optional();

const visitHoursEntry = z
  .object({
    // 0 = domingo ... 6 = sabado (`Weekday`); repeticao e ordem sao do service.
    weekdays: z.array(z.number().int().min(0).max(6)).max(7),
    start: z.string().refine(isValidTimeHHMM, { message: 'Horário HH:MM' }),
    end: z.string().refine(isValidTimeHHMM, { message: 'Horário HH:MM' }),
  })
  .strict();

const doctorFields = {
  crm: optionalText(20),
  // Folga para espaco em volta (" sc"): o service normaliza e valida contra as 27 UFs.
  crmUf: optionalText(10),
  specialtyId: z.uuid().nullable().optional(),
  birthDay: optionalInt(1, 31),
  birthMonth: optionalInt(1, 12),
  birthYear: optionalInt(1, 9999),
  clinic: optionalText(255),
  acceptsPrivate: z.boolean().nullable().optional(),
  monthlyConsultations: optionalInt(0, 100_000),
  monthlyPrivateConsultations: optionalInt(0, 100_000),
  consultationFee: z.number().finite().nullable().optional(),
  visitHours: z.array(visitHoursEntry).max(DOCTOR_VISIT_HOURS_MAX).nullable().optional(),
  visitPreference: optionalText(255),
  isPartner: z.boolean().optional(),
  partnerSince: z.iso.date().nullable().optional(),
  partnershipNotes: optionalText(2000),
  addressZip: optionalText(20),
  addressStreet: optionalText(255),
  addressNumber: optionalText(20),
  addressComplement: optionalText(120),
  addressDistrict: optionalText(120),
  addressCity: optionalText(120),
  addressState: optionalText(10),
  address: optionalText(500),
  phone: optionalText(30),
  email: optionalEmail,
  secretaryName: optionalText(255),
  secretaryBirthDay: optionalInt(1, 31),
  secretaryBirthMonth: optionalInt(1, 12),
  secretaryBirthYear: optionalInt(1, 9999),
  secretaryPhone: optionalText(30),
  secretaryNotes: optionalText(2000),
  notes: optionalText(2000),
  responsibleId: z.uuid().nullable().optional(),
};

// --- especialidades (CRMLAB-188, D-328) ---

export const listDoctorSpecialtiesQuerySchema = z.object({ active: booleanish.optional() });

export const createDoctorSpecialtySchema = z
  .object({ name: z.string().trim().min(1).max(DOCTOR_SPECIALTY_NAME_MAX_LENGTH) })
  .strict();

export const updateDoctorSpecialtySchema = z
  .object({
    name: z.string().trim().min(1).max(DOCTOR_SPECIALTY_NAME_MAX_LENGTH).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const createDoctorSchema = z
  .object({ name: z.string().trim().min(1).max(255), ...doctorFields })
  .strict();

/** `.strict()`: `isActive` aqui seria ignorado em silencio — melhor recusar e apontar a rota certa. */
export const updateDoctorSchema = z
  .object({ name: z.string().trim().min(1).max(255).optional(), ...doctorFields })
  .strict();

export const doctorIdParamSchema = z.object({ id: z.uuid() });

/** Repeticao de id e regra do service (mensagem propria). */
export const transferDoctorsSchema = z
  .object({
    doctorIds: z.array(z.uuid()).min(1).max(DOCTOR_TRANSFER_MAX),
    toUserId: z.uuid(),
    includeFutureVisits: z.boolean().optional(),
  })
  .strict();

// --- linha do tempo (CRMLAB-89, D-261) ---

export const doctorTimelineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(DOCTOR_TIMELINE_MAX_LIMIT).optional(),
  // Opaco (base64url); o service decodifica e recusa o que nao reconhece.
  cursor: z.string().min(1).max(200).optional(),
});

/** A regra de "nao no futuro" e o trim da descricao sao do service. */
const interactionFields = {
  type: z.enum(DOCTOR_INTERACTION_TYPES),
  occurredAt: z.iso.datetime({ offset: true }),
  // Folga para espaco em volta: o service corta e confere o teto de novo.
  description: z.string().max(DOCTOR_INTERACTION_DESCRIPTION_MAX_LENGTH + 100),
};

export const createDoctorInteractionSchema = z.object(interactionFields).strict();
export const updateDoctorInteractionSchema = z.object(interactionFields).partial().strict();

export const doctorInteractionParamsSchema = z.object({
  id: z.uuid(),
  interactionId: z.uuid(),
});


/** Monta service a partir das dependencias do kernel. */
export function createDoctorServiceFromDeps(deps: ApiModuleDeps): DoctorService {
  return createDoctorService({ db: deps.db, audit: createAuditService(deps.db) });
}

export function createDoctorInteractionServiceFromDeps(deps: ApiModuleDeps): DoctorInteractionService {
  return createDoctorInteractionService({ db: deps.db, audit: createAuditService(deps.db) });
}

export function createDoctorSpecialtyServiceFromDeps(deps: ApiModuleDeps): DoctorSpecialtyService {
  return createDoctorSpecialtyService({ db: deps.db, audit: createAuditService(deps.db) });
}

export function createDoctorAbcServiceFromDeps(deps: Pick<ApiModuleDeps, 'db'>): DoctorAbcService {
  return createDoctorAbcService({ db: deps.db, audit: createAuditService(deps.db) });
}

/** `Promise` rejeitada em handler async precisa chegar no error-handler. */
function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function listDoctors(service: DoctorService): RequestHandler {
  return handle(async (req, res) => {
    const query = validated<ListDoctorsQuery>(req, 'query');
    const body: ListDoctorsResponse = await service.list(getContext(req), query);
    res.status(200).json(body);
  });
}

export function getDoctor(service: DoctorService): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    const body: Doctor = await service.getById(getContext(req), id);
    res.status(200).json(body);
  });
}

export function createDoctor(service: DoctorService): RequestHandler {
  return handle(async (req, res) => {
    const dto = validated<CreateDoctorRequest>(req, 'body');
    const body: Doctor = await service.create(getContext(req), dto);
    res.status(201).json(body);
  });
}

export function updateDoctor(service: DoctorService): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<UpdateDoctorRequest>(req, 'body');
    const body: Doctor = await service.update(getContext(req), id, dto);
    res.status(200).json(body);
  });
}

export function setDoctorActive(service: DoctorService, isActive: boolean): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    const ctx = getContext(req);
    const body: Doctor = isActive ? await service.reactivate(ctx, id) : await service.inactivate(ctx, id);
    res.status(200).json(body);
  });
}

export function lookupDoctors(service: DoctorService): RequestHandler {
  return handle(async (req, res) => {
    const query = validated<DoctorLookupQuery>(req, 'query');
    const body: DoctorLookupResponse = await service.lookup(getContext(req), query);
    res.status(200).json(body);
  });
}

export function listDoctorPortfolios(service: DoctorService): RequestHandler {
  return handle(async (req, res) => {
    const body: ListDoctorPortfoliosResponse = await service.portfolios(getContext(req));
    res.status(200).json(body);
  });
}

export function transferDoctors(service: DoctorService): RequestHandler {
  return handle(async (req, res) => {
    const dto = validated<TransferDoctorsRequest>(req, 'body');
    const body: TransferDoctorsResponse = await service.transfer(getContext(req), dto);
    res.status(200).json(body);
  });
}

export function getDoctorTimeline(service: DoctorInteractionService): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    const query = validated<DoctorTimelineQuery>(req, 'query');
    const body: DoctorTimelineResponse = await service.timeline(getContext(req), id, query);
    res.status(200).json(body);
  });
}

export function createDoctorInteraction(service: DoctorInteractionService): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<CreateDoctorInteractionRequest>(req, 'body');
    const body: DoctorInteraction = await service.create(getContext(req), id, dto);
    res.status(201).json(body);
  });
}

export function updateDoctorInteraction(service: DoctorInteractionService): RequestHandler {
  return handle(async (req, res) => {
    const { id, interactionId } = validated<{ id: string; interactionId: string }>(req, 'params');
    const dto = validated<UpdateDoctorInteractionRequest>(req, 'body');
    const body: DoctorInteraction = await service.update(getContext(req), id, interactionId, dto);
    res.status(200).json(body);
  });
}

export function deleteDoctorInteraction(service: DoctorInteractionService): RequestHandler {
  return handle(async (req, res) => {
    const { id, interactionId } = validated<{ id: string; interactionId: string }>(req, 'params');
    await service.delete(getContext(req), id, interactionId);
    res.status(204).end();
  });
}

export function listDoctorSpecialties(service: DoctorSpecialtyService): RequestHandler {
  return handle(async (req, res) => {
    const query = validated<ListDoctorSpecialtiesQuery>(req, 'query');
    const body: ListDoctorSpecialtiesResponse = await service.list(getContext(req), query);
    res.status(200).json(body);
  });
}

export function createDoctorSpecialty(service: DoctorSpecialtyService): RequestHandler {
  return handle(async (req, res) => {
    const dto = validated<CreateDoctorSpecialtyRequest>(req, 'body');
    const body: DoctorSpecialty = await service.create(getContext(req), dto);
    res.status(201).json(body);
  });
}

export function updateDoctorSpecialty(service: DoctorSpecialtyService): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<UpdateDoctorSpecialtyRequest>(req, 'body');
    const body: DoctorSpecialty = await service.update(getContext(req), id, dto);
    res.status(200).json(body);
  });
}

export function recalculateDoctorAbc(service: DoctorAbcService): RequestHandler {
  return handle(async (req, res) => {
    const body: DoctorAbcRecalculation = await service.recalculate(getContext(req));
    res.status(200).json(body);
  });
}

export function doctorModule(deps: ApiModuleDeps): ApiModule {
  const service = createDoctorServiceFromDeps(deps);
  const interactions = createDoctorInteractionServiceFromDeps(deps);
  const specialties = createDoctorSpecialtyServiceFromDeps(deps);
  const abc = createDoctorAbcServiceFromDeps(deps);
  const router = Router();
  // D-329: representante, gestor e admin (a atendente recebe 403 por perfil). O
  // operador da plataforma fica de fora antes (PAGES.md §11). O recorte por
  // carteira do representante e do service (fora dela -> 404).
  const guards = [requireAuth(), denyPlatformOperator(), requireRoles(...VISITATION_ROLES)];
  const managerGuards = [requireAuth(), denyPlatformOperator(), requireRoles('manager', 'admin')];
  const idParam = validate(doctorIdParamSchema, 'params');
  // Lista de especialidades e recalculo da curva ABC: gestor/admin (D-328).
  // ANTES de `/:id`, senao `specialties`/`abc` cairiam na validacao de uuid.
  const managers = [...guards, requireRoles('manager', 'admin')];

  router.get(
    '/specialties',
    ...guards,
    validate(listDoctorSpecialtiesQuerySchema, 'query'),
    listDoctorSpecialties(specialties),
  );
  router.post(
    '/specialties',
    ...managers,
    validate(createDoctorSpecialtySchema, 'body'),
    createDoctorSpecialty(specialties),
  );
  router.patch(
    '/specialties/:id',
    ...managers,
    idParam,
    validate(updateDoctorSpecialtySchema, 'body'),
    updateDoctorSpecialty(specialties),
  );
  router.post('/abc/recalculate', ...managers, recalculateDoctorAbc(abc));

  // Busca do formulario de proposta (D-329 item 12): todo papel do laboratorio,
  // inclusive a atendente; sem recorte de carteira. Antes de `/:id`.
  router.get(
    '/lookup',
    requireAuth(),
    denyPlatformOperator(),
    requireRoles(...TENANT_USER_ROLES),
    validate(doctorLookupQuerySchema, 'query'),
    lookupDoctors(service),
  );

  // Antes de `/:id`: senao "portfolios" cairia no validador de uuid.
  router.get('/portfolios', ...managerGuards, listDoctorPortfolios(service));
  router.post('/transfer', ...managerGuards, validate(transferDoctorsSchema, 'body'), transferDoctors(service));

  router.get('/', ...guards, validate(listDoctorsQuerySchema, 'query'), listDoctors(service));
  router.post('/', ...guards, validate(createDoctorSchema, 'body'), createDoctor(service));
  router.get('/:id', ...guards, idParam, getDoctor(service));
  router.patch('/:id', ...guards, idParam, validate(updateDoctorSchema, 'body'), updateDoctor(service));
  router.post('/:id/inactivate', ...guards, idParam, setDoctorActive(service, false));
  router.post('/:id/reactivate', ...guards, idParam, setDoctorActive(service, true));

  // Linha do tempo (CRMLAB-89, D-261): mesmos guardas; representante so na carteira (D-329).
  const interactionParams = validate(doctorInteractionParamsSchema, 'params');
  router.get('/:id/timeline', ...guards, idParam, validate(doctorTimelineQuerySchema, 'query'), getDoctorTimeline(interactions));
  router.post(
    '/:id/interactions',
    ...guards,
    idParam,
    validate(createDoctorInteractionSchema, 'body'),
    createDoctorInteraction(interactions),
  );
  router.patch(
    '/:id/interactions/:interactionId',
    ...guards,
    interactionParams,
    validate(updateDoctorInteractionSchema, 'body'),
    updateDoctorInteraction(interactions),
  );
  router.delete('/:id/interactions/:interactionId', ...guards, interactionParams, deleteDoctorInteraction(interactions));

  return { basePath: '/doctors', router, requiresAuth: true };
}
