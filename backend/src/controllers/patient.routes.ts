/**
 * Rotas da ficha do paciente — API_CONTRACTS.md §2c (D-059..D-063).
 *
 *   GET   /api/v1/patients                 busca/listagem paginada
 *   GET   /api/v1/patients/:id             cadastro + contadores
 *   PATCH /api/v1/patients/:id             edita o cadastro
 *   GET   /api/v1/patients/:id/timeline    historico de interacoes
 *   GET   /api/v1/patients/:id/export      LGPD — dump do titular (admin)
 *   POST  /api/v1/patients/:id/anonymize   LGPD — apagamento (admin)
 *   POST  /api/v1/patients/:id/inactivate  inativa o cadastro (qualquer papel, D-132)
 *   POST  /api/v1/patients/:id/reactivate  reativa o cadastro (qualquer papel, D-132)
 *
 * NAO existe `POST /patients` (o paciente nasce do canal, D-061) nem
 * `DELETE /patients/:id` (o caminho LGPD e `anonymize`, D-063).
 *
 * `denyPlatformOperator()` em TODAS elas. PAGES.md §11 e explicito: o console
 * da plataforma nao tem caminho para dado de paciente — "requisito, nao
 * configuracao". Por isso a barreira e da rota, nao uma opcao de perfil.
 *
 * Controller fino (CONVENTIONS.md): valida o DTO, chama o service, responde.
 * `tenantId` vem SEMPRE de `getContext(req)` — nunca de query/body/header.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type {
  AnonymizePatientRequest,
  AnonymizePatientResponse,
  InactivatePatientRequest,
  ListPatientTimelineQuery,
  ListPatientTimelineResponse,
  ListPatientsQuery,
  ListPatientsResponse,
  PatientDetail,
  PatientExport,
  ReactivatePatientRequest,
  UpdatePatientRequest,
} from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { phoneDigits, PatientRepository } from '../repositories/patient.repository.js';
import { createAuditService } from '../services/audit.service.js';
import {
  MAX_LIMIT,
  MAX_TIMELINE_LIMIT,
  PatientService,
} from '../services/patient.service.js';

/* --------------------------------------------------------------------------
 * Normalizacoes do contrato §2c
 * ------------------------------------------------------------------------ */

/** CPF -> so digitos. O formatado e assunto do frontend (SCHEMA.md §14). */
export function cpfDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Digito verificador de CPF. Recusar so pelo tamanho deixaria "11111111111"
 * entrar no cadastro e virar chave de busca que nunca casa com ninguem.
 */
export function isValidCpf(digits: string): boolean {
  if (digits.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false;
  const checkDigit = (length: number): number => {
    let sum = 0;
    for (let i = 0; i < length; i += 1) {
      sum += Number(digits[i]) * (length + 1 - i);
    }
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return checkDigit(9) === Number(digits[9]) && checkDigit(10) === Number(digits[10]);
}

/** `YYYY-MM-DD` existente e NAO futura (contrato §2c). */
export function isRealPastDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const exists =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  if (!exists) return false;
  // Comparacao em UTC: a data de nascimento e data pura, sem fuso (D-021).
  return date.getTime() <= Date.now();
}

/* --------------------------------------------------------------------------
 * Schemas
 * ------------------------------------------------------------------------ */

export const listPatientsQuerySchema = z.object({
  search: z
    .string()
    .max(120)
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
    }),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  sortBy: z.enum(['name', 'lastInteractionAt', 'createdAt', 'updatedAt']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  includeInactive: z.coerce.boolean().optional(),
});

export const patientIdParamSchema = z.object({ id: z.string().uuid() });

/**
 * `.strict()` recusa campo desconhecido. `phone` e editavel desde D-106 —
 * NUNCA `.nullable()`: apagar deixaria o paciente sem chave de dedupe do
 * webhook. Conflito com o telefone de outro paciente do tenant vira
 * `409 CONFLICT` no service (indice unico `(tenant_id, phone)`), nunca aqui.
 */
export const updatePatientSchema = z
  .object({
    phone: z
      .string()
      .trim()
      .max(20)
      .refine((value) => {
        const digits = phoneDigits(value).length;
        return digits >= 10 && digits <= 13;
      }, 'Telefone invalido'),
    name: z.string().trim().min(1).max(255).nullable(),
    email: z.string().trim().email().max(255).nullable(),
    birthDate: z
      .string()
      .refine(isRealPastDate, 'Data de nascimento invalida ou futura')
      .nullable(),
    document: z
      .string()
      .transform(cpfDigits)
      .refine(isValidCpf, 'CPF invalido')
      .nullable(),
    notes: z.string().max(4000).nullable(),
    tags: z.array(z.string().trim().min(1).max(50)).max(20),
    customFields: z
      .record(z.string().min(1).max(50), z.string().max(500))
      .refine((value) => Object.keys(value).length <= 30, 'No maximo 30 campos personalizados'),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Informe ao menos um campo para atualizar',
  });

export const timelineQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_TIMELINE_LIMIT).optional(),
  kind: z
    .enum(['conversation_started', 'message', 'proposal_created', 'proposal_stage_changed'])
    .optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

export const anonymizePatientSchema = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();

export const inactivatePatientSchema = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();

export const reactivatePatientSchema = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();

/* --------------------------------------------------------------------------
 * Handlers
 * ------------------------------------------------------------------------ */

/** `Promise` rejeitada em handler async precisa chegar no error-handler. */
function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function createPatientService(deps: ApiModuleDeps): PatientService {
  return new PatientService({
    patients: new PatientRepository(deps.db),
    audit: createAuditService(deps.db),
  });
}

export function listPatients(service: PatientService): RequestHandler {
  return handle(async (req, res) => {
    const filters = validated<ListPatientsQuery>(req, 'query');
    const body: ListPatientsResponse = await service.list(getContext(req), filters);
    res.status(200).json(body);
  });
}

export function getPatient(service: PatientService): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    // Recurso unico responde o objeto CRU, sem envelope (API_CONTRACTS.md).
    const body: PatientDetail = await service.getById(getContext(req), id);
    res.status(200).json(body);
  });
}

export function updatePatient(service: PatientService): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<UpdatePatientRequest>(req, 'body');
    const body: PatientDetail = await service.update(getContext(req), id, dto);
    res.status(200).json(body);
  });
}

export function getPatientTimeline(service: PatientService): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    const query = validated<ListPatientTimelineQuery>(req, 'query');
    const body: ListPatientTimelineResponse = await service.timeline(getContext(req), id, query);
    res.status(200).json(body);
  });
}

/** `YYYYMMDD` do nome do arquivo — em UTC, como toda data do contrato. */
function fileStamp(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, '');
}

export function exportPatient(service: PatientService): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    const body: PatientExport = await service.exportData(getContext(req), id);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="paciente-${id}-${fileStamp(body.generatedAt)}.json"`,
    );
    res.status(200).json(body);
  });
}

export function anonymizePatient(service: PatientService): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<AnonymizePatientRequest>(req, 'body');
    const body: AnonymizePatientResponse = await service.anonymize(getContext(req), id, dto);
    res.status(200).json(body);
  });
}

export function inactivatePatient(service: PatientService): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<InactivatePatientRequest>(req, 'body');
    const body: PatientDetail = await service.inactivate(getContext(req), id, dto);
    res.status(200).json(body);
  });
}

export function reactivatePatient(service: PatientService): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<ReactivatePatientRequest>(req, 'body');
    const body: PatientDetail = await service.reactivate(getContext(req), id, dto);
    res.status(200).json(body);
  });
}

/* --------------------------------------------------------------------------
 * Modulo
 * ------------------------------------------------------------------------ */

export function patientModule(deps: ApiModuleDeps): ApiModule {
  const service = createPatientService(deps);
  const router = Router();

  // O papel `admin` de export/anonymize NAO e checado aqui por
  // `requireRoles`: a checagem vive no service (SERVICES.md §12), que e o
  // caminho por onde qualquer chamador passa. O guard de plataforma, sim, e da
  // rota — ele nega ANTES de o service existir para o operador.
  const guards = [requireAuth(), denyPlatformOperator()];

  router.get('/', ...guards, validate(listPatientsQuerySchema, 'query'), listPatients(service));

  router.get(
    '/:id',
    ...guards,
    validate(patientIdParamSchema, 'params'),
    getPatient(service),
  );

  router.patch(
    '/:id',
    ...guards,
    validate(patientIdParamSchema, 'params'),
    validate(updatePatientSchema, 'body'),
    updatePatient(service),
  );

  router.get(
    '/:id/timeline',
    ...guards,
    validate(patientIdParamSchema, 'params'),
    validate(timelineQuerySchema, 'query'),
    getPatientTimeline(service),
  );

  router.get(
    '/:id/export',
    ...guards,
    validate(patientIdParamSchema, 'params'),
    exportPatient(service),
  );

  router.post(
    '/:id/anonymize',
    ...guards,
    validate(patientIdParamSchema, 'params'),
    validate(anonymizePatientSchema, 'body'),
    anonymizePatient(service),
  );

  // Inativar/reativar (D-132): qualquer papel de laboratorio que enxergue o
  // paciente pode acionar — mesma alcada de `PATCH /:id`, sem `requireRoles`.
  router.post(
    '/:id/inactivate',
    ...guards,
    validate(patientIdParamSchema, 'params'),
    validate(inactivatePatientSchema, 'body'),
    inactivatePatient(service),
  );

  router.post(
    '/:id/reactivate',
    ...guards,
    validate(patientIdParamSchema, 'params'),
    validate(reactivatePatientSchema, 'body'),
    reactivatePatient(service),
  );

  return { basePath: '/patients', router, requiresAuth: true };
}
