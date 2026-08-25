/**
 * OperationService — SERVICES.md §14, API_CONTRACTS.md §7. READ-ONLY.
 *
 * ============================================================================
 * UM RETRATO, UM INSTANTE (D-067)
 * ============================================================================
 * Fila, carga e decisoes pendentes saem de UMA chamada e de UMA transacao. Em
 * Postgres `NOW()` e o instante de inicio da transacao, entao as quatro
 * consultas abaixo compartilham literalmente o mesmo relogio: a soma da carga
 * bate com a fila porque ambas olharam o banco no mesmo ponto. Tres endpoints
 * separados permitiriam a tela mostrar uma fila de 14:03 ao lado de uma carga
 * de 14:05 — a incoerencia que BUSINESS_RULES §5 existe para evitar.
 *
 * ============================================================================
 * SEM CACHE, DE PROPOSITO
 * ============================================================================
 * O AnalyticsService §9 cacheia 5 minutos porque relatorio de periodo nao muda.
 * Aqui e um painel de "agora": 5 minutos de TTL mostrariam uma fila que ja nao
 * existe, e o gestor tomaria decisao sobre uma espera que ja acabou. Por isso
 * este service tambem nao invalida nada.
 *
 * ============================================================================
 * TUDO E DERIVADO
 * ============================================================================
 * Nenhuma tabela nova, nenhum contador materializado: os numeros vem de
 * agregacoes sobre `conversations` e `proposals` (BUSINESS_RULES §5). Os tempos
 * sao inteiros de segundos calculados DENTRO do SQL, em UTC (D-021) — nenhuma
 * subtracao de data acontece neste arquivo.
 */
import type {
  ConversationChannel,
  OperationOverviewQuery,
  OperationOverviewResponse,
  PendingDecisionItem,
  ProposalStatus,
  QueueItem,
  QueueReason,
  UserRole,
  WorkloadRow,
} from '@crm-lab/shared';
import { PROPOSAL_STATUSES, TERMINAL_STATUSES } from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError } from '../http/errors.js';
import * as operationRepo from '../repositories/operation.repository.js';

/** Itens devolvidos quando o cliente nao pede um limite. */
export const DEFAULT_LIMIT = 25;

/** Teto de itens por bloco. Acima disso e VALIDATION_ERROR, nao corte silencioso. */
export const MAX_LIMIT = 100;

const LAB_ROLES: readonly UserRole[] = ['attendant', 'manager', 'admin'];
const MANAGER_ROLES: readonly UserRole[] = ['manager', 'admin'];
const CHANNELS: readonly ConversationChannel[] = ['whatsapp', 'sms', 'web', 'direct'];

export interface OperationService {
  /** manager/admin. Um retrato, um instante. */
  getOverview(
    ctx: TenantContext,
    query: OperationOverviewQuery,
  ): Promise<OperationOverviewResponse>;
}

export interface OperationServiceDeps {
  db: DbClient;
}

// ---------------------------------------------------------------------------
// Permissao — validada no backend SEMPRE
// ---------------------------------------------------------------------------

/**
 * A tela e de gestao de time: mostra a carga de todos, e um atendente nao
 * enxerga a fila alheia em nenhum outro lugar do produto. A rota ja barra com
 * `requireRoles`; o service confere de novo porque tambem e chamado sem
 * middleware (teste, script, futuro consumidor).
 */
function assertManagerRole(ctx: TenantContext): void {
  if (ctx.role === 'platform_operator') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: [...LAB_ROLES] });
  }
  if (ctx.role !== 'manager' && ctx.role !== 'admin') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: [...MANAGER_ROLES] });
  }
}

// ---------------------------------------------------------------------------
// Limites
// ---------------------------------------------------------------------------

/**
 * `undefined` -> default. Fora da faixa -> `VALIDATION_ERROR`: reduzir em
 * silencio faria a tela exibir 100 itens acreditando ter pedido 500, e a
 * paginacao mentiria sem nenhum sinal.
 */
export function resolveLimit(value: number | undefined, field: string): number {
  if (value === undefined || value === null) return DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new BusinessError('VALIDATION_ERROR', {
      fields: { [field]: `Deve ser um inteiro entre 1 e ${MAX_LIMIT}` },
    });
  }
  return n;
}

// ---------------------------------------------------------------------------
// Narrowing de colunas texto -> uniao do contrato
// ---------------------------------------------------------------------------

/**
 * `conversations.channel` e nullable no schema (001). Conversa sem canal
 * declarado e atendimento feito direto no sistema — `direct` e a leitura
 * honesta, e nunca inventa um canal externo que nao existe.
 */
function toChannel(value: string | null): ConversationChannel {
  return value !== null && (CHANNELS as readonly string[]).includes(value)
    ? (value as ConversationChannel)
    : 'direct';
}

function toQueueReason(value: string): QueueReason {
  return value === 'unassigned' ? 'unassigned' : 'waiting';
}

function toRole(value: string): UserRole {
  return (LAB_ROLES as readonly string[]).includes(value) ? (value as UserRole) : 'attendant';
}

function toProposalStatus(value: string): ProposalStatus {
  return (PROPOSAL_STATUSES as readonly string[]).includes(value)
    ? (value as ProposalStatus)
    : 'novo_contato';
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createOperationService(deps: OperationServiceDeps): OperationService {
  const { db } = deps;

  const getOverview = async (
    ctx: TenantContext,
    query: OperationOverviewQuery,
  ): Promise<OperationOverviewResponse> => {
    assertManagerRole(ctx);
    const queueLimit = resolveLimit(query.queueLimit, 'queueLimit');
    const decisionsLimit = resolveLimit(query.decisionsLimit, 'decisionsLimit');

    // UMA transacao: `NOW()` e o mesmo para os quatro blocos (D-067).
    const data = await db.withTenant(ctx.tenantId, async (tx) => ({
      generatedAt: await operationRepo.snapshotInstant(tx),
      totals: await operationRepo.queueTotals(tx, ctx.tenantId),
      items: await operationRepo.queueItems(tx, ctx.tenantId, queueLimit),
      workload: await operationRepo.workload(tx, ctx.tenantId, TERMINAL_STATUSES),
      decisionsTotal: await operationRepo.pendingDecisionsTotal(tx, ctx.tenantId),
      decisions: await operationRepo.pendingDecisions(tx, ctx.tenantId, decisionsLimit),
    }));

    const items: QueueItem[] = data.items.map((row) => ({
      conversationId: row.conversationId,
      patientId: row.patientId,
      patientName: row.patientName,
      channel: toChannel(row.channel),
      reason: toQueueReason(row.reason),
      assignedTo: row.assignedTo,
      assignedToName: row.assignedToName,
      unreadCount: row.unreadCount,
      waitingSeconds: row.waitingSeconds,
      lastMessageAt: row.lastMessageAt,
    }));

    const workload: WorkloadRow[] = data.workload.map((row) => ({
      userId: row.userId,
      name: row.name,
      role: toRole(row.role),
      activeConversations: row.activeConversations,
      unreadMessages: row.unreadMessages,
      openProposals: row.openProposals,
      pendingApprovals: row.pendingApprovals,
    }));

    const decisions: PendingDecisionItem[] = data.decisions.map((row) => ({
      proposalId: row.proposalId,
      patientName: row.patientName,
      createdBy: row.createdBy,
      // O usuario pode ter sido removido; a decisao continua na fila.
      createdByName: row.createdByName ?? 'Usuario removido',
      status: toProposalStatus(row.status),
      discountPercent: row.discountPercent,
      totalPrice: row.totalPrice,
      createdAt: row.createdAt,
      waitingSeconds: row.waitingSeconds,
    }));

    return {
      generatedAt: data.generatedAt,
      queue: {
        unassigned: data.totals.unassigned,
        waiting: data.totals.waiting,
        // Da fila INTEIRA, nao dos itens listados (D-067).
        oldestWaitSeconds: data.totals.oldestWaitSeconds,
        items,
      },
      workload,
      pendingDecisions: {
        total: data.decisionsTotal,
        items: decisions,
        pagination: {
          // Sempre 1: este endpoint NAO pagina (D-077). `total`/`totalPages`
          // existem para a tela dizer quantas decisoes ficaram de fora e
          // linkar para `GET /proposals`; a resposta e um retrato unico do
          // mesmo instante (D-067), entao "pagina 2" refaria fila e carga.
          page: 1,
          limit: decisionsLimit,
          total: data.decisionsTotal,
          // Convencao do projeto: sem nenhum item, `totalPages` e 0.
          totalPages:
            data.decisionsTotal === 0 ? 0 : Math.ceil(data.decisionsTotal / decisionsLimit),
        },
      },
    };
  };

  return { getOverview };
}
