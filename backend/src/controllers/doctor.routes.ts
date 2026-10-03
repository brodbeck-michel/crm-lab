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
 * TODAS para qualquer papel de laboratorio (D-255 item 3: sem perfil novo).
 * NAO existe DELETE: a agenda de visitas (CRMLAB-85) vai referenciar o medico.
 *
 * Controller fino (CONVENTIONS.md): valida o DTO, chama o service, responde.
 * `tenantId` vem SEMPRE de `getContext(req)` — nunca de query/body/header.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { Doctor, ListDoctorsQuery, ListDoctorsResponse, UpdateDoctorRequest } from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { createAuditService } from '../services/audit.service.js';
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
  responsibleId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  sortBy: z.enum(['name', 'createdAt', 'updatedAt']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

const doctorFields = {
  crm: optionalText(20),
  crmUf: optionalText(2),
  specialty: optionalText(120),
  clinic: optionalText(255),
  address: optionalText(500),
  phone: optionalText(30),
  email: optionalEmail,
  contactName: optionalText(255),
  visitPreference: optionalText(255),
  notes: optionalText(2000),
  responsibleId: z.string().uuid().nullable().optional(),
};

export const createDoctorSchema = z
  .object({ name: z.string().trim().min(1).max(255), ...doctorFields })
  .strict();

/** `.strict()`: `isActive` aqui seria ignorado em silencio — melhor recusar e apontar a rota certa. */
export const updateDoctorSchema = z
  .object({ name: z.string().trim().min(1).max(255).optional(), ...doctorFields })
  .strict();

export const doctorIdParamSchema = z.object({ id: z.string().uuid() });

type CreateDoctorBody = z.infer<typeof createDoctorSchema>;

/** Monta service a partir das dependencias do kernel. */
export function createDoctorServiceFromDeps(deps: ApiModuleDeps): DoctorService {
  return createDoctorService({ db: deps.db, audit: createAuditService(deps.db) });
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

export function doctorModule(deps: ApiModuleDeps): ApiModule {
  const service = createDoctorServiceFromDeps(deps);
  const router = Router();
  // Sem `requireRoles`: todo papel de laboratorio escreve (D-255 item 3). O
  // operador da plataforma fica de fora explicitamente (PAGES.md §11).
  const guards = [requireAuth(), denyPlatformOperator()];
  const idParam = validate(doctorIdParamSchema, 'params');

  router.get('/', ...guards, validate(listDoctorsQuerySchema, 'query'), listDoctors(service));
  router.post('/', ...guards, validate(createDoctorSchema, 'body'), createDoctor(service));
  router.get('/:id', ...guards, idParam, getDoctor(service));
  router.patch('/:id', ...guards, idParam, validate(updateDoctorSchema, 'body'), updateDoctor(service));
  router.post('/:id/inactivate', ...guards, idParam, setDoctorActive(service, false));
  router.post('/:id/reactivate', ...guards, idParam, setDoctorActive(service, true));

  return { basePath: '/doctors', router, requiresAuth: true };
}
