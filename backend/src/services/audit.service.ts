/**
 * AuditService — log imutavel de acoes criticas (SERVICES.md §10).
 *
 * ============================================================================
 * INFRAESTRUTURA COMPARTILHADA — ProposalService, ApprovalService e
 * ConversationService consomem ESTA interface.
 * ============================================================================
 *
 * Como instanciar (dentro do seu `ApiModuleFactory`):
 *
 *     import { createAuditService } from '../services/audit.service.js';
 *
 *     export function proposalModule(deps: ApiModuleDeps): ApiModule {
 *       const audit = createAuditService(deps.db);
 *       ...
 *     }
 *
 * Como registrar uma acao (o caminho normal — 1 linha, dentro do handler):
 *
 *     await audit.record(ctx, {
 *       action: 'update_proposal_status',
 *       entityType: 'proposal',
 *       entityId: proposal.id,
 *       oldValues: { status: 'novo_contato' },
 *       newValues: { status: 'orcamento_enviado' },
 *     });
 *
 * `record()` deriva tenantId/userId/ip/userAgent do `TenantContext` — nunca do
 * request. Use `log()` direto so quando NAO houver contexto autenticado (o
 * login, por exemplo, audita antes de existir `req.ctx`).
 *
 * GARANTIA: nem `log()` nem `record()` lancam. Uma falha de auditoria NUNCA
 * derruba a operacao principal (SERVICES.md §10). A falha e logada e fica
 * disponivel em `failures` para inspecao/teste — "nao lanca" nao pode virar
 * "engoliu em silencio".
 */
import type { AuditEntry, ListAuditQuery, PaginationMeta } from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError } from '../http/errors.js';
import { logger } from '../lib/logger.js';
import * as auditRepo from '../repositories/audit.repository.js';

/** Entrada completa — o shape de SERVICES.md §10. */
export interface AuditLogInput {
  tenantId: string;
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Entrada quando ha `TenantContext` — o resto vem do contexto autenticado. */
export type AuditRecordInput = Omit<
  AuditLogInput,
  'tenantId' | 'userId' | 'ipAddress' | 'userAgent'
>;

/** Falha capturada por `log()`. Existe para diagnostico e para os testes. */
export interface AuditFailure {
  at: string;
  action: string;
  entityType: string;
  entityId: string;
  reason: string;
}

export interface ListAuditResult {
  entries: AuditEntry[];
  pagination: PaginationMeta;
}

export interface AuditService {
  /** Append-only, fire-and-forget seguro. NUNCA lanca. */
  log(entry: AuditLogInput): Promise<void>;
  /** Acucar sobre `log()` para quando ha `TenantContext`. NUNCA lanca. */
  record(ctx: TenantContext, entry: AuditRecordInput): Promise<void>;
  /** Aba "Log de auditoria" da tela /settings/users — SOMENTE admin. */
  query(ctx: TenantContext, filters: ListAuditQuery): Promise<ListAuditResult>;
  /** Ultimas falhas de escrita (janela deslizante). So diagnostico/teste. */
  readonly failures: readonly AuditFailure[];
}

const MAX_TRACKED_FAILURES = 50;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function clampPage(value: number | undefined): number {
  const n = Number(value ?? 1);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function clampLimit(value: number | undefined): number {
  const n = Number(value ?? DEFAULT_LIMIT);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

export function createAuditService(db: DbClient): AuditService {
  const failures: AuditFailure[] = [];

  const log = async (entry: AuditLogInput): Promise<void> => {
    try {
      await db.withTenant(entry.tenantId, (tx) => auditRepo.insert(tx, entry));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Nunca propaga: a operacao de negocio ja aconteceu e nao pode ser
      // desfeita por uma falha de log (SERVICES.md §10).
      logger.error('audit.log_failed', {
        tenantId: entry.tenantId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        reason,
      });
      failures.push({
        at: new Date().toISOString(),
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        reason,
      });
      if (failures.length > MAX_TRACKED_FAILURES) failures.shift();
    }
  };

  const record = async (ctx: TenantContext, entry: AuditRecordInput): Promise<void> =>
    log({
      ...entry,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
    });

  const query = async (
    ctx: TenantContext,
    filters: ListAuditQuery,
  ): Promise<ListAuditResult> => {
    // "A UI esconde, o servidor recusa" — a checagem vive aqui tambem, nao so
    // no `requireRoles` da rota.
    if (ctx.role !== 'admin') {
      throw new BusinessError('FORBIDDEN', { requiredRoles: ['admin'] });
    }

    const page = clampPage(filters.page);
    const limit = clampLimit(filters.limit);

    const { entries, total } = await db.withTenant(ctx.tenantId, (tx) =>
      auditRepo.query(tx, {
        page,
        limit,
        action: filters.action,
        entityType: filters.entityType,
        entityId: filters.entityId,
        userId: filters.userId,
        order: filters.order,
      }),
    );

    return {
      entries,
      pagination: {
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      },
    };
  };

  return { log, record, query, failures };
}
