/**
 * ApprovalService — SERVICES.md §6, WORKFLOWS.md §3.
 *
 * Aprovacao de desconto acima da alcada. As regras que o servidor garante:
 *
 * - Proposta em `pending` NAO vai ao paciente — quem barra e o
 *   `ProposalService.updateStatus` (`PROPOSAL_PENDING_APPROVAL`).
 * - So `manager`/`admin` decidem, **e so dentro da propria alcada**: um gestor
 *   de 30% nao aprova 40% -> `APPROVAL_NOT_ALLOWED` com
 *   `details: { discount, approverLimit }`.
 * - Ninguem aprova a propria proposta (D-046) — nem admin.
 * - Rejeicao exige motivo e notifica o criador.
 * - Toda decisao e auditada.
 *
 * O pedido vira um post de sistema em `#aprovacoes` com a proposta anexada
 * (renderizada como cartao pelo frontend) + evento `approval.requested`.
 */
import type { Proposal, ProposalStatus } from '@crm-lab/shared';
import { TERMINAL_STATUSES } from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import type { WsHub } from '../lib/ws-hub.js';
import { BusinessError } from '../http/errors.js';
import type { AuditService } from './audit.service.js';
import type { InternalChatService } from './internal-chat.service.js';
import {
  formatMoney,
  formatPercent,
  loadVisibleProposal,
  proposalRef,
  readDiscountLimit,
} from './proposal.service.js';
import * as repo from '../repositories/proposal.repository.js';
import { REJECT_ACTION } from '../repositories/proposal.repository.js';

/** Canal onde o sistema posta os pedidos (WORKFLOWS §3 e §6). */
export const APPROVALS_CHANNEL_KEY = 'aprovacoes';

export const APPROVE_ACTION = 'approve_proposal_discount';
export const REQUEST_ACTION = 'request_proposal_approval';

/**
 * A porta que o ProposalService usa. Existe como interface para que
 * `proposal.service.ts` NAO precise importar este modulo em runtime — quebra o
 * ciclo (aqui importamos de la; la o import e so de tipo).
 */
export interface ApprovalRequester {
  requestApproval(ctx: TenantContext, proposalId: string): Promise<void>;
}

export interface ApprovalServiceDeps {
  db: DbClient;
  wsHub: WsHub;
  audit: AuditService;
  chat: InternalChatService;
}

const DECIDER_ROLES = ['manager', 'admin'] as const;

function assertDecider(ctx: TenantContext): void {
  if (ctx.role !== 'manager' && ctx.role !== 'admin') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: [...DECIDER_ROLES] });
  }
}

export class ApprovalService implements ApprovalRequester {
  constructor(private readonly deps: ApprovalServiceDeps) {}

  /**
   * Posta o pedido em `#aprovacoes` com a proposta anexada e avisa os gestores.
   * Idempotente do ponto de vista de dados (nao altera a proposta): so publica.
   */
  async requestApproval(ctx: TenantContext, proposalId: string): Promise<void> {
    const { db, chat, wsHub, audit } = this.deps;

    const summary = await db.withTenant(ctx.tenantId, async (tx) => {
      const row = await loadVisibleProposal(tx, ctx, proposalId);
      const creatorLimit = await readDiscountLimit(tx, row.created_by, ctx.discountLimit);
      return {
        patientName: row.patient_name ?? 'Paciente',
        totalPrice: Number(row.total_price),
        discountPercent: Number(row.discount_percent),
        creatorLimit,
      };
    });

    // Mesmo formato do dataset de E2E (`E2E_APPROVAL_POST`), para que o spec do
    // Playwright continue localizando o cartao pelo texto.
    const content =
      `@gestor Pedido de aprovação de desconto: ${summary.patientName} - ` +
      `${formatMoney(summary.totalPrice)} (${formatPercent(summary.discountPercent)} — ` +
      `acima da alçada de ${formatPercent(summary.creatorLimit)})`;

    await chat.createSystemPost(ctx.tenantId, APPROVALS_CHANNEL_KEY, content, proposalId);

    wsHub.emitToTenant(ctx.tenantId, 'approval.requested', { proposalId });

    await audit.record(ctx, {
      action: REQUEST_ACTION,
      entityType: 'proposal',
      entityId: proposalId,
      newValues: {
        approvalStatus: 'pending',
        discountPercent: summary.discountPercent,
        requesterLimit: summary.creatorLimit,
      },
    });
  }

  /** manager/admin, dentro da propria alcada, e nunca a propria proposta. */
  async approve(ctx: TenantContext, proposalId: string): Promise<Proposal> {
    assertDecider(ctx);
    const { db, wsHub, audit, chat } = this.deps;

    const outcome = await db.withTenant(ctx.tenantId, async (tx) => {
      const row = await loadVisibleProposal(tx, ctx, proposalId);
      assertDecidable(row);

      if (row.created_by === ctx.userId) {
        // D-046: aprovar a propria proposta nao deixa rastro util no audit log
        // (autor e aprovador sao a mesma pessoa) e transformaria a alcada em
        // auto-servico. Vale inclusive para admin.
        throw new BusinessError('FORBIDDEN', { reason: 'self_approval' });
      }

      const discount = Number(row.discount_percent);
      const approverLimit = await readDiscountLimit(tx, ctx.userId, ctx.discountLimit);
      if (discount > approverLimit) {
        throw new BusinessError('APPROVAL_NOT_ALLOWED', { discount, approverLimit });
      }

      const updated = await repo.updateProposal(tx, proposalId, {
        approvalStatus: 'approved',
        approvedBy: ctx.userId,
        approvedAt: new Date().toISOString(),
      });
      if (!updated) throw new BusinessError('NOT_FOUND', { resource: 'proposal', id: proposalId });

      return {
        proposal: repo.mapProposal(updated),
        createdBy: row.created_by,
        discount,
        approverLimit,
      };
    });

    await chat.createSystemPost(
      ctx.tenantId,
      APPROVALS_CHANNEL_KEY,
      `Desconto de ${formatPercent(outcome.discount)} APROVADO na proposta #${proposalRef(proposalId)}.`,
      proposalId,
    );

    // Notifica o criador (WORKFLOWS §3: "Atendente e notificado via WebSocket").
    wsHub.emitToUser(ctx.tenantId, outcome.createdBy, 'approval.decided', {
      proposalId,
      decision: 'approved',
    });

    await audit.record(ctx, {
      action: APPROVE_ACTION,
      entityType: 'proposal',
      entityId: proposalId,
      oldValues: { approvalStatus: 'pending' },
      newValues: {
        approvalStatus: 'approved',
        discountPercent: outcome.discount,
        approverLimit: outcome.approverLimit,
      },
    });

    return outcome.proposal;
  }

  /** Rejeicao exige motivo (texto livre). O criador ajusta o desconto e resubmete. */
  async reject(ctx: TenantContext, proposalId: string, reason: string): Promise<Proposal> {
    assertDecider(ctx);
    const { db, wsHub, audit, chat } = this.deps;

    const trimmed = typeof reason === 'string' ? reason.trim() : '';
    if (trimmed.length === 0 || trimmed.length > 500) {
      throw new BusinessError('VALIDATION_ERROR', {
        fields: { reason: 'Motivo da rejeicao e obrigatorio (1..500 caracteres)' },
      });
    }

    const outcome = await db.withTenant(ctx.tenantId, async (tx) => {
      const row = await loadVisibleProposal(tx, ctx, proposalId);
      assertDecidable(row);

      const updated = await repo.updateProposal(tx, proposalId, {
        approvalStatus: 'rejected',
        // `approved_by` continua NULL: null significa "nao foi aprovado"
        // (BUSINESS_RULES §10). Quem rejeitou fica no audit log.
        approvedBy: null,
        approvedAt: null,
      });
      if (!updated) throw new BusinessError('NOT_FOUND', { resource: 'proposal', id: proposalId });

      return {
        proposal: repo.mapProposal(updated),
        createdBy: row.created_by,
        discount: Number(row.discount_percent),
      };
    });

    // A auditoria e a origem unica de `ProposalDetail.rejectionReason` (D-041),
    // por isso e gravada ANTES de responder ao cliente.
    await audit.record(ctx, {
      action: REJECT_ACTION,
      entityType: 'proposal',
      entityId: proposalId,
      oldValues: { approvalStatus: 'pending' },
      newValues: {
        approvalStatus: 'rejected',
        rejectionReason: trimmed,
        discountPercent: outcome.discount,
      },
    });

    await chat.createSystemPost(
      ctx.tenantId,
      APPROVALS_CHANNEL_KEY,
      `Desconto de ${formatPercent(outcome.discount)} REJEITADO na proposta ` +
        `#${proposalRef(proposalId)}: ${trimmed}`,
      proposalId,
    );

    wsHub.emitToUser(ctx.tenantId, outcome.createdBy, 'approval.decided', {
      proposalId,
      decision: 'rejected',
    });

    return outcome.proposal;
  }

  /** Fila de aprovacao — so quem decide enxerga (manager/admin). */
  async listPending(ctx: TenantContext): Promise<Proposal[]> {
    assertDecider(ctx);
    return this.deps.db.withTenant(ctx.tenantId, async (tx) => {
      const page = await repo.list(tx, {
        approvalStatus: 'pending',
        page: 1,
        limit: 100,
        sortBy: 'createdAt',
        order: 'asc',
      });
      return page.rows;
    });
  }
}

/** Proposta encerrada nao recebe decisao; so `pending` esta em decisao. */
function assertDecidable(row: repo.ProposalRow): void {
  const status = row.status as ProposalStatus;
  if (TERMINAL_STATUSES.includes(status)) {
    throw new BusinessError('PROPOSAL_ALREADY_CLOSED', { status });
  }
  if (row.approval_status !== 'pending') {
    throw new BusinessError('CONFLICT', { approvalStatus: row.approval_status });
  }
}

export function createApprovalService(deps: ApprovalServiceDeps): ApprovalService {
  return new ApprovalService(deps);
}
