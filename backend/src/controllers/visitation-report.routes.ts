/**
 * Rotas do Relatorio de Visitacao — API_CONTRACTS.md §14b (CRMLAB-193, D-333).
 *
 *   GET /api/v1/visitation-reports/summary        indicadores, por representante, por finalidade, evolucao
 *   GET /api/v1/visitation-reports/stale-doctors  medicos sem visita realizada ha mais de X dias
 *
 * Representante, gestor e admin (a atendente recebe 403). Modulo proprio porque
 * `/reports` (§5c) barra tudo que nao e gestor/admin num `router.use`. O
 * representante e recortado no service; `tenantId` vem SEMPRE de `getContext`.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  DOCTOR_ABC_CLASSES,
  VISITATION_REPORT_GRANULARITIES,
  VISITATION_REPORT_STALE_MAX_DAYS,
  VISITATION_REPORT_STALE_MIN_DAYS,
  VISITATION_ROLES,
  type VisitationReport,
  type VisitationReportQuery,
  type VisitationReportStaleQuery,
  type VisitationReportStaleResponse,
} from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { createVisitationReportService, type VisitationReportService } from '../services/visitation-report.service.js';

/** Dia de calendario valido (`2026-02-30` nao passa). */
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve estar no formato YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Data inválida');

export const visitationReportQuerySchema = z.object({
  from: calendarDate,
  to: calendarDate,
  responsibleId: z.uuid().optional(),
  purposeId: z.uuid().optional(),
  abcClass: z.enum(DOCTOR_ABC_CLASSES).optional(),
  granularity: z.enum(VISITATION_REPORT_GRANULARITIES).optional(),
});

export const visitationReportStaleQuerySchema = z.object({
  days: z.coerce.number().int().min(VISITATION_REPORT_STALE_MIN_DAYS).max(VISITATION_REPORT_STALE_MAX_DAYS).optional(),
  responsibleId: z.uuid().optional(),
  abcClass: z.enum(DOCTOR_ABC_CLASSES).optional(),
});

function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function getVisitationReport(service: VisitationReportService): RequestHandler {
  return handle(async (req, res) => {
    const query = validated<VisitationReportQuery>(req, 'query');
    const body: VisitationReport = await service.summary(getContext(req), query);
    res.status(200).json(body);
  });
}

export function getStaleDoctors(service: VisitationReportService): RequestHandler {
  return handle(async (req, res) => {
    const query = validated<VisitationReportStaleQuery>(req, 'query');
    const body: VisitationReportStaleResponse = await service.staleDoctors(getContext(req), query);
    res.status(200).json(body);
  });
}

export function visitationReportModule(deps: ApiModuleDeps): ApiModule {
  const service = createVisitationReportService({ db: deps.db });
  const router = Router();
  // D-329: representante, gestor e admin; o operador da plataforma fica de fora antes.
  router.use(requireAuth(), denyPlatformOperator(), requireRoles(...VISITATION_ROLES));

  router.get('/summary', validate(visitationReportQuerySchema, 'query'), getVisitationReport(service));
  router.get('/stale-doctors', validate(visitationReportStaleQuerySchema, 'query'), getStaleDoctors(service));

  return { basePath: '/visitation-reports', router, requiresAuth: true };
}
