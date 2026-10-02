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
 * 3. **As travas de transicao sao as de `@crm-lab/shared`** (BUSINESS_RULES §3,
 *    WORKFLOWS §4). `checkTransition` com as Regras do laboratorio (CRMLAB-56,
 *    D-192; padrao = `ALLOWED_TRANSITIONS`) e importado, nunca reescrito: front
 *    e back leem a mesma funcao, entao divergir e impossivel por construcao.
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
  buildAllowedTransitions,
  checkTransition,
  isCardOwner,
  TERMINAL_STATUSES,
  calculateSubtotal,
  calculateTotal,
  isProposalEditable,
  RESEND_PROPOSAL_STATUSES,
  bitlabSendTarget,
  canActOnCard,
  type ApprovalStatus,
  type CreateMessageRequest,
  type CreateProposalItemInput,
  type Message,
  type CreateProposalRequest,
  type CreateProposalResponse,
  type ListProposalsResponse,
  type LossReason,
  type PaginationMeta,
  type Proposal,
  type ProposalDetail,
  type ProposalStatus,
  type StageAutomation,
} from '@crm-lab/shared';
import { randomUUID } from 'node:crypto';
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
import type { InsuranceRepository } from '../repositories/insurance.repository.js';
import * as auditRepo from '../repositories/audit.repository.js';
import { isUniqueViolation } from '../repositories/exam-package.repository.js';
import * as repo from '../repositories/proposal.repository.js';
import { reconcileProposal } from './lis-reconcile.service.js';
import { readFunnelRules } from './funnel-rules.service.js';
import type { ProposalRow } from '../repositories/proposal.repository.js';

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const MAX_ITEMS = 100;

/**
 * Teto de `page`. Sem ele, `?page=9007199254740991&limit=100` faz o `COUNT(*)`
 * completo e um scan com OFFSET absurdo — trabalho caro no banco por um
 * parametro de query. Com o teto de `limit` em 100, 10.000 paginas cobrem
 * 1.000.000 de linhas: muito alem de qualquer navegacao real, e o excedente e
 * grampeado (nao e erro) para seguir a mesma convencao do resto do clamp.
 */
export const MAX_PAGE = 10_000;

export interface ProposalFilters {
  /** Lista separada por virgula na query string (`?status=a,b`). */
  status?: string;
  conversationId?: string;
  /** Propostas do paciente (D-060) — a ficha lista por aqui, sem endpoint proprio. */
  patientId?: string;
  createdBy?: string;
  startDate?: string;
  endDate?: string;
  /** Nome do paciente, case-insensitive (pipeline busca por aqui). */
  search?: string;
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
   * Onda 7: valida `insuranceId` em `create` (existe e esta ativo no tenant).
   * `findById` ja roda sob `withTenant` — convenio de outro tenant e invisivel
   * pelo RLS, entao "inexistente" e "de outro tenant" caem no mesmo `null`
   * (API_CONTRACTS.md §3).
   */
  insurances: InsuranceRepository;
  /**
   * O MESMO cache que o AnalyticsService le. Toda mutacao de proposta muda
   * algum numero de relatorio, entao a mutacao invalida — ver
   * `invalidateAnalytics`.
   */
  cache: CacheService;
  /**
   * Envio pelo cartao (CRMLAB-58, D-201): o MESMO `createFromAgent` do
   * Composer do atendimento. Ausente => `/send` e `/resend` indisponiveis
   * (testes de unidade que nao enviam).
   */
  messages?: MessageSender;
}

/** A parte do `MessageService` que o envio pelo cartao usa. */
export interface MessageSender {
  createFromAgent(
    tenantId: string,
    conversationId: string,
    senderId: string,
    dto: CreateMessageRequest,
  ): Promise<Message>;
}

function isSupervisor(ctx: TenantContext): boolean {
  return ctx.role === 'manager' || ctx.role === 'admin';
}

/** Papeis que podem ser responsavel por uma proposta (D-202 item 3). */
const RESPONSIBLE_ROLES: readonly string[] = ['attendant', 'manager', 'admin'];

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
  // Cartao `bitlab` sem responsavel e fila comum do tenant (D-195 item 6).
  if (row.created_by === null && row.origin === 'bitlab') return true;
  return row.created_by === ctx.userId;
}

/**
 * Proposta de origem `bitlab` nao edita itens, desconto nem o nº do orcamento
 * (D-195 item 7): o valor e a identidade sao os do orcamento do Bitlab.
 */
function assertNotBitlab(row: ProposalRow): void {
  if (row.origin === 'bitlab') {
    throw new BusinessError('PROPOSAL_EDIT_NOT_ALLOWED', {
      status: row.status,
      reason: 'bitlab_origin',
    });
  }
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

/**
 * `undefined`/`null`/branco -> `null` (BUSINESS_RULES §10 — null tem um so
 * significado: "nenhum medico informado"). String vazia nunca e gravada.
 */
function normalizeRequestingDoctor(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
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

/**
 * O que toda transicao aceita grava na mesma transacao, venha de uma pessoa
 * (`updateStatus`) ou do sistema (`applySystemTransition`): a linha do historico e a
 * mensagem de sistema na conversa (WORKFLOWS §2 passo 6 e §4).
 */
async function recordTransitionInTx(
  tx: DbTx,
  input: {
    tenantId: string;
    proposalId: string;
    /** `null` na origem `bitlab` sem conversa: nao ha onde gravar a mensagem (D-195). */
    conversationId: string | null;
    status: ProposalStatus;
    changedBy: string | null;
    systemMessage: string | null;
    /** Motor de tempo (D-208): a regra que moveu e o instante injetado. */
    automation?: StageAutomation;
    changedAt?: Date;
  },
): Promise<void> {
  await repo.insertHistory(tx, {
    tenantId: input.tenantId,
    proposalId: input.proposalId,
    status: input.status,
    changedBy: input.changedBy,
    automation: input.automation,
    changedAt: input.changedAt,
  });
  if (input.systemMessage !== null && input.conversationId !== null) {
    await repo.insertSystemMessage(tx, {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      content: input.systemMessage,
    });
  }
}

/**
 * Quem pediu a transicao de sistema, gravado em `audit_logs.new_values.source`:
 * - `lis_payment`: pagamento no LIS fechando a proposta (D-252 item 1);
 * - `lis_requisition`: requisicao no LIS levando a proposta a negociacao (D-252 item 2);
 * - `rule`: prazo das Regras vencido, motor de tempo (CRMLAB-59, D-208).
 * Audits anteriores a D-252 podem ter `lis` (requisicao fechando proposta de
 * origem `crm`, D-119); nenhum codigo grava mais esse valor.
 */
export type SystemTransitionSource = 'lis_payment' | 'lis_requisition' | 'rule';

/** Uma transicao que o SISTEMA fez — o que `announceSystemTransitions` anuncia. */
export interface SystemTransition {
  proposalId: string;
  from: ProposalStatus;
  to: ProposalStatus;
  source: SystemTransitionSource;
}

/** A proposta como `applySystemTransition` a leu sob `FOR UPDATE` — o que `guard` confere. */
export interface LockedProposal {
  status: ProposalStatus;
  conversationId: string | null;
  lisPaidOn: unknown;
  lisRequisitionNumber: string | null;
}

/**
 * Transicao de estagio feita pelo SISTEMA, nao por uma pessoa (D-204 item 5,
 * substitui o antigo `markWonFromLis` da D-119; D-210 junta aqui a do motor
 * de tempo, D-208). Nao passa por `checkTransition`: vai de qualquer estagio
 * nao terminal para `to`. Roda na transacao de quem chama (conciliacao, motor
 * de tempo) e grava ali: historico com `changedBy: null` (e `automation`, se
 * veio), mensagem de sistema so se houver conversa (`systemMessage`), audit
 * `update_proposal_status` com `userId: null` e `newValues.source` (+
 * `auditExtra`). `lisReconciled` marca `lis_reconciled_at` (selo
 * "Conciliado", ganho que nao reabre). `closed_at` quando `to` e terminal;
 * `reasonLost` grava o motivo quando `to` e `perdido`.
 *
 * Travas do motor: `from` exige que o estagio atual seja esse; `guard` confere
 * o resto sob o lock (fatos, linha de entrada). `at` e o instante do
 * historico e do `closed_at` (ausente = `NOW()` do banco).
 *
 * `null` = nada feito: proposta inexistente, ja fechada, ja em `to`
 * (idempotencia), fora de `from` ou recusada pelo `guard`. WS e cache ficam
 * com quem chama, DEPOIS do commit (`announceSystemTransitions`).
 */
export async function applySystemTransition(
  tx: DbTx,
  tenantId: string,
  proposalId: string,
  input: {
    to: ProposalStatus;
    source: SystemTransitionSource;
    systemMessage: string | null;
    lisReconciled?: boolean;
    from?: ProposalStatus;
    guard?: (locked: LockedProposal) => Promise<boolean> | boolean;
    reasonLost?: LossReason;
    automation?: StageAutomation;
    at?: Date;
    auditExtra?: Record<string, unknown>;
  },
): Promise<SystemTransition | null> {
  const current = await tx.query<{
    status: string;
    conversation_id: string | null;
    lis_paid_on: unknown;
    lis_requisition_number: string | null;
  }>(
    `SELECT status, conversation_id, lis_paid_on, lis_requisition_number
       FROM proposals WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [proposalId, tenantId],
  );
  const before = current.rows[0];
  if (!before) return null;
  const from = before.status as ProposalStatus;
  if (isTerminal(from) || from === input.to) return null;
  if (input.from !== undefined && from !== input.from) return null;
  if (
    input.guard &&
    !(await input.guard({
      status: from,
      conversationId: before.conversation_id,
      lisPaidOn: before.lis_paid_on,
      lisRequisitionNumber: before.lis_requisition_number,
    }))
  ) {
    return null;
  }

  const closing = isTerminal(input.to);
  const reasonLost = input.to === 'perdido' ? (input.reasonLost ?? null) : null;
  const at = input.at ? input.at.toISOString() : null;
  const updated = await tx.query<{ id: string }>(
    `UPDATE proposals
        SET status = $3,
            closed_at = CASE WHEN $4::boolean THEN COALESCE($7::timestamp, NOW()) ELSE closed_at END,
            lis_reconciled_at = CASE WHEN $5::boolean THEN NOW() ELSE lis_reconciled_at END,
            reason_lost = COALESCE($6, reason_lost),
            updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND status = $8
      RETURNING id`,
    [proposalId, tenantId, input.to, closing, input.lisReconciled === true, reasonLost, at, from],
  );
  if (updated.rows.length === 0) return null;

  await recordTransitionInTx(tx, {
    tenantId,
    proposalId,
    conversationId: before.conversation_id,
    status: input.to,
    changedBy: null,
    systemMessage: input.systemMessage,
    automation: input.automation,
    changedAt: input.at,
  });
  await auditRepo.insert(tx, {
    tenantId,
    userId: null,
    action: 'update_proposal_status',
    entityType: 'proposal',
    entityId: proposalId,
    oldValues: { status: from },
    newValues: {
      status: input.to,
      source: input.source,
      ...input.auditExtra,
      ...(reasonLost !== null ? { reasonLost } : {}),
    },
  });
  return { proposalId, from, to: input.to, source: input.source };
}

/**
 * Depois do commit: um `proposal.status_changed` por transicao de sistema (com
 * o estagio de destino) e a invalidacao do cache de analytics. Falha de cache
 * nao derruba nada.
 */
export async function announceSystemTransitions(
  deps: { wsHub: WsHub; cache: CacheService },
  tenantId: string,
  transitions: readonly SystemTransition[],
): Promise<void> {
  if (transitions.length === 0) return;
  for (const transition of transitions) {
    deps.wsHub.emitToTenant(tenantId, 'proposal.status_changed', {
      proposalId: transition.proposalId,
      status: transition.to,
    });
  }
  try {
    await deps.cache.delByPrefix(analyticsCachePrefix(tenantId));
  } catch (err) {
    logger.warn('analytics.cache_invalidation_failed', {
      tenantId,
      detail: err instanceof Error ? err.message : 'erro desconhecido',
    });
  }
}

/** Nº do orcamento do LIS: so digitos, 1..20, sem zeros a esquerda (D-119 item 1). */
export function normalizeLisBudgetNumber(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d{1,20}$/.test(trimmed)) return null;
  return trimmed.replace(/^0+(?=\d)/, '');
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
    const { db, examCatalog, audit, approvals, insurances } = this.deps;

    // Regras do laboratorio (CRMLAB-56, D-193): "Criar proposta manualmente no
    // CRM" desligado recusa antes de qualquer outra validacao.
    const rules = await db.withTenant(ctx.tenantId, (tx) => readFunnelRules(tx, ctx.tenantId));
    if (!rules.origin.manualInCrm) {
      throw new BusinessError('MANUAL_PROPOSAL_DISABLED');
    }

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

    // `insuranceId` (Onda 7): se enviado, precisa existir e estar ATIVO neste
    // tenant (API_CONTRACTS.md §3) — convenio inexistente/de outro
    // tenant/inativo e VALIDATION_ERROR, e nao chega a resolver preco nenhum.
    const insuranceId = dto.insuranceId ?? null;
    if (insuranceId !== null) {
      const insurance = await insurances.findById(ctx.tenantId, insuranceId);
      if (!insurance || !insurance.isActive) {
        throw new BusinessError('VALIDATION_ERROR', {
          fields: { insuranceId: 'Convênio inválido ou inativo' },
        });
      }
    }

    // Precos do CATALOGO (sem cache), nunca do payload — BUSINESS_RULES §1.
    // Quando `insuranceId` esta presente, `resolveActiveByIds` acrescenta
    // `effectivePrice`/`priceSource` por exame, com fallback para o particular
    // quando o convenio nao tem preco cadastrado — o fallback NUNCA bloqueia.
    const resolution = await examCatalog.resolveActiveByIds(
      ctx.tenantId,
      dto.items.map((item) => item.examId),
      insuranceId ?? undefined,
    );
    if (resolution.invalidIds.length > 0) {
      throw new BusinessError('EXAM_NOT_FOUND_OR_INACTIVE', { examIds: resolution.invalidIds });
    }

    // Snapshot de nome, preco e origem do preco no momento da criacao (D-004,
    // estendido pela Onda 7 com `priceSource`).
    const items = dto.items.map((item) => {
      const exam = resolution.byId.get(item.examId);
      if (!exam) throw new BusinessError('EXAM_NOT_FOUND_OR_INACTIVE', { examIds: [item.examId] });
      return {
        examId: exam.id,
        examName: exam.name,
        quantity: item.quantity,
        unitPrice: exam.effectivePrice ?? exam.pricePrivate,
        priceSource: exam.priceSource ?? 'private',
      };
    });

    const totalPrice = calculateTotal(items, discountPercent);
    // CRMLAB-9: texto livre, opcional, sem cadastro de medicos.
    const requestingDoctor = normalizeRequestingDoctor(dto.requestingDoctor);

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
        insuranceId,
        requestingDoctor,
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
        requestingDoctor: created.detail.requestingDoctor,
        items: items.map((item) => ({
          examId: item.examId,
          examName: item.examName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          priceSource: item.priceSource,
        })),
      },
    });

    // Proposta nova entra no funil e no pipeline na hora.
    await this.invalidateAnalytics(ctx.tenantId);

    if (!created.withinLimit) {
      // Fluxo 3 de WORKFLOWS: post em #aprovacoes + WS para os gestores.
      await approvals.requestApproval(ctx, created.detail.id);
      // C7 (Onda 7): sem `message` pt-BR — `approvalStatus: 'pending'` ja diz
      // o que houve, e texto de UI e do frontend (i18n).
      return this.getById(ctx, created.detail.id);
    }

    return created.detail;
  }

  async getById(ctx: TenantContext, id: string): Promise<ProposalDetail> {
    return this.deps.db.withTenant(ctx.tenantId, async (tx) => {
      const row = await loadVisibleProposal(tx, ctx, id);
      return loadDetail(tx, row.id);
    });
  }

  /** `?status=a,b`, periodo, conversa, paciente (D-060) e autor. Envelope nomeado (D-009). */
  async list(ctx: TenantContext, filters: ProposalFilters): Promise<ListProposalsResponse> {
    const page = clamp(filters.page, DEFAULT_PAGE, 1, MAX_PAGE);
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
        // Paciente inexistente ou invisivel devolve lista VAZIA, nao 404: o
        // filtro nao e oraculo de existencia (D-060, como o `?createdBy=` de
        // D-042). O recorte por papel acima continua valendo por cima dele.
        ...(filters.patientId !== undefined ? { patientId: filters.patientId } : {}),
        ...(createdBy !== undefined ? { createdBy } : {}),
        // O atendente ve tambem a fila comum de cartoes `bitlab` sem responsavel (D-195 item 6).
        ...(ctx.role === 'attendant' ? { includeUnowned: true } : {}),
        ...(filters.startDate !== undefined ? { startDate: filters.startDate } : {}),
        ...(filters.endDate !== undefined ? { endDate: filters.endDate } : {}),
        ...(filters.search !== undefined ? { search: filters.search } : {}),
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
      // Travas do laboratorio (CRMLAB-56, D-192) — a MESMA funcao que o front
      // usa para esconder. Com os padroes: matriz ALLOWED_TRANSITIONS,
      // ganho/perdido terminais, motivo obrigatorio (D-191).
      const { manualMoves } = await readFunnelRules(tx, ctx.tenantId);

      // Ganho fechado pelo LIS nao reabre, com qualquer regra (D-192 item 2).
      if (isTerminal(from) && row.lis_reconciled_at !== null && row.lis_reconciled_at !== undefined) {
        throw new BusinessError('PROPOSAL_ALREADY_CLOSED', {
          status: from,
          reason: 'lis_reconciled',
        });
      }

      const denial = checkTransition(manualMoves, from, status, {
        role: ctx.role,
        isOwner: isCardOwner(row.created_by, ctx.userId),
      });
      if (denial === 'closed') {
        throw new BusinessError('PROPOSAL_ALREADY_CLOSED', { status: from });
      }
      if (denial === 'reopen_role') {
        throw new BusinessError('FORBIDDEN', { reason: 'reopen_not_allowed' });
      }
      if (denial === 'not_allowed') {
        throw new BusinessError('INVALID_STATUS_TRANSITION', {
          from,
          to: status,
          allowed: [...buildAllowedTransitions(manualMoves)[from]],
        });
      }
      if (denial === 'not_owner') {
        throw new BusinessError('FORBIDDEN', { reason: 'move_others_not_allowed' });
      }

      let loss: LossReason | null = null;
      if (status === 'perdido') {
        const missing = reasonLost === undefined || reasonLost === null || reasonLost === '';
        if (missing && manualMoves.requireLossReason) {
          throw new BusinessError('LOSS_REASON_REQUIRED');
        }
        if (!missing) {
          if (!isLossReason(reasonLost)) {
            throw new BusinessError('INVALID_LOSS_REASON', { allowed: [...LOSS_REASONS] });
          }
          loss = reasonLost;
        }
      }
      // Reabrir (D-192 item 2): sai do terminal limpando closedAt e reasonLost.
      const reopening = isTerminal(from) && !isTerminal(status);

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
        ...(reopening ? { closedAt: null, reasonLost: null } : {}),
      });
      if (!updated) throw notFound({ resource: 'proposal', id });

      // Mensagem de sistema na conversa (WORKFLOWS §2 passo 6 e §4).
      const ref = proposalRef(id);
      await recordTransitionInTx(tx, {
        tenantId: ctx.tenantId,
        proposalId: id,
        conversationId: row.conversation_id,
        status,
        changedBy: ctx.userId,
        systemMessage:
          status === 'orcamento_enviado'
            ? `Orçamento #${ref} enviado — ${formatMoney(Number(updated.total_price))}`
            : status === 'ganho'
              ? `Proposta #${ref} ganha! 🎉`
              : null,
      });

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
   * `PATCH /proposals/:id/lis-reference` (CRMLAB-52, D-119). Dona ou manager+.
   * Grava o vinculo e concilia NA MESMA transacao (item 3a): com a carga
   * incremental (D-185), orcamento que nao muda mais nunca volta pela API, entao
   * esperar a proxima sincronizacao deixaria a proposta sem conciliar.
   */
  async setLisReference(
    ctx: TenantContext,
    id: string,
    rawNumber: string | null,
  ): Promise<ProposalDetail> {
    const { db, audit } = this.deps;

    let lisBudgetNumber: string | null = null;
    if (rawNumber !== null) {
      lisBudgetNumber = normalizeLisBudgetNumber(rawNumber);
      if (lisBudgetNumber === null) {
        throw new BusinessError('VALIDATION_ERROR', {
          fields: { lisBudgetNumber: 'Informe só os dígitos do orçamento (até 20)' },
        });
      }
    }
    const number = lisBudgetNumber;

    let outcome: {
      previous: string | null;
      transitions: SystemTransition[];
      detail: ProposalDetail;
      absorbed: repo.LisBudgetHolder | null;
    };
    try {
      outcome = await db.withTenant(ctx.tenantId, async (tx) => {
        const row = await loadVisibleProposal(tx, ctx, id);
        if (row.created_by !== ctx.userId && ctx.role !== 'manager' && ctx.role !== 'admin') {
          throw new BusinessError('FORBIDDEN', { requiredRoles: ['manager', 'admin'] });
        }
        // O vinculo que fechou a proposta nao pode sumir depois (item 2).
        if (row.status === 'ganho') {
          throw new BusinessError('PROPOSAL_ALREADY_CLOSED', { status: row.status });
        }
        // O numero e a identidade do cartao `bitlab` (D-195 item 7).
        assertNotBitlab(row);

        let absorbed: repo.LisBudgetHolder | null = null;
        if (number !== null && number !== row.lis_budget_number) {
          const holder = await repo.findLisBudgetHolder(tx, number);
          if (holder !== null) {
            // D-198: cartao automatico que ninguem tocou e absorvido; o resto conflita.
            const absorbable =
              holder.origin === 'bitlab' &&
              holder.status === 'novo_contato' &&
              holder.sentAt === null &&
              holder.conversationId === null;
            if (!absorbable) {
              throw new BusinessError('CONFLICT', {
                reason: 'lis_budget_number_taken',
                proposalNumber: holder.proposalNumber,
              });
            }
            await repo.deleteProposal(tx, holder.id);
            await auditRepo.insert(tx, {
              tenantId: ctx.tenantId,
              userId: ctx.userId,
              action: 'absorb_bitlab_proposal',
              entityType: 'proposal',
              entityId: holder.id,
              oldValues: {
                proposalNumber: holder.proposalNumber,
                lisBudgetNumber: number,
                totalPrice: holder.totalPrice,
              },
              newValues: { absorbedBy: id },
              ipAddress: ctx.ip,
            });
            absorbed = holder;
          }
        }

        await repo.setLisBudgetNumber(tx, id, number);
        const transitions = number !== null ? await reconcileProposal(tx, ctx.tenantId, id) : [];
        const detail = await loadDetail(tx, id);
        return { previous: row.lis_budget_number, transitions, detail, absorbed };
      });
    } catch (err) {
      // Corrida entre dois PATCH com o mesmo numero: o indice unico decide.
      if (isUniqueViolation(err)) {
        throw new BusinessError('CONFLICT', { reason: 'lis_budget_number_taken' });
      }
      throw err;
    }

    if (outcome.previous !== number) {
      await audit.record(ctx, {
        action: 'update_proposal_lis_reference',
        entityType: 'proposal',
        entityId: id,
        oldValues: { lisBudgetNumber: outcome.previous },
        newValues: { lisBudgetNumber: number },
      });
    }

    if (outcome.absorbed !== null) {
      // O cartao absorvido some do Kanban (D-198).
      this.deps.wsHub.emitToTenant(ctx.tenantId, 'proposal.updated', {
        proposalId: outcome.absorbed.id,
      });
      await this.invalidateAnalytics(ctx.tenantId);
    }
    if (outcome.transitions.length > 0) {
      await announceSystemTransitions(this.deps, ctx.tenantId, outcome.transitions);
    } else {
      this.deps.wsHub.emitToTenant(ctx.tenantId, 'proposal.updated', { proposalId: id });
    }
    return outcome.detail;
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
      assertNotBitlab(row);

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

  /**
   * Substitui itens e, opcionalmente, desconto e medico solicitante
   * (CRMLAB-12, D-132). `insuranceId` fica de fora — continua imutavel
   * (D-082). So permitido em `novo_contato`/`orcamento_enviado`
   * (`isProposalEditable`); fora disso, `PROPOSAL_EDIT_NOT_ALLOWED` (409).
   *
   * Precos SEMPRE resolvidos pelo catalogo (mesma regra de `create`, D-003) —
   * o cliente nunca envia preco. A alcada e reavaliada exatamente como em
   * `updateDiscount`: se o desconto (informado ou mantido) estourar o limite
   * do autor, a proposta volta para `pending` e dispara nova aprovacao,
   * reaproveitando o fluxo existente em vez de bloquear a edicao.
   */
  async updateItems(
    ctx: TenantContext,
    id: string,
    dto: {
      items: CreateProposalItemInput[];
      discountPercent?: number;
      requestingDoctor?: string | null;
    },
  ): Promise<ProposalDetail> {
    const { db, audit, approvals, examCatalog } = this.deps;

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
    if (
      dto.discountPercent !== undefined &&
      (!Number.isFinite(dto.discountPercent) || dto.discountPercent < 0 || dto.discountPercent > 100)
    ) {
      throw new BusinessError('VALIDATION_ERROR', {
        fields: { discountPercent: 'Percentual deve estar entre 0 e 100' },
      });
    }

    // `db.withTenant` NAO aninha (nota no topo do arquivo) — a leitura do
    // convenio gravado e a resolucao de preco no catalogo (outro service)
    // precisam ficar FORA da transacao de escrita que segue, mesma
    // arquitetura de `create`. O estagio e reconferido de novo dentro da
    // transacao de escrita (linha abaixo) para o caso raro de mudanca
    // concorrente entre as duas leituras.
    const preCheck = await db.withTenant(ctx.tenantId, (tx) => loadVisibleProposal(tx, ctx, id));
    if (isTerminal(preCheck.status as ProposalStatus)) {
      throw new BusinessError('PROPOSAL_ALREADY_CLOSED', { status: preCheck.status });
    }
    assertNotBitlab(preCheck);
    if (!isProposalEditable(preCheck.status as ProposalStatus)) {
      throw new BusinessError('PROPOSAL_EDIT_NOT_ALLOWED', { status: preCheck.status });
    }

    // Precos do CATALOGO (sem cache), com o convenio JA GRAVADO da proposta —
    // insuranceId permanece imutavel (D-082).
    const resolution = await examCatalog.resolveActiveByIds(
      ctx.tenantId,
      dto.items.map((item) => item.examId),
      preCheck.insurance_id ?? undefined,
    );
    if (resolution.invalidIds.length > 0) {
      throw new BusinessError('EXAM_NOT_FOUND_OR_INACTIVE', { examIds: resolution.invalidIds });
    }
    const items = dto.items.map((item) => {
      const exam = resolution.byId.get(item.examId);
      if (!exam) {
        throw new BusinessError('EXAM_NOT_FOUND_OR_INACTIVE', { examIds: [item.examId] });
      }
      return {
        examId: exam.id,
        examName: exam.name,
        quantity: item.quantity,
        unitPrice: exam.effectivePrice ?? exam.pricePrivate,
        priceSource: exam.priceSource ?? 'private',
      };
    });

    const outcome = await db.withTenant(ctx.tenantId, async (tx) => {
      const row = await loadVisibleProposal(tx, ctx, id);
      const status = row.status as ProposalStatus;
      if (isTerminal(status)) {
        throw new BusinessError('PROPOSAL_ALREADY_CLOSED', { status });
      }
      if (!isProposalEditable(status)) {
        throw new BusinessError('PROPOSAL_EDIT_NOT_ALLOWED', { status });
      }

      const discountPercent = dto.discountPercent ?? Number(row.discount_percent);
      const userLimit = await readDiscountLimit(tx, ctx.userId, ctx.discountLimit);
      const withinLimit = discountPercent <= userLimit;

      // Mesma recusa de `updateDiscount`: subir o desconto de proposta de
      // TERCEIRO acima da propria alcada nao vira pedido de aprovacao (D-045).
      if (
        dto.discountPercent !== undefined &&
        !withinLimit &&
        row.created_by !== ctx.userId
      ) {
        throw new BusinessError('DISCOUNT_EXCEEDS_LIMIT', {
          requestedDiscount: discountPercent,
          userLimit,
          approvalRequired: true,
        });
      }

      const totalPrice = calculateTotal(items, discountPercent);
      const requestingDoctor =
        dto.requestingDoctor !== undefined
          ? normalizeRequestingDoctor(dto.requestingDoctor)
          : row.requesting_doctor;
      const now = new Date().toISOString();

      await repo.deleteItems(tx, id);
      await repo.insertItems(tx, ctx.tenantId, id, items);

      const updated = await repo.updateProposal(tx, id, {
        discountPercent,
        totalPrice,
        requestingDoctor,
        approvalStatus: withinLimit ? 'approved' : 'pending',
        approvedBy: withinLimit ? ctx.userId : null,
        approvedAt: withinLimit ? now : null,
      });
      if (!updated) throw notFound({ resource: 'proposal', id });

      const detail = await loadDetail(tx, id);
      return {
        detail,
        previous: {
          discountPercent: Number(row.discount_percent),
          totalPrice: Number(row.total_price),
          approvalStatus: row.approval_status,
          requestingDoctor: row.requesting_doctor,
        },
        withinLimit,
      };
    });

    await audit.record(ctx, {
      action: 'update_proposal_items',
      entityType: 'proposal',
      entityId: id,
      oldValues: {
        discountPercent: outcome.previous.discountPercent,
        totalPrice: outcome.previous.totalPrice,
        approvalStatus: outcome.previous.approvalStatus,
        requestingDoctor: outcome.previous.requestingDoctor,
      },
      newValues: {
        items: outcome.detail.items.map((item) => ({
          examId: item.examId,
          examName: item.examName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          priceSource: item.priceSource,
        })),
        discountPercent: outcome.detail.discountPercent,
        totalPrice: outcome.detail.totalPrice,
        approvalStatus: outcome.detail.approvalStatus,
        requestingDoctor: outcome.detail.requestingDoctor,
      },
    });

    await this.invalidateAnalytics(ctx.tenantId);

    if (!outcome.withinLimit) {
      await approvals.requestApproval(ctx, id);
    }

    this.deps.wsHub.emitToTenant(ctx.tenantId, 'proposal.updated', { proposalId: id });

    return outcome.detail;
  }

  // -------------------------------------------------------------------------
  // Envio pelo cartao do Bitlab (CRMLAB-58, D-200..D-202)
  // -------------------------------------------------------------------------

  private requireMessages(): MessageSender {
    if (!this.deps.messages) throw new Error('ProposalService sem MessageSender (envio pelo cartao)');
    return this.deps.messages;
  }

  /**
   * Conversa que QUEM CHAMA enxerga (D-200 item 3): atendente, as dela e a
   * fila livre; gestor/admin, todas. De outro tenant (RLS) ou fora da
   * visibilidade -> `NOT_FOUND`, nunca `FORBIDDEN`.
   */
  private async loadVisibleConversation(
    tx: DbTx,
    ctx: TenantContext,
    conversationId: string,
  ): Promise<repo.ConversationRef> {
    const conversation = await repo.findConversation(tx, conversationId);
    const visible =
      conversation !== null &&
      (isSupervisor(ctx) ||
        conversation.assignedTo === null ||
        conversation.assignedTo === ctx.userId);
    if (!conversation || !visible) {
      throw notFound({ resource: 'conversation', id: conversationId });
    }
    return conversation;
  }

  /**
   * `POST /proposals/:id/send` — tudo ou nada em tres passos (D-201):
   * reserva (trava de linha) -> envio pelo caminho do atendimento -> vinculo.
   * O cartao so muda no ultimo passo; falha do envio desfaz a reserva.
   */
  async sendFromCard(
    ctx: TenantContext,
    id: string,
    dto: { conversationId: string; message: string },
  ): Promise<ProposalDetail> {
    const { db, wsHub } = this.deps;
    const messages = this.requireMessages();
    const claimId = randomUUID();

    // 1. Reserva.
    const claim = await db.withTenant(ctx.tenantId, async (tx) => {
      const lock = await repo.lockForSend(tx, id);
      const row = lock ? await repo.findRowById(tx, id) : null;
      if (!lock || !row) throw notFound({ resource: 'proposal', id });
      if (!canSeeProposal(ctx, row)) {
        // Quem perdeu a corrida via o cartao na fila comum um instante antes; o
        // envio da colega o tirou da visibilidade dela. "Ja enviado" e o erro
        // que ela entende, e nao revela nada alem do que a fila ja mostrava.
        if (row.origin === 'bitlab' && row.conversation_id !== null) {
          throw new BusinessError('PROPOSAL_ALREADY_SENT', { reason: 'sent' });
        }
        throw notFound({ resource: 'proposal', id });
      }
      if (row.origin !== 'bitlab') {
        throw new BusinessError('PROPOSAL_EDIT_NOT_ALLOWED', {
          status: row.status,
          reason: 'crm_origin',
        });
      }
      const from = row.status as ProposalStatus;
      if (isTerminal(from)) throw new BusinessError('PROPOSAL_ALREADY_CLOSED', { status: from });
      // Enviado = vinculado a uma conversa (o envio e o unico caminho do vinculo).
      if (row.conversation_id !== null) {
        throw new BusinessError('PROPOSAL_ALREADY_SENT', { reason: 'sent' });
      }
      if (lock.claimAlive) throw new BusinessError('PROPOSAL_ALREADY_SENT', { reason: 'in_progress' });

      const rules = await readFunnelRules(tx, ctx.tenantId);
      const to = bitlabSendTarget(row.lis_requisition_number, rules.automation);
      if (from !== 'novo_contato') {
        throw new BusinessError('INVALID_STATUS_TRANSITION', { from, to, allowed: [] });
      }
      if (
        !canActOnCard(rules.manualMoves, {
          role: ctx.role,
          isOwner: isCardOwner(row.created_by, ctx.userId),
        })
      ) {
        throw new BusinessError('FORBIDDEN', { reason: 'move_others_not_allowed' });
      }

      const conversation = await this.loadVisibleConversation(tx, ctx, dto.conversationId);
      if (conversation.status !== 'active') {
        throw new BusinessError('CONVERSATION_ARCHIVED', { status: conversation.status });
      }

      await repo.claimSend(tx, id, claimId);
      return { to, previousOwner: row.created_by };
    });

    // 2. Envio — fora da transacao, pelo mesmo caminho do Composer.
    let sent: Message;
    try {
      sent = await messages.createFromAgent(ctx.tenantId, dto.conversationId, ctx.userId, {
        content: dto.message,
        messageType: 'text',
      });
    } catch (err) {
      await db.withTenant(ctx.tenantId, (tx) => repo.releaseSend(tx, id, claimId));
      throw err;
    }

    // 3. Vinculo.
    let outcome: { from: ProposalStatus; to: ProposalStatus; detail: ProposalDetail };
    try {
      outcome = await db.withTenant(ctx.tenantId, async (tx) => {
        const moved = await repo.finalizeSend(tx, {
          id,
          claimId,
          conversationId: dto.conversationId,
          createdBy: ctx.userId,
          status: claim.to,
        });
        if (!moved) throw new BusinessError('PROPOSAL_ALREADY_SENT', { reason: 'in_progress' });

        const current = await repo.findRowById(tx, id);
        if (moved.from !== moved.to) {
          await recordTransitionInTx(tx, {
            tenantId: ctx.tenantId,
            proposalId: id,
            conversationId: dto.conversationId,
            status: moved.to,
            changedBy: ctx.userId,
            systemMessage: `Orçamento #${proposalRef(id)} enviado — ${formatMoney(
              Number(current?.total_price ?? 0),
            )}`,
          });
        }
        await auditRepo.insert(tx, {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          action: 'update_proposal_status',
          entityType: 'proposal',
          entityId: id,
          oldValues: { status: moved.from, conversationId: null, createdBy: claim.previousOwner },
          newValues: {
            status: moved.to,
            source: 'send',
            conversationId: dto.conversationId,
            createdBy: ctx.userId,
            messageId: sent.id,
          },
          ipAddress: ctx.ip,
        });
        return { ...moved, detail: await loadDetail(tx, id) };
      });
    } catch (err) {
      // D-201, risco declarado: a mensagem saiu e o vinculo nao gravou.
      logger.error('proposal.send_finalize_failed', {
        tenantId: ctx.tenantId,
        proposalId: id,
        messageId: sent.id,
        reason: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    if (outcome.from !== outcome.to) {
      wsHub.emitToTenant(ctx.tenantId, 'proposal.status_changed', {
        proposalId: id,
        status: outcome.to,
      });
    } else {
      wsHub.emitToTenant(ctx.tenantId, 'proposal.updated', { proposalId: id });
    }
    await this.invalidateAnalytics(ctx.tenantId);
    return outcome.detail;
  }

  /** Dona, gestor ou admin — para as correcoes depois do envio (D-202). */
  private assertOwnerOrSupervisor(ctx: TenantContext, row: ProposalRow): void {
    if (isSupervisor(ctx) || row.created_by === ctx.userId) return;
    throw new BusinessError('FORBIDDEN', { reason: 'not_owner' });
  }

  /** Cartao `bitlab` ja vinculado: pre-condicao de reenviar e de trocar a conversa. */
  private assertLinkedBitlab(row: ProposalRow): void {
    if (row.origin !== 'bitlab') {
      throw new BusinessError('PROPOSAL_EDIT_NOT_ALLOWED', {
        status: row.status,
        reason: 'crm_origin',
      });
    }
    if (isTerminal(row.status as ProposalStatus)) {
      throw new BusinessError('PROPOSAL_ALREADY_CLOSED', { status: row.status });
    }
    if (row.conversation_id === null) {
      throw new BusinessError('PROPOSAL_EDIT_NOT_ALLOWED', {
        status: row.status,
        reason: 'not_sent',
      });
    }
  }

  /** `POST /proposals/:id/resend` (D-202 item 1): sem mudar estagio nem `sent_at`. */
  async resendFromCard(ctx: TenantContext, id: string, message: string): Promise<Message> {
    const messages = this.requireMessages();
    const row = await this.deps.db.withTenant(ctx.tenantId, (tx) =>
      loadVisibleProposal(tx, ctx, id),
    );
    this.assertLinkedBitlab(row);
    const status = row.status as ProposalStatus;
    if (!RESEND_PROPOSAL_STATUSES.includes(status)) {
      throw new BusinessError('INVALID_STATUS_TRANSITION', {
        from: status,
        to: status,
        allowed: [...RESEND_PROPOSAL_STATUSES],
      });
    }
    this.assertOwnerOrSupervisor(ctx, row);
    const conversationId = row.conversation_id as string;

    const sent = await messages.createFromAgent(ctx.tenantId, conversationId, ctx.userId, {
      content: message,
      messageType: 'text',
    });
    await this.deps.audit.record(ctx, {
      action: 'resend_proposal_message',
      entityType: 'proposal',
      entityId: id,
      newValues: { conversationId, messageId: sent.id },
    });
    return sent;
  }

  /** `PATCH /proposals/:id/conversation` (D-202 item 2). Nao envia mensagem. */
  async relinkConversation(
    ctx: TenantContext,
    id: string,
    conversationId: string,
  ): Promise<ProposalDetail> {
    const outcome = await this.deps.db.withTenant(ctx.tenantId, async (tx) => {
      const row = await loadVisibleProposal(tx, ctx, id);
      this.assertLinkedBitlab(row);
      this.assertOwnerOrSupervisor(ctx, row);
      await this.loadVisibleConversation(tx, ctx, conversationId);
      const previous = row.conversation_id;
      if (previous === conversationId) return { changed: false, detail: await loadDetail(tx, id) };
      await repo.setConversation(tx, id, conversationId);
      await auditRepo.insert(tx, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: 'update_proposal_conversation',
        entityType: 'proposal',
        entityId: id,
        oldValues: { conversationId: previous },
        newValues: { conversationId },
        ipAddress: ctx.ip,
      });
      return { changed: true, detail: await loadDetail(tx, id) };
    });
    if (outcome.changed) {
      this.deps.wsHub.emitToTenant(ctx.tenantId, 'proposal.updated', { proposalId: id });
      await this.invalidateAnalytics(ctx.tenantId);
    }
    return outcome.detail;
  }

  /**
   * `PATCH /proposals/:id/responsible` (D-202 item 3). Gestor/admin: qualquer
   * usuario ativo do laboratorio, em qualquer estagio. Atendente: so o cartao
   * de que e dona, aberto, para outra atendente ativa.
   */
  async setResponsible(ctx: TenantContext, id: string, userId: string): Promise<ProposalDetail> {
    const outcome = await this.deps.db.withTenant(ctx.tenantId, async (tx) => {
      const row = await loadVisibleProposal(tx, ctx, id);
      const supervisor = isSupervisor(ctx);
      if (!supervisor) {
        if (row.created_by !== ctx.userId) {
          throw new BusinessError('FORBIDDEN', { reason: 'not_owner' });
        }
        if (isTerminal(row.status as ProposalStatus)) {
          throw new BusinessError('FORBIDDEN', { reason: 'closed' });
        }
      }
      const target = await repo.findTenantUser(tx, ctx.tenantId, userId);
      const allowedRoles = supervisor ? RESPONSIBLE_ROLES : ['attendant'];
      if (!target || !target.isActive || !allowedRoles.includes(target.role)) {
        throw new BusinessError('VALIDATION_ERROR', {
          fields: {
            userId: supervisor
              ? 'Usuário inexistente ou inativo neste laboratório'
              : 'Escolha outra atendente ativa deste laboratório',
          },
        });
      }
      const previous = row.created_by;
      if (previous === userId) return { changed: false, detail: await loadDetail(tx, id) };
      await repo.setResponsible(tx, id, userId);
      await auditRepo.insert(tx, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: 'update_proposal_responsible',
        entityType: 'proposal',
        entityId: id,
        oldValues: { createdBy: previous },
        newValues: { createdBy: userId },
        ipAddress: ctx.ip,
      });
      return { changed: true, detail: await loadDetail(tx, id) };
    });
    if (outcome.changed) {
      this.deps.wsHub.emitToTenant(ctx.tenantId, 'proposal.updated', { proposalId: id });
      // Ranking e comissao sao por responsavel.
      await this.invalidateAnalytics(ctx.tenantId);
    }
    return outcome.detail;
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
