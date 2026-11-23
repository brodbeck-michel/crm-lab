/**
 * DoctorInteractionService — SERVICES.md §32 (CRMLAB-89, D-261).
 *
 * Dono de `doctor_interactions` (registros lancados a mao na ficha do medico:
 * ligacao, e-mail, WhatsApp) e da leitura da linha do tempo do medico, que
 * junta esses registros com as visitas (`doctor_visits`).
 *
 * Regras (D-261):
 *  - representante, gestor e admin (D-329): gestor/admin em qualquer medico;
 *    o representante so na carteira dele (outro medico -> 404);
 *  - medico de outro tenant, inexistente, ou registro de OUTRO medico ->
 *    `NOT_FOUND` (nunca `FORBIDDEN`);
 *  - `occurredAt` nao pode ficar mais que 5 min no futuro; descricao
 *    obrigatoria (ate 2000);
 *  - medico inativo ainda recebe registro: a linha do tempo e historico, e
 *    um contato com medico inativo aconteceu do mesmo jeito;
 *  - excluir apaga a linha; o rastro fica no audit;
 *  - audit log em criar, editar (so o diff) e excluir.
 *
 * Feed (CRMLAB-192, D-332): filtro por tipo no SQL, visita com relato inteiro
 * e anexos, e comentarios em todo item (`doctor_timeline_comments`): quem
 * alcanca a ficha comenta; so o autor edita; o autor e o admin excluem.
 */
import {
  DOCTOR_INTERACTION_TYPES,
  DOCTOR_TIMELINE_COMMENT_MAX_LENGTH,
  DOCTOR_TIMELINE_COMMENTS_PER_ITEM_MAX,
  doctorTimelineCommentPermissions,
  type CreateDoctorTimelineCommentRequest,
  type DoctorTimelineComment,
  type DoctorTimelineFilter,
  type DoctorTimelineItem,
  type UpdateDoctorTimelineCommentRequest,
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
  type TimelineFilter,
  type TimelineVisitReport,
} from '../repositories/doctor-interaction.repository.js';
import { DoctorTimelineCommentRepository } from '../repositories/doctor-timeline-comment.repository.js';
import { DoctorRepository } from '../repositories/doctor.repository.js';
import type { AuditService } from './audit.service.js';
import { assertVisitationRole, portfolioOwner } from './visitation-access.js';

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
  createComment(
    ctx: TenantContext,
    doctorId: string,
    dto: CreateDoctorTimelineCommentRequest,
  ): Promise<DoctorTimelineComment>;
  updateComment(
    ctx: TenantContext,
    doctorId: string,
    commentId: string,
    dto: UpdateDoctorTimelineCommentRequest,
  ): Promise<DoctorTimelineComment>;
  deleteComment(ctx: TenantContext, doctorId: string, commentId: string): Promise<void>;
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

/** Filtro do fio -> o que o repositorio aplica. Ausente/vazio = tudo. */
export function timelineFilter(types: DoctorTimelineFilter[] | undefined): TimelineFilter {
  if (types === undefined || types.length === 0) {
    return { visits: true, interactionTypes: [...DOCTOR_INTERACTION_TYPES] };
  }
  return {
    visits: types.includes('visita'),
    interactionTypes: DOCTOR_INTERACTION_TYPES.filter((type) => types.includes(type)),
  };
}

/** Visao do comentario para o audit. */
function commentAuditView(doctorId: string, comment: DoctorTimelineComment): Record<string, unknown> {
  return { doctorId, itemKind: comment.itemKind, itemId: comment.itemId, body: comment.body };
}

function notAuthor(): BusinessError {
  return new BusinessError('FORBIDDEN', { reason: 'not_author' });
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
  const comments = new DoctorTimelineCommentRepository(deps.db);
  const audit = deps.audit;
  const now = deps.now ?? (() => new Date());

  /**
   * Medico do tenant (ativo ou inativo) e do escopo de quem pede — para o
   * representante, so da carteira dele (D-329); senao `NOT_FOUND`.
   */
  async function assertDoctor(ctx: TenantContext, doctorId: string): Promise<void> {
    assertVisitationRole(ctx);
    const doctor = await doctors.findById(ctx.tenantId, doctorId, portfolioOwner(ctx));
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

  function cleanCommentBody(value: string): string {
    const body = value.trim();
    if (body.length === 0) throw invalid({ body: 'Escreva o comentário' });
    if (body.length > DOCTOR_TIMELINE_COMMENT_MAX_LENGTH) {
      throw invalid({ body: `No máximo ${DOCTOR_TIMELINE_COMMENT_MAX_LENGTH} caracteres` });
    }
    return body;
  }

  /** Anexos das visitas e comentarios de todos os itens da pagina — duas consultas. */
  async function enrich(tenantId: string, items: DoctorTimelineItem[]): Promise<DoctorTimelineItem[]> {
    const visitIds = items.filter((item) => item.kind === 'visit').map((item) => item.id);
    const interactionIds = items.filter((item) => item.kind === 'interaction').map((item) => item.id);
    const [attachments, pageComments] = await Promise.all([
      repository.attachmentsForVisits(tenantId, visitIds),
      comments.listForItems(tenantId, visitIds, interactionIds),
    ]);
    const byItem = new Map<string, DoctorTimelineComment[]>();
    for (const comment of pageComments) {
      const key = `${comment.itemKind}:${comment.itemId}`;
      const list = byItem.get(key) ?? [];
      list.push(comment);
      byItem.set(key, list);
    }
    return items.map((item) => {
      const itemComments = byItem.get(`${item.kind}:${item.id}`) ?? [];
      return item.kind === 'visit'
        ? { ...item, attachments: attachments.get(item.id) ?? [], comments: itemComments }
        : { ...item, comments: itemComments };
    });
  }

  /** Comentario de item DESTE medico, no escopo de quem pede; senao `NOT_FOUND`. */
  async function loadComment(ctx: TenantContext, doctorId: string, commentId: string): Promise<DoctorTimelineComment> {
    await assertDoctor(ctx, doctorId);
    const comment = await comments.findById(ctx.tenantId, doctorId, commentId);
    if (!comment) throw notFound({ resource: 'doctor_timeline_comment', id: commentId });
    return comment;
  }

  return {
    async timeline(ctx, doctorId, query) {
      await assertDoctor(ctx, doctorId);
      const limit = clampLimit(query.limit);
      const cursor = query.cursor !== undefined ? decodeTimelineCursor(query.cursor) : null;

      const entries: TimelineEntry[] = await repository.timeline(
        ctx.tenantId,
        doctorId,
        limit,
        cursor,
        timelineFilter(query.types),
      );
      const page = entries.slice(0, limit);
      const items = await enrich(
        ctx.tenantId,
        page.map(({ item, report }) =>
          item.kind === 'visit' && report !== null ? { ...item, reportExcerpt: reportExcerpt(report) } : item,
        ),
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
      await assertDoctor(ctx, doctorId);
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
      await assertDoctor(ctx, doctorId);
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

    async createComment(ctx, doctorId, dto) {
      await assertDoctor(ctx, doctorId);
      const body = cleanCommentBody(dto.body);
      const total = await comments.countForItem(ctx.tenantId, doctorId, dto.itemKind, dto.itemId);
      if (total === null) throw notFound({ resource: dto.itemKind === 'visit' ? 'visit' : 'doctor_interaction', id: dto.itemId });
      if (total >= DOCTOR_TIMELINE_COMMENTS_PER_ITEM_MAX) {
        throw invalid({ body: `No máximo ${DOCTOR_TIMELINE_COMMENTS_PER_ITEM_MAX} comentários por item` });
      }
      const created = await comments.insert(ctx.tenantId, doctorId, dto.itemKind, dto.itemId, ctx.userId, body);

      await audit.record(ctx, {
        action: 'create_doctor_timeline_comment',
        entityType: 'doctor_timeline_comment',
        entityId: created.id,
        newValues: commentAuditView(doctorId, created),
      });
      return created;
    },

    async updateComment(ctx, doctorId, commentId, dto) {
      const current = await loadComment(ctx, doctorId, commentId);
      if (!doctorTimelineCommentPermissions(current, { id: ctx.userId, role: ctx.role }).canEdit) throw notAuthor();
      const body = cleanCommentBody(dto.body);
      if (body === current.body) return current;

      const updated = await comments.updateBody(ctx.tenantId, doctorId, commentId, body);
      if (!updated) throw notFound({ resource: 'doctor_timeline_comment', id: commentId });

      await audit.record(ctx, {
        action: 'update_doctor_timeline_comment',
        entityType: 'doctor_timeline_comment',
        entityId: commentId,
        oldValues: { body: current.body },
        newValues: { body: updated.body },
      });
      return updated;
    },

    async deleteComment(ctx, doctorId, commentId) {
      const current = await loadComment(ctx, doctorId, commentId);
      if (!doctorTimelineCommentPermissions(current, { id: ctx.userId, role: ctx.role }).canDelete) throw notAuthor();
      const deleted = await comments.delete(ctx.tenantId, commentId);
      if (!deleted) throw notFound({ resource: 'doctor_timeline_comment', id: commentId });

      await audit.record(ctx, {
        action: 'delete_doctor_timeline_comment',
        entityType: 'doctor_timeline_comment',
        entityId: commentId,
        oldValues: commentAuditView(doctorId, current),
      });
    },
  };
}
