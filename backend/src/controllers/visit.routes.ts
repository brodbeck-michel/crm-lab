/**
 * Rotas da agenda de visitas — API_CONTRACTS.md §14 (CRMLAB-87, D-256).
 *
 *   GET   /api/v1/visits                     visitas de um periodo (from/to + filtros)
 *   GET   /api/v1/visits/:id                 uma visita, com o historico de datas
 *   POST  /api/v1/visits                     agenda
 *   PATCH /api/v1/visits/:id                 edita medico/responsavel/tipo/pauta (parcial)
 *   POST  /api/v1/visits/:id/reschedule      muda a data/hora e grava o historico
 *   POST  /api/v1/visits/:id/cancel          cancela (motivo obrigatorio)
 *   POST  /api/v1/visits/:id/not-received    "medico nao recebeu" (motivo obrigatorio)
 *
 * Registro da visita (CRMLAB-88, D-258):
 *   POST   /api/v1/visits/:id/check-in                       "Cheguei"
 *   POST   /api/v1/visits/:id/check-out                      "Sai" -> realizada
 *   PATCH  /api/v1/visits/:id/report                         relato + proximo passo
 *   POST   /api/v1/visits/:id/attachments                    anexa imagem/PDF (base64)
 *   GET    /api/v1/visits/:id/attachments/:attachmentId      baixa
 *   DELETE /api/v1/visits/:id/attachments/:attachmentId      exclui
 *
 * TODAS para qualquer papel de laboratorio (resposta 2A do epico CRMLAB-85).
 * Sem DELETE: visita se cancela.
 *
 * Controller fino (CONVENTIONS.md): valida o DTO, chama o service, responde.
 * `tenantId` vem SEMPRE de `getContext(req)` — nunca de query/body/header.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  VISIT_AGENDA_MAX_LENGTH,
  VISIT_ATTACHMENT_FILE_NAME_MAX_LENGTH,
  VISIT_REASON_MAX_LENGTH,
  VISIT_REPORT_MAX_LENGTH,
  VISIT_STATUSES,
  VISIT_TYPES,
  type CloseVisitRequest,
  type CreateVisitAttachmentRequest,
  type CreateVisitRequest,
  type ListVisitsQuery,
  type ListVisitsResponse,
  type RescheduleVisitRequest,
  type UpdateVisitReportRequest,
  type UpdateVisitRequest,
  type VisitAttachment,
  type VisitClosingStatus,
  type VisitDetail,
} from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { createAuditService } from '../services/audit.service.js';
import { dispositionFor, servedMimeType } from './media.routes.js';
import { createVisitService, type VisitService } from '../services/visit.service.js';

/** ISO 8601 com fuso (`Z` ou `-03:00`): sem fuso o horario seria ambiguo. */
const isoDateTime = z.string().datetime({ offset: true });

export const listVisitsQuerySchema = z.object({
  from: isoDateTime,
  to: isoDateTime,
  doctorId: z.string().uuid().optional(),
  responsibleId: z.string().uuid().optional(),
  status: z.enum(VISIT_STATUSES).optional(),
});

export const createVisitSchema = z
  .object({
    doctorId: z.string().uuid(),
    responsibleId: z.string().uuid(),
    scheduledAt: isoDateTime,
    type: z.enum(VISIT_TYPES),
    agenda: z.string().max(VISIT_AGENDA_MAX_LENGTH).nullable().optional(),
  })
  .strict();

/** `.strict()`: `scheduledAt`/`status` aqui seriam ignorados em silencio — melhor recusar. */
export const updateVisitSchema = z
  .object({
    doctorId: z.string().uuid().optional(),
    responsibleId: z.string().uuid().optional(),
    type: z.enum(VISIT_TYPES).optional(),
    agenda: z.string().max(VISIT_AGENDA_MAX_LENGTH).nullable().optional(),
  })
  .strict();

export const rescheduleVisitSchema = z
  .object({
    scheduledAt: isoDateTime,
    reason: z.string().max(VISIT_REASON_MAX_LENGTH).nullable().optional(),
  })
  .strict();

/** Motivo obrigatorio: so espaco tambem nao vale. */
export const closeVisitSchema = z
  .object({ reason: z.string().trim().min(1, 'Informe o motivo').max(VISIT_REASON_MAX_LENGTH) })
  .strict();

export const visitIdParamSchema = z.object({ id: z.string().uuid() });

export const visitAttachmentParamSchema = z.object({ id: z.string().uuid(), attachmentId: z.string().uuid() });

/** Check-in/out nao tem corpo; campo desconhecido e recusado. */
export const emptyBodySchema = z.object({}).strict();

const reportText = z.string().max(VISIT_REPORT_MAX_LENGTH).nullable().optional();

/** Relato + proximo passo (CRMLAB-88). A data de calendario e conferida no service. */
export const updateVisitReportSchema = z
  .object({
    presented: reportText,
    doctorFeedback: reportText,
    objections: reportText,
    nextVisitDate: z.string().nullable().optional(),
  })
  .strict();

/** Base64 em JSON, como `POST /conversations/:id/attachments`. Tipo e teto no service. */
export const createVisitAttachmentSchema = z
  .object({
    fileName: z.string().trim().min(1).max(VISIT_ATTACHMENT_FILE_NAME_MAX_LENGTH),
    mimeType: z.string().min(1).max(100),
    contentBase64: z.string().min(1),
  })
  .strict();

/** Monta service a partir das dependencias do kernel. */
export function createVisitServiceFromDeps(deps: ApiModuleDeps): VisitService {
  return createVisitService({ db: deps.db, audit: createAuditService(deps.db) });
}

/** `Promise` rejeitada em handler async precisa chegar no error-handler. */
function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function listVisits(service: VisitService): RequestHandler {
  return handle(async (req, res) => {
    const query = validated<ListVisitsQuery>(req, 'query');
    const body: ListVisitsResponse = await service.list(getContext(req), query);
    res.status(200).json(body);
  });
}

export function getVisit(service: VisitService): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    const body: VisitDetail = await service.getById(getContext(req), id);
    res.status(200).json(body);
  });
}

export function createVisit(service: VisitService): RequestHandler {
  return handle(async (req, res) => {
    const dto = validated<CreateVisitRequest>(req, 'body');
    const body: VisitDetail = await service.create(getContext(req), dto);
    res.status(201).json(body);
  });
}

export function updateVisit(service: VisitService): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<UpdateVisitRequest>(req, 'body');
    const body: VisitDetail = await service.update(getContext(req), id, dto);
    res.status(200).json(body);
  });
}

export function rescheduleVisit(service: VisitService): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<RescheduleVisitRequest>(req, 'body');
    const body: VisitDetail = await service.reschedule(getContext(req), id, dto);
    res.status(200).json(body);
  });
}

export function closeVisit(service: VisitService, status: VisitClosingStatus): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<CloseVisitRequest>(req, 'body');
    const body: VisitDetail = await service.close(getContext(req), id, status, dto);
    res.status(200).json(body);
  });
}

export function checkInVisit(service: VisitService): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    const body: VisitDetail = await service.checkIn(getContext(req), id);
    res.status(200).json(body);
  });
}

export function checkOutVisit(service: VisitService): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    const body: VisitDetail = await service.checkOut(getContext(req), id);
    res.status(200).json(body);
  });
}

export function updateVisitReport(service: VisitService): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<UpdateVisitReportRequest>(req, 'body');
    const body: VisitDetail = await service.updateReport(getContext(req), id, dto);
    res.status(200).json(body);
  });
}

export function addVisitAttachment(service: VisitService): RequestHandler {
  return handle(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<CreateVisitAttachmentRequest>(req, 'body');
    const body: VisitAttachment = await service.addAttachment(getContext(req), id, dto);
    res.status(201).json(body);
  });
}

/** Mesmos cabecalhos de `GET /media/:id` (CRMLAB-31): allow-list, nosniff, disposition. */
export function getVisitAttachment(service: VisitService): RequestHandler {
  return handle(async (req, res) => {
    const { id, attachmentId } = validated<{ id: string; attachmentId: string }>(req, 'params');
    const file = await service.readAttachment(getContext(req), id, attachmentId);
    const mimeType = servedMimeType(file.mimeType);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `${dispositionFor(mimeType)}; filename="${encodeURIComponent(file.fileName)}"`,
    );
    res.status(200).send(file.buffer);
  });
}

export function deleteVisitAttachment(service: VisitService): RequestHandler {
  return handle(async (req, res) => {
    const { id, attachmentId } = validated<{ id: string; attachmentId: string }>(req, 'params');
    await service.deleteAttachment(getContext(req), id, attachmentId);
    res.status(204).end();
  });
}

export function visitModule(deps: ApiModuleDeps): ApiModule {
  const service = createVisitServiceFromDeps(deps);
  const router = Router();
  // Sem `requireRoles`: todo papel de laboratorio escreve (D-256). O operador
  // da plataforma fica de fora explicitamente (PAGES.md §11).
  const guards = [requireAuth(), denyPlatformOperator()];
  const idParam = validate(visitIdParamSchema, 'params');
  const closeBody = validate(closeVisitSchema, 'body');

  router.get('/', ...guards, validate(listVisitsQuerySchema, 'query'), listVisits(service));
  router.post('/', ...guards, validate(createVisitSchema, 'body'), createVisit(service));
  router.get('/:id', ...guards, idParam, getVisit(service));
  router.patch('/:id', ...guards, idParam, validate(updateVisitSchema, 'body'), updateVisit(service));
  router.post('/:id/reschedule', ...guards, idParam, validate(rescheduleVisitSchema, 'body'), rescheduleVisit(service));
  router.post('/:id/cancel', ...guards, idParam, closeBody, closeVisit(service, 'cancelada'));
  router.post('/:id/not-received', ...guards, idParam, closeBody, closeVisit(service, 'nao_recebeu'));

  // Registro da visita (CRMLAB-88, D-258).
  const emptyBody = validate(emptyBodySchema, 'body');
  const attachmentParams = validate(visitAttachmentParamSchema, 'params');
  router.post('/:id/check-in', ...guards, idParam, emptyBody, checkInVisit(service));
  router.post('/:id/check-out', ...guards, idParam, emptyBody, checkOutVisit(service));
  router.patch('/:id/report', ...guards, idParam, validate(updateVisitReportSchema, 'body'), updateVisitReport(service));
  router.post(
    '/:id/attachments',
    ...guards,
    idParam,
    validate(createVisitAttachmentSchema, 'body'),
    addVisitAttachment(service),
  );
  router.get('/:id/attachments/:attachmentId', ...guards, attachmentParams, getVisitAttachment(service));
  router.delete('/:id/attachments/:attachmentId', ...guards, attachmentParams, deleteVisitAttachment(service));

  return { basePath: '/visits', router, requiresAuth: true };
}
