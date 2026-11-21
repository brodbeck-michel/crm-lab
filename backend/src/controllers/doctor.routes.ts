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
  DOCTOR_INTERACTION_DESCRIPTION_MAX_LENGTH,
  DOCTOR_INTERACTION_TYPES,
  DOCTOR_TIMELINE_MAX_LIMIT,
  DOCTOR_TRANSFER_MAX,
  VISITATION_ROLES,
  type CreateDoctorInteractionRequest,
  type Doctor,
  type DoctorInteraction,
  type DoctorTimelineQuery,
  type DoctorTimelineResponse,
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

export const listDoctorsQuerySchema = z.object({
  search: optionalFilter(120),
  active: booleanish.optional(),
  responsibleId: z.uuid().optional(),
  unassigned: booleanish.optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  sortBy: z.enum(['name', 'createdAt', 'updatedAt']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

const doctorFields = {
  crm: optionalText(20),
  // Folga para espaco em volta (" sc"): o service normaliza e valida contra as 27 UFs.
  crmUf: optionalText(10),
  specialty: optionalText(120),
  clinic: optionalText(255),
  address: optionalText(500),
  phone: optionalText(30),
  email: optionalEmail,
  contactName: optionalText(255),
  visitPreference: optionalText(255),
  notes: optionalText(2000),
  responsibleId: z.uuid().nullable().optional(),
};

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

type CreateDoctorBody = z.infer<typeof createDoctorSchema>;

/** Monta service a partir das dependencias do kernel. */
export function createDoctorServiceFromDeps(deps: ApiModuleDeps): DoctorService {
  return createDoctorService({ db: deps.db, audit: createAuditService(deps.db) });
}

export function createDoctorInteractionServiceFromDeps(deps: ApiModuleDeps): DoctorInteractionService {
  return createDoctorInteractionService({ db: deps.db, audit: createAuditService(deps.db) });
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
    const dto = validated<CreateDoctorBody>(req, 'body');
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

export function doctorModule(deps: ApiModuleDeps): ApiModule {
  const service = createDoctorServiceFromDeps(deps);
  const interactions = createDoctorInteractionServiceFromDeps(deps);
  const router = Router();
  // D-329: representante, gestor e admin (a atendente recebe 403 por perfil). O
  // operador da plataforma fica de fora antes (PAGES.md §11). O recorte por
  // carteira do representante e do service (fora dela -> 404).
  const guards = [requireAuth(), denyPlatformOperator(), requireRoles(...VISITATION_ROLES)];
  const managerGuards = [requireAuth(), denyPlatformOperator(), requireRoles('manager', 'admin')];
  const idParam = validate(doctorIdParamSchema, 'params');

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
