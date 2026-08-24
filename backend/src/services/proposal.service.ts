/**
 * ProposalService — CORACAO DO SISTEMA (SERVICES.md §4).
 *
 * Se as regras deste arquivo estiverem erradas, o produto esta errado. As tres
 * que nao admitem atalho:
 *
 * 1. **O total e derivado, nunca recebido** (BUSINESS_RULES §1, D-003). Os
 *    precos vem de `ExamCatalogService.resolveActiveByIds` — o catalogo ATUAL,
 *    sem cache — e o total sai de `calculateTotal` de `@crm-lab/shared`, a
 *    MESMA funcao que o frontend usa. `CreateProposalRequest` nem tem campo de
 *    preco: o cliente nao tem como enviar um.
 *
 * 2. **A alcada e do servidor** (BUSINESS_RULES §2, §8). O limite e lido do
 *    banco (nao do token, que pode ser anterior a uma revogacao de alcada).
 *    Dentro do limite: nasce `approved` por si mesma. Acima: nasce `pending` e
 *    dispara o ApprovalService — e proposta `pending` NAO vai para o paciente.
 *
 * 3. **A matriz de transicoes e a de `@crm-lab/shared`** (BUSINESS_RULES §3,
 *    WORKFLOWS §4). `ALLOWED_TRANSITIONS`/`isTransitionAllowed` sao importados,
 *    nunca reescritos: front e back leem a mesma constante, entao divergir e
 *    impossivel por construcao.
 *
 * Toda mutacao grava `proposal_status_history`, emite WebSocket e audita.
 *
 * NOTA SOBRE TRANSACOES: `db.withTenant` nao aninha (o driver de teste tem uma
 * conexao so e serializa transacoes). Por isso as chamadas a outros services
 * (catalogo, auditoria, chat interno) ficam SEMPRE fora do bloco `withTenant`.
 */
import {
  ALLOWED_TRANSITIONS,
  LOSS_REASONS,
  TERMINAL_STATUSES,
  calculateSubtotal,
  calculateTotal,
  isTransitionAllowed,
  type ApprovalStatus,
  type CreateProposalRequest,
  type CreateProposalResponse,
  type ListProposalsResponse,
  type LossReason,
  type PaginationMeta,
  type Proposal,
  type ProposalDetail,
  type ProposalStatus,
} from '@crm-lab/shared';
import type { DbClient, DbTx } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import type { CacheService } from '../lib/cache.js';
import type { WsHub } from '../lib/ws-hub.js';
import { logger } from '../lib/logger.js';
// A analytics e a dona do formato da chave; importar daqui garante um formato
// so. A dependencia e de mao unica: o AnalyticsService nao conhece propostas.
import { cachePrefix as analyticsCachePrefix } from './analytics.service.js';
import { BusinessError, notFound } from '../http/errors.js';
import type { AuditService } from './audit.service.js';
import type { ExamCatalogService } from './exam-catalog.service.js';
import type { ApprovalRequester } from './approval.service.js';
import * as repo from '../repositories/proposal.repository.js';
import type { ProposalRow } from '../repositories/proposal.repository.js';

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const MAX_ITEMS = 100;

/** Mensagem de UX devolvida por `POST /proposals` quando cai em aprovacao. */
export const PENDING_APPROVAL_MESSAGE = 'Proposta criada. Aguardando aprovação do gestor.';

export interface ProposalFilters {
  /** Lista separada por virgula na query string (`?status=a,b`). */
  status?: string;
  conversationId?: string;
  createdBy?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  order?: 'asc' | 'desc';
}

export interface ProposalServiceDeps {
  db: DbClient;
  wsHub: WsHub;
  audit: AuditService;
  examCatalog: ExamCatalogService;
  /** ApprovalService — injetado como interface para nao criar ciclo. */
  approvals: ApprovalRequester;
  /**
   * O MESMO cache que o AnalyticsService le. Toda mutacao de proposta muda
   * algum numero de relatorio, entao a mutacao invalida — ver
   * `invalidateAnalytics`.
   */
  cache: CacheService;
}

// ---------------------------------------------------------------------------
// Helpers compartilhados com o ApprovalService
// ---------------------------------------------------------------------------

/**
 * Visibilidade por papel (coerente com ConversationService, SERVICES.md §2):
 * atendente enxerga as PROPRIAS propostas; gestor e admin, todas do tenant.
 * Ver D-042.
 */
export function canSeeProposal(ctx: TenantContext, row: ProposalRow): boolean {
  if (ctx.role === 'manager' || ctx.role === 'admin') return true;
  return row.created_by === ctx.userId;
}

/**
 * Carrega a proposta aplicando RLS + visibilidade por papel.
 * Inexistente, de outro tenant ou fora da visibilidade -> `NOT_FOUND` (404),
 * NUNCA `FORBIDDEN`: 403 confirmaria a existencia (CLAUDE.md regra 8).
 */
export async function loadVisibleProposal(
  tx: DbTx,
  ctx: TenantContext,
  id: string,
): Promise<ProposalRow> {
  const row = await repo.findRowById(tx, id);
  if (!row || !canSeeProposal(ctx, row)) {
    throw notFound({ resource: 'proposal', id });
  }
  return row;
}

/** Alcada ATUAL do usuario, lida do banco (o token pode estar defasado). */
export async function readDiscountLimit(
  tx: DbTx,
  userId: string,
  fallback: number,
): Promise<number> {
  const result = await tx.query<{ discount_limit_percent: unknown }>(
    'SELECT discount_limit_percent FROM users WHERE id = $1',
    [userId],
  );
  const raw = result.rows[0]?.discount_limit_percent;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** Referencia curta e estavel da proposta, para mensagens ("Orcamento #a1b2c3d4"). */
export function proposalRef(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}

/** `1234.5` -> `"R$ 1.234,50"`. Formatacao pt-BR sem depender de ICU completo. */
export function formatMoney(value: number): string {
  const cents = Math.round(value * 100);
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const integer = String(Math.floor(absolute / 100));
  const decimals = String(absolute % 100).padStart(2, '0');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}R$ ${grouped},${decimals}`;
}

/** `25` -> `"25%"`, `12.5` -> `"12,5%"`. */
export function formatPercent(value: number): string {
  const text = Number.isInteger(value) ? String(value) : String(value).replace('.', ',');
  return `${text}%`;
}

function isTerminal(status: ProposalStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

function isLossReason(value: string): value is LossReason {
  return (LOSS_REASONS as readonly string[]).includes(value);
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function parseStatuses(raw: string | undefined): ProposalStatus[] | undefined {
  if (raw === undefined) return undefined;
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) return undefined;
  const invalid = values.filter((value) => !(value in ALLOWED_TRANSITIONS));
  if (invalid.length > 0) {
    throw new BusinessError('VALIDATION_ERROR', {
      fields: { status: `Estagio invalido: ${invalid.join(', ')}` },
    });
  }
  return values as ProposalStatus[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ProposalService {
  constructor(private readonly deps: ProposalServiceDeps) {}

  /**
   * Derruba o cache de analytics DO TENANT depois de uma mutacao de proposta.
   *
   * ========================================================================
   * POR QUE O PREFIXO INTEIRO, E NAO UMA CHAVE
   * ========================================================================
   * A chave de analytics e
   * `analytics:<tenant>:<escopo>:<relatorio>:<periodo>`. Uma unica proposta
   * fechada aparece em varias entradas ao mesmo tempo: no escopo `all` do
   * gestor E no `user:<autor>` do atendente; no funil E no pipeline; e em
   * todo periodo que contenha a data. Invalidar so a do autor era exatamente
   * o bug observado na Onda 5 — a parcial do atendente (722) ficou MAIOR que
   * o total do laboratorio (622), porque o gestor tinha lido antes e ficou
   * com a entrada `all` congelada por 5 minutos. Um numero que nao existe.
   *
   * O prefixo carrega o `tenantId`: `delByPrefix` nunca alcanca outro
   * laboratorio (regra 1). O custo e recalcular na proxima leitura — o cache
   * de 5 min continua valendo para o trafego de leitura, que e a maioria.
   *
   * Falha de cache NAO derruba a mutacao: a proposta ja esta gravada e
   * auditada. O pior caso de um erro aqui e voltar ao numero velho por ate
   * `ANALYTICS_CACHE_TTL_SECONDS`, entao o erro e registrado e engolido.
   */
  private async invalidateAnalytics(tenantId: string): Promise<void> {
    try {
      await this.deps.cache.delByPrefix(analyticsCachePrefix(tenantId));
    } catch (err) {
      logger.warn('analytics.cache_invalidation_failed', {
        tenantId,
        detail: err instanceof Error ? err.message : 'erro desconhecido',
      });
    }
  }

  /**
   * WORKFLOWS §2 passo 5, na ordem exata:
   * conversa -> precos ATUAIS -> total -> alcada -> `novo_contato` + historico
   * -> auditoria. Nada de preco vindo do cliente em lugar nenhum.
   */
  async create(ctx: TenantContext, dto: CreateProposalRequest): Promise<CreateProposalResponse> {
    const { db, examCatalog, audit, approvals } = this.deps;

    if (dto.items.length === 0 || dto.items.length > MAX_ITEMS) {
      throw new BusinessError('VALIDATION_ERROR', {
        fields: { items: 'Informe de 1 a 100 itens' },
      });
    }
    for (const item of dto.items) {
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw new BusinessError('VALIDATION_ERROR', {
          fields: { 'items.quantity': 'Quantidade deve ser inteiro positivo' },
        });
      }
    }

    const discountPercent = dto.discountPercent ?? 0;
    if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
      throw new BusinessError('VALIDATION_ERROR', {
        fields: { discountPercent: 'Percentual deve estar entre 0 e 100' },
      });
    }

    // Precos do CATALOGO (sem cache), nunca do payload — BUSINESS_RULES §1.
    const resolution = await examCatalog.resolveActiveByIds(
      ctx.tenantId,
      dto.items.map((item) => item.examId),
    );
    if (resolution.invalidIds.length > 0) {
      throw new BusinessError('EXAM_NOT_FOUND_OR_INACTIVE', { examIds: resolution.invalidIds });
    }

    // Snapshot de nome e preco no momento da criacao (D-004).
    const items = dto.items.map((item) => {
      const exam = resolution.byId.get(item.examId);
      if (!exam) throw new BusinessError('EXAM_NOT_FOUND_OR_INACTIVE', { examIds: [item.examId] });
      return {
        examId: exam.id,
        examName: exam.name,
        quantity: item.quantity,
        unitPrice: exam.pricePrivate,
      };
    });

    const totalPrice = calculateTotal(items, discountPercent);

    const created = await db.withTenant(ctx.tenantId, async (tx) => {
      // Conversa de outro tenant fica invisivel pelo RLS -> NOT_FOUND.
      const conversation = await repo.findConversation(tx, dto.conversationId);
      if (!conversation) {
        throw notFound({ resource: 'conversation', id: dto.conversationId });
      }

      const userLimit = await readDiscountLimit(tx, ctx.userId, ctx.discountLimit);
      const withinLimit = discountPercent <= userLimit;
      const approvalStatus: ApprovalStatus = withinLimit ? 'approved' : 'pending';
      const now = new Date().toISOString();

      const id = await repo.insertProposal(tx, {
        tenantId: ctx.tenantId,
        conversationId: dto.conversationId,
        createdBy: ctx.userId,
        status: 'novo_contato',
        discountPercent,
        totalPrice,
        approvalStatus,
        // Dentro da alcada: aprovada por si mesma (BUSINESS_RULES §2).
        approvedBy: withinLimit ? ctx.userId : null,
        approvedAt: withinLimit ? now : null,
      });

      await repo.insertItems(tx, ctx.tenantId, id, items);
      // Primeira linha do historico — invariante combinado com os seeds.
      await repo.insertHistory(tx, {
        tenantId: ctx.tenantId,
        proposalId: id,
        status: 'novo_contato',
        changedBy: ctx.userId,
      });

      const detail = await loadDetail(tx, id);
      return { detail, userLimit, withinLimit };
    });

    await audit.record(ctx, {
      action: 'create_proposal',
      entityType: 'proposal',
      entityId: created.detail.id,
      newValues: {
        status: created.detail.status,
        discountPercent,
        totalPrice: created.detail.totalPrice,
        approvalStatus: created.detail.approvalStatus,
        items: items.map((item) => ({
          examId: item.examId,
          examName: item.examName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
      },
    });

    // Proposta nova entra no funil e no pipeline na hora.
    await this.invalidateAnalytics(ctx.tenantId);

    if (!created.withinLimit) {
      // Fluxo 3 de WORKFLOWS: post em #aprovacoes + WS para os gestores.
      await approvals.requestApproval(ctx, created.detail.id);
      const refreshed = await this.getById(ctx, created.detail.id);
      return { ...refreshed, message: PENDING_APPROVAL_MESSAGE };
    }

    return created.detail;
  }

  async getById(ctx: TenantContext, id: string): Promise<ProposalDetail> {
    return this.deps.db.withTenant(ctx.tenantId, async (tx) => {
      const row = await loadVisibleProposal(tx, ctx, id);
      return loadDetail(tx, row.id);
    });
  }

  /** `?status=a,b`, periodo, conversa e autor. Envelope nomeado (D-009). */
  async list(ctx: TenantContext, filters: ProposalFilters): Promise<ListProposalsResponse> {
    const page = clamp(filters.page, DEFAULT_PAGE, 1, Number.MAX_SAFE_INTEGER);
    const limit = clamp(filters.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const sortBy =
      filters.sortBy !== undefined && repo.isProposalSortBy(filters.sortBy)
        ? filters.sortBy
        : 'createdAt';

    const statuses = parseStatuses(filters.status);

    // Atendente so ve as proprias — o filtro e do servidor, nao da query (D-042).
    const createdBy = ctx.role === 'attendant' ? ctx.userId : filters.createdBy;
    if (
      ctx.role === 'attendant' &&
      filters.createdBy !== undefined &&
      filters.createdBy !== ctx.userId
    ) {
      // Pedir explicitamente as de outro autor nao vaza nada: devolve vazio.
      return { proposals: [], pagination: { page, limit, total: 0, totalPages: 0 } };
    }

    return this.deps.db.withTenant(ctx.tenantId, async (tx) => {
      const result = await repo.list(tx, {
        ...(statuses !== undefined ? { statuses } : {}),
        ...(filters.conversationId !== undefined
          ? { conversationId: filters.conversationId }
          : {}),
        ...(createdBy !== undefined ? { createdBy } : {}),
        ...(filters.startDate !== undefined ? { startDate: filters.startDate } : {}),
        ...(filters.endDate !== undefined ? { endDate: filters.endDate } : {}),
        page,
        limit,
        sortBy,
        order: filters.order === 'asc' ? 'asc' : 'desc',
      });

      const pagination: PaginationMeta = {
        page,
        limit,
        total: result.total,
        totalPages: result.total === 0 ? 0 : Math.ceil(result.total / limit),
      };
      return { proposals: result.rows, pagination };
    });
  }

  /**
   * Transicao de estagio. Ordem das recusas (da mais especifica para a menos):
   * ja encerrada -> fora da matriz -> motivo de perda -> aprovacao pendente.
   */
  async updateStatus(
    ctx: TenantContext,
    id: string,
    status: ProposalStatus,
    reasonLost?: string,
  ): Promise<Proposal> {
    const { db, audit, wsHub } = this.deps;

    const outcome = await db.withTenant(ctx.tenantId, async (tx) => {
      const row = await loadVisibleProposal(tx, ctx, id);
      const from = row.status as ProposalStatus;

      // Terminal: nenhuma mutacao posterior (SERVICES.md §4).
      if (isTerminal(from)) {
        throw new BusinessError('PROPOSAL_ALREADY_CLOSED', { status: from });
      }

      if (!isTransitionAllowed(from, status)) {
        throw new BusinessError('INVALID_STATUS_TRANSITION', {
          from,
          to: status,
          allowed: [...ALLOWED_TRANSITIONS[from]],
        });
      }

      let loss: LossReason | null = null;
      if (status === 'perdido') {
        if (reasonLost === undefined || reasonLost === null || reasonLost === '') {
          throw new BusinessError('LOSS_REASON_REQUIRED');
        }
        if (!isLossReason(reasonLost)) {
          throw new BusinessError('INVALID_LOSS_REASON', { allowed: [...LOSS_REASONS] });
        }
        loss = reasonLost;
      }

      // Proposta sem aprovacao concedida nao vai para o paciente (WORKFLOWS §3).
      // `rejected` entra junto com `pending`: a rejeicao nao autoriza o
      // desconto, e o caminho documentado e "ajusta o desconto e re-submete"
      // (D-047).
      if (
        status === 'orcamento_enviado' &&
        (row.approval_status === 'pending' || row.approval_status === 'rejected')
      ) {
        throw new BusinessError('PROPOSAL_PENDING_APPROVAL', {
          approvalStatus: row.approval_status,
        });
      }

      const now = new Date().toISOString();
      const updated = await repo.updateProposal(tx, id, {
        status,
        ...(loss !== null ? { reasonLost: loss } : {}),
        ...(status === 'orcamento_enviado' ? { sentAt: now } : {}),
        ...(isTerminal(status) ? { closedAt: now } : {}),
      });
      if (!updated) throw notFound({ resource: 'proposal', id });

      await repo.insertHistory(tx, {
        tenantId: ctx.tenantId,
        proposalId: id,
        status,
        changedBy: ctx.userId,
      });

      // Mensagem de sistema na conversa (WORKFLOWS §2 passo 6 e §4).
      const ref = proposalRef(id);
      if (status === 'orcamento_enviado') {
        await repo.insertSystemMessage(tx, {
          tenantId: ctx.tenantId,
          conversationId: row.conversation_id,
          content: `Orçamento #${ref} enviado — ${formatMoney(Number(updated.total_price))}`,
        });
      } else if (status === 'ganho') {
        await repo.insertSystemMessage(tx, {
          tenantId: ctx.tenantId,
          conversationId: row.conversation_id,
          content: `Proposta #${ref} ganha! 🎉`,
        });
      }

      return { from, proposal: repo.mapProposal(updated) };
    });

    wsHub.emitToTenant(ctx.tenantId, 'proposal.status_changed', {
      proposalId: id,
      status,
    });

    await audit.record(ctx, {
      action: 'update_proposal_status',
      entityType: 'proposal',
      entityId: id,
      oldValues: { status: outcome.from },
      newValues: {
        status,
        ...(outcome.proposal.reasonLost !== null
          ? { reasonLost: outcome.proposal.reasonLost }
          : {}),
      },
    });

    // Transicao muda o funil, a conversao e — quando e terminal — a receita.
    await this.invalidateAnalytics(ctx.tenantId);

    return outcome.proposal;
  }

  /**
   * Novo desconto: o total e RECALCULADO (D-003) sobre os itens em snapshot
   * (D-004 — a proposta preserva os precos da epoca) e a alcada e reavaliada:
   * subir acima do limite devolve a proposta para `pending`.
   */
  async updateDiscount(
    ctx: TenantContext,
    id: string,
    discountPercent: number,
  ): Promise<Proposal> {
    const { db, audit, approvals } = this.deps;

    if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
      throw new BusinessError('VALIDATION_ERROR', {
        fields: { discountPercent: 'Percentual deve estar entre 0 e 100' },
      });
    }

    const outcome = await db.withTenant(ctx.tenantId, async (tx) => {
      const row = await loadVisibleProposal(tx, ctx, id);
      const status = row.status as ProposalStatus;
      if (isTerminal(status)) {
        throw new BusinessError('PROPOSAL_ALREADY_CLOSED', { status });
      }

      const userLimit = await readDiscountLimit(tx, ctx.userId, ctx.discountLimit);
      const withinLimit = discountPercent <= userLimit;

      // API_ERRORS.md: "bloqueio em updateDiscount de terceiro". Mexer no
      // desconto da proposta de OUTRA pessoa acima da propria alcada e recusado
      // — nao vira pedido de aprovacao (D-045).
      if (!withinLimit && row.created_by !== ctx.userId) {
        throw new BusinessError('DISCOUNT_EXCEEDS_LIMIT', {
          requestedDiscount: discountPercent,
          userLimit,
          approvalRequired: true,
        });
      }

      const items = await repo.findItems(tx, id);
      const totalPrice = calculateTotal(items, discountPercent);
      const now = new Date().toISOString();

      const updated = await repo.updateProposal(tx, id, {
        discountPercent,
        totalPrice,
        approvalStatus: withinLimit ? 'approved' : 'pending',
        approvedBy: withinLimit ? ctx.userId : null,
        approvedAt: withinLimit ? now : null,
      });
      if (!updated) throw notFound({ resource: 'proposal', id });

      return {
        proposal: repo.mapProposal(updated),
        previous: {
          discountPercent: Number(row.discount_percent),
          totalPrice: Number(row.total_price),
          approvalStatus: row.approval_status,
        },
        withinLimit,
      };
    });

    await audit.record(ctx, {
      action: 'update_proposal_discount',
      entityType: 'proposal',
      entityId: id,
      oldValues: outcome.previous,
      newValues: {
        discountPercent,
        totalPrice: outcome.proposal.totalPrice,
        approvalStatus: outcome.proposal.approvalStatus,
      },
    });

    // O total mudou: valor do pipeline e ticket medio mudam junto.
    await this.invalidateAnalytics(ctx.tenantId);

    if (!outcome.withinLimit) {
      await approvals.requestApproval(ctx, id);
    }

    return outcome.proposal;
  }
}

/** Detalhe completo: proposta + itens + subtotal + historico + motivo da rejeicao. */
export async function loadDetail(tx: DbTx, id: string): Promise<ProposalDetail> {
  const row = await repo.findRowById(tx, id);
  if (!row) throw notFound({ resource: 'proposal', id });
  const items = await repo.findItems(tx, id);
  const history = await repo.findHistory(tx, id);
  const rejectionReason = await repo.findRejectionReason(tx, id);
  return repo.mapDetail(row, items, history, {
    subtotal: calculateSubtotal(items),
    rejectionReason,
  });
}

export function createProposalService(deps: ProposalServiceDeps): ProposalService {
  return new ProposalService(deps);
}
