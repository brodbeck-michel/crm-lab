/**
 * DoctorInteractionService — SERVICES.md §32 (CRMLAB-89, D-261).
 *
 * Dono de `doctor_interactions` (registros lancados a mao na ficha do medico:
 * ligacao, e-mail, WhatsApp) e da leitura da linha do tempo do medico, que
 * junta esses registros com as visitas (`doctor_visits`).
 *
 * Regras (D-261):
 *  - todo papel de laboratorio ve, lanca, edita e exclui (resposta 2A do
 *    epico); o `platform_operator` ja fica na rota;
 *  - medico de outro tenant, inexistente, ou registro de OUTRO medico ->
 *    `NOT_FOUND` (nunca `FORBIDDEN`);
 *  - `occurredAt` nao pode ficar mais que 5 min no futuro; descricao
 *    obrigatoria (ate 2000);
 *  - medico inativo ainda recebe registro: a linha do tempo e historico, e
 *    um contato com medico inativo aconteceu do mesmo jeito;
 *  - excluir apaga a linha; o rastro fica no audit;
 *  - audit log em criar, editar (so o diff) e excluir.
 */
import {
  DOCTOR_INTERACTION_DESCRIPTION_MAX_LENGTH,
  DOCTOR_INTERACTION_FUTURE_TOLERANCE_MS,
  DOCTOR_TIMELINE_DEFAULT_LIMIT,
  DOCTOR_TIMELINE_EXCERPT_MAX_LENGTH,
  DOCTOR_TIMELINE_MAX_LIMIT,
  type CreateDoctorInteractionRequest,
  type DoctorInteraction,
  type DoctorTimelineQuery,
  type DoctorTimelineResponse,
  type UpdateDoctorInteractionRequest,
} from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError, notFound } from '../http/errors.js';
import {
  DoctorInteractionRepository,
  type DoctorInteractionPatch,
  type TimelineCursor,
  type TimelineEntry,
  type TimelineVisitReport,
} from '../repositories/doctor-interaction.repository.js';
import { DoctorRepository } from '../repositories/doctor.repository.js';
import type { AuditService } from './audit.service.js';

export interface DoctorInteractionService {
  timeline(ctx: TenantContext, doctorId: string, query: DoctorTimelineQuery): Promise<DoctorTimelineResponse>;
  create(ctx: TenantContext, doctorId: string, dto: CreateDoctorInteractionRequest): Promise<DoctorInteraction>;
  update(
    ctx: TenantContext,
    doctorId: string,
    id: string,
    dto: UpdateDoctorInteractionRequest,
  ): Promise<DoctorInteraction>;
  delete(ctx: TenantContext, doctorId: string, id: string): Promise<void>;
}

export interface DoctorInteractionServiceDeps {
  db: DbClient;
  audit: AuditService;
  /** Relogio injetavel para o teste do "nao pode ser no futuro". */
  now?: () => Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(fields: Record<string, string>): BusinessError {
  return new BusinessError('VALIDATION_ERROR', { fields });
}

/**
 * O cursor e opaco para o cliente: `base64url("<ISO>|<uuid>")` do ultimo item
 * da pagina. Mexido ou de outra versao -> `VALIDATION_ERROR`, nunca 500.
 */
export function encodeTimelineCursor(cursor: TimelineCursor): string {
  return Buffer.from(`${cursor.sortAt}|${cursor.id}`, 'utf8').toString('base64url');
}

export function decodeTimelineCursor(value: string): TimelineCursor {
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  const [sortAt, id, ...rest] = decoded.split('|');
  if (rest.length > 0 || !sortAt || !id || !UUID_RE.test(id) || Number.isNaN(Date.parse(sortAt))) {
    throw invalid({ cursor: 'Cursor inválido' });
  }
  return { sortAt: new Date(sortAt).toISOString(), id };
}

/** Primeiro trecho preenchido do relato, cortado com reticencias. */
export function reportExcerpt(report: TimelineVisitReport): string | null {
  for (const text of [report.presented, report.feedback, report.objections]) {
    const trimmed = text?.trim();
    if (!trimmed) continue;
    if (trimmed.length <= DOCTOR_TIMELINE_EXCERPT_MAX_LENGTH) return trimmed;
    return `${trimmed.slice(0, DOCTOR_TIMELINE_EXCERPT_MAX_LENGTH - 1).trimEnd()}…`;
  }
  return null;
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DOCTOR_TIMELINE_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), DOCTOR_TIMELINE_MAX_LIMIT);
}

/** Visao "plana" do registro para o audit. */
function auditView(interaction: DoctorInteraction): Record<string, unknown> {
  return {
    doctorId: interaction.doctorId,
    type: interaction.type,
    occurredAt: interaction.occurredAt,
    description: interaction.description,
  };
}

export function createDoctorInteractionService(deps: DoctorInteractionServiceDeps): DoctorInteractionService {
  const repository = new DoctorInteractionRepository(deps.db);
  const doctors = new DoctorRepository(deps.db);
  const audit = deps.audit;
  const now = deps.now ?? (() => new Date());

  /** Medico do tenant (ativo ou inativo); senao `NOT_FOUND`. */
  async function assertDoctor(ctx: TenantContext, doctorId: string): Promise<void> {
    const doctor = await doctors.findById(ctx.tenantId, doctorId);
    if (!doctor) throw notFound({ resource: 'doctor', id: doctorId });
  }

  function cleanDescription(value: string): string {
    const description = value.trim();
    if (description.length === 0) throw invalid({ description: 'Descreva a interação' });
    if (description.length > DOCTOR_INTERACTION_DESCRIPTION_MAX_LENGTH) {
      throw invalid({ description: `No máximo ${DOCTOR_INTERACTION_DESCRIPTION_MAX_LENGTH} caracteres` });
    }
    return description;
  }

  function cleanOccurredAt(value: string): string {
    const time = Date.parse(value);
    if (Number.isNaN(time)) throw invalid({ occurredAt: 'Data inválida' });
    if (time > now().getTime() + DOCTOR_INTERACTION_FUTURE_TOLERANCE_MS) {
      throw invalid({ occurredAt: 'A data não pode ser no futuro' });
    }
    return new Date(time).toISOString();
  }

  return {
    async timeline(ctx, doctorId, query) {
      await assertDoctor(ctx, doctorId);
      const limit = clampLimit(query.limit);
      const cursor = query.cursor !== undefined ? decodeTimelineCursor(query.cursor) : null;

      const entries: TimelineEntry[] = await repository.timeline(ctx.tenantId, doctorId, limit, cursor);
      const page = entries.slice(0, limit);
      const items = page.map(({ item, report }) =>
        item.kind === 'visit' && report !== null ? { ...item, reportExcerpt: reportExcerpt(report) } : item,
      );

      const last = page[page.length - 1];
      const nextCursor =
        entries.length > limit && last !== undefined
          ? encodeTimelineCursor({ sortAt: last.item.occurredAt, id: last.item.id })
          : null;
      return { items, nextCursor };
    },

    async create(ctx, doctorId, dto) {
      await assertDoctor(ctx, doctorId);
      const created = await repository.insert(ctx.tenantId, doctorId, ctx.userId, {
        type: dto.type,
        occurredAt: cleanOccurredAt(dto.occurredAt),
        description: cleanDescription(dto.description),
      });

      await audit.record(ctx, {
        action: 'create_doctor_interaction',
        entityType: 'doctor_interaction',
        entityId: created.id,
        newValues: auditView(created),
      });
      return created;
    },

    async update(ctx, doctorId, id, dto) {
      const current = await repository.findById(ctx.tenantId, doctorId, id);
      if (!current) throw notFound({ resource: 'doctor_interaction', id });

      const patch: DoctorInteractionPatch = {};
      if (dto.type !== undefined) patch.type = dto.type;
      if (dto.occurredAt !== undefined) patch.occurredAt = cleanOccurredAt(dto.occurredAt);
      if (dto.description !== undefined) patch.description = cleanDescription(dto.description);

      // So o que mudou de fato vai para o UPDATE e para o audit.
      const before = auditView(current);
      const oldValues: Record<string, unknown> = {};
      const newValues: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch) as Array<[keyof DoctorInteractionPatch, unknown]>) {
        if (before[key] === value) {
          delete patch[key];
          continue;
        }
        oldValues[key] = before[key];
        newValues[key] = value;
      }
      if (Object.keys(newValues).length === 0) return current;

      const updated = await repository.update(ctx.tenantId, doctorId, id, ctx.userId, patch);
      if (!updated) throw notFound({ resource: 'doctor_interaction', id });

      await audit.record(ctx, {
        action: 'update_doctor_interaction',
        entityType: 'doctor_interaction',
        entityId: id,
        oldValues,
        newValues,
      });
      return updated;
    },

    async delete(ctx, doctorId, id) {
      const current = await repository.findById(ctx.tenantId, doctorId, id);
      if (!current) throw notFound({ resource: 'doctor_interaction', id });
      const deleted = await repository.delete(ctx.tenantId, doctorId, id);
      if (!deleted) throw notFound({ resource: 'doctor_interaction', id });

      await audit.record(ctx, {
        action: 'delete_doctor_interaction',
        entityType: 'doctor_interaction',
        entityId: id,
        oldValues: auditView(current),
      });
    },
  };
}
