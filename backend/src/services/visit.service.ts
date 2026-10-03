/**
 * VisitService — SERVICES.md §31 (CRMLAB-87, D-256).
 *
 * Dono de `doctor_visits` e `doctor_visit_reschedules`: a agenda de visitas a
 * medicos solicitantes (card [B] do epico CRMLAB-85, Visitacao Medica).
 *
 * Regras (D-256):
 *  - todo papel de laboratorio ve e mexe em todas as visitas (resposta 2A do
 *    epico); o `platform_operator` ja fica na rota (`denyPlatformOperator`);
 *  - medico ATIVO do mesmo laboratorio e responsavel = usuario ATIVO do mesmo
 *    laboratorio, os dois validados so quando mudam (como D-255 item 9);
 *  - reagendar muda a data da MESMA visita e grava o historico; mesma data e
 *    no-op (200, sem historico nem audit);
 *  - cancelar e "medico nao recebeu" exigem motivo;
 *  - so a visita `agendada` edita, reagenda ou encerra; senao
 *    `VISIT_ALREADY_CLOSED` (409). Repetir o MESMO encerramento e idempotente;
 *  - `realizada` nao nasce aqui: vem do check-in/out (card [C]);
 *  - audit log em criar, editar, reagendar, cancelar e nao recebeu.
 */
import {
  isVisitOpen,
  VISIT_LIST_MAX_DAYS,
  VISIT_LIST_MAX_RESULTS,
  type CloseVisitRequest,
  type CreateVisitRequest,
  type ListVisitsQuery,
  type ListVisitsResponse,
  type RescheduleVisitRequest,
  type UpdateVisitRequest,
  type VisitClosedDetails,
  type VisitClosingStatus,
  type VisitDetail,
} from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError, notFound } from '../http/errors.js';
import { VisitRepository, type VisitPatch } from '../repositories/visit.repository.js';
import type { AuditService } from './audit.service.js';

/** Quem pode ser responsavel pela visita: qualquer papel de laboratorio. */
const RESPONSIBLE_ROLES = ['attendant', 'manager', 'admin'];

const DAY_MS = 24 * 60 * 60 * 1000;

export interface VisitService {
  list(ctx: TenantContext, query: ListVisitsQuery): Promise<ListVisitsResponse>;
  getById(ctx: TenantContext, id: string): Promise<VisitDetail>;
  create(ctx: TenantContext, dto: CreateVisitRequest): Promise<VisitDetail>;
  update(ctx: TenantContext, id: string, dto: UpdateVisitRequest): Promise<VisitDetail>;
  reschedule(ctx: TenantContext, id: string, dto: RescheduleVisitRequest): Promise<VisitDetail>;
  close(ctx: TenantContext, id: string, status: VisitClosingStatus, dto: CloseVisitRequest): Promise<VisitDetail>;
}

export interface VisitServiceDeps {
  db: DbClient;
  audit: AuditService;
}

function invalid(fields: Record<string, string>): BusinessError {
  return new BusinessError('VALIDATION_ERROR', { fields });
}

function closedError(visit: VisitDetail): BusinessError {
  const details: VisitClosedDetails = { status: visit.status };
  return new BusinessError('VISIT_ALREADY_CLOSED', { ...details });
}

/** Texto opcional: `undefined` fica `undefined` (PATCH nao mexe); vazio/`null` vira `null`. */
function cleanText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw invalid({ [field]: 'Data/hora inválida' });
  return date;
}

/** Visao "plana" da visita para o diff do audit (pessoas por id). */
function auditView(visit: VisitDetail): Record<string, unknown> {
  return {
    doctorId: visit.doctor.id,
    responsibleId: visit.responsible?.id ?? null,
    scheduledAt: visit.scheduledAt,
    type: visit.type,
    agenda: visit.agenda,
    status: visit.status,
  };
}

const CLOSE_ACTIONS: Record<VisitClosingStatus, string> = {
  cancelada: 'cancel_visit',
  nao_recebeu: 'visit_not_received',
};

export function createVisitService(deps: VisitServiceDeps): VisitService {
  const repository = new VisitRepository(deps.db);
  const audit = deps.audit;

  async function assertDoctor(ctx: TenantContext, doctorId: string): Promise<void> {
    const doctor = await repository.findTenantDoctor(ctx.tenantId, doctorId);
    if (!doctor || !doctor.isActive) {
      throw invalid({ doctorId: 'Médico inexistente ou inativo neste laboratório' });
    }
  }

  async function assertResponsible(ctx: TenantContext, userId: string): Promise<void> {
    const user = await repository.findTenantUser(ctx.tenantId, userId);
    if (!user || !user.isActive || !RESPONSIBLE_ROLES.includes(user.role)) {
      throw invalid({ responsibleId: 'Usuário inexistente ou inativo neste laboratório' });
    }
  }

  async function load(ctx: TenantContext, id: string): Promise<VisitDetail> {
    const visit = await repository.findById(ctx.tenantId, id);
    if (!visit) throw notFound({ resource: 'visit', id });
    return visit;
  }

  /** A escrita guardada por `status = 'agendada'` falhou: some (404) ou foi encerrada (409). */
  async function lostRace(ctx: TenantContext, id: string): Promise<BusinessError> {
    const visit = await repository.findById(ctx.tenantId, id);
    return visit ? closedError(visit) : notFound({ resource: 'visit', id });
  }

  return {
    async list(ctx: TenantContext, query: ListVisitsQuery): Promise<ListVisitsResponse> {
      const from = parseDate(query.from, 'from');
      const to = parseDate(query.to, 'to');
      if (to.getTime() <= from.getTime()) throw invalid({ to: 'O fim do período tem de ser depois do início' });
      if (to.getTime() - from.getTime() > VISIT_LIST_MAX_DAYS * DAY_MS) {
        throw invalid({ to: `Período de no máximo ${VISIT_LIST_MAX_DAYS} dias` });
      }

      const rows = await repository.list(ctx.tenantId, {
        from,
        to,
        doctorId: query.doctorId,
        responsibleId: query.responsibleId,
        status: query.status,
        limit: VISIT_LIST_MAX_RESULTS + 1,
      });
      const truncated = rows.length > VISIT_LIST_MAX_RESULTS;
      return { visits: truncated ? rows.slice(0, VISIT_LIST_MAX_RESULTS) : rows, truncated };
    },

    /** Inexistente ou de outro tenant -> `NOT_FOUND` (nunca `FORBIDDEN`). */
    async getById(ctx: TenantContext, id: string): Promise<VisitDetail> {
      return load(ctx, id);
    },

    async create(ctx: TenantContext, dto: CreateVisitRequest): Promise<VisitDetail> {
      const scheduledAt = parseDate(dto.scheduledAt, 'scheduledAt');
      await assertDoctor(ctx, dto.doctorId);
      await assertResponsible(ctx, dto.responsibleId);

      const created = await repository.insert(ctx.tenantId, ctx.userId, {
        doctorId: dto.doctorId,
        responsibleId: dto.responsibleId,
        scheduledAt,
        type: dto.type,
        agenda: cleanText(dto.agenda) ?? null,
      });

      await audit.record(ctx, {
        action: 'create_visit',
        entityType: 'visit',
        entityId: created.id,
        newValues: auditView(created),
      });
      return created;
    },

    /**
     * PATCH parcial de visita `agendada`. Medico e responsavel so sao
     * revalidados quando MUDAM: uma visita cujo medico foi inativado depois
     * continua editavel (ex.: trocar a pauta) sem trocar o medico.
     */
    async update(ctx: TenantContext, id: string, dto: UpdateVisitRequest): Promise<VisitDetail> {
      const current = await load(ctx, id);
      if (!isVisitOpen(current.status)) throw closedError(current);

      const patch: VisitPatch = {};
      if (dto.doctorId !== undefined && dto.doctorId !== current.doctor.id) {
        await assertDoctor(ctx, dto.doctorId);
        patch.doctorId = dto.doctorId;
      }
      if (dto.responsibleId !== undefined && dto.responsibleId !== current.responsible?.id) {
        await assertResponsible(ctx, dto.responsibleId);
        patch.responsibleId = dto.responsibleId;
      }
      if (dto.type !== undefined && dto.type !== current.type) patch.type = dto.type;
      const agenda = cleanText(dto.agenda);
      if (agenda !== undefined && agenda !== current.agenda) patch.agenda = agenda;

      if (Object.keys(patch).length === 0) return current;

      const updated = await repository.updateOpen(ctx.tenantId, id, patch);
      if (!updated) throw await lostRace(ctx, id);

      // So o que mudou de fato vai para o audit.
      const before = auditView(current);
      const after = auditView(updated);
      const oldValues: Record<string, unknown> = {};
      const newValues: Record<string, unknown> = {};
      for (const key of Object.keys(after)) {
        if (before[key] === after[key]) continue;
        oldValues[key] = before[key] ?? null;
        newValues[key] = after[key] ?? null;
      }

      await audit.record(ctx, {
        action: 'update_visit',
        entityType: 'visit',
        entityId: id,
        oldValues,
        newValues,
      });
      return updated;
    },

    async reschedule(ctx: TenantContext, id: string, dto: RescheduleVisitRequest): Promise<VisitDetail> {
      const scheduledAt = parseDate(dto.scheduledAt, 'scheduledAt');
      const current = await load(ctx, id);
      if (!isVisitOpen(current.status)) throw closedError(current);

      const previous = new Date(current.scheduledAt);
      // Mesma data/hora: nada a registrar (repetir o clique nao suja o historico).
      if (previous.getTime() === scheduledAt.getTime()) return current;

      const reason = cleanText(dto.reason) ?? null;
      const updated = await repository.reschedule(ctx.tenantId, id, ctx.userId, previous, scheduledAt, reason);
      if (!updated) throw await lostRace(ctx, id);

      await audit.record(ctx, {
        action: 'reschedule_visit',
        entityType: 'visit',
        entityId: id,
        oldValues: { scheduledAt: current.scheduledAt },
        newValues: { scheduledAt: updated.scheduledAt, reason },
      });
      return updated;
    },

    /**
     * `agendada` -> `cancelada | nao_recebeu`, com motivo obrigatorio. Repetir
     * o MESMO encerramento devolve 200 sem novo audit; o outro -> 409.
     */
    async close(
      ctx: TenantContext,
      id: string,
      status: VisitClosingStatus,
      dto: CloseVisitRequest,
    ): Promise<VisitDetail> {
      const reason = cleanText(dto.reason) ?? null;
      if (reason === null) throw invalid({ reason: 'Informe o motivo' });

      const current = await load(ctx, id);
      if (current.status === status) return current;
      if (!isVisitOpen(current.status)) throw closedError(current);

      const updated = await repository.close(ctx.tenantId, id, status, reason, ctx.userId);
      if (!updated) throw await lostRace(ctx, id);

      await audit.record(ctx, {
        action: CLOSE_ACTIONS[status],
        entityType: 'visit',
        entityId: id,
        oldValues: { status: current.status },
        newValues: { status, reason },
      });
      return updated;
    },
  };
}
