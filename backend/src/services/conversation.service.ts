/**
 * ConversationService — SERVICES.md §2.
 *
 * ============================================================================
 * DUAS CAMADAS DE RECORTE, NAO UMA
 * ============================================================================
 * O RLS (`db.withTenant`) resolve o isolamento ENTRE laboratorios. Ele nao diz
 * nada sobre quem, DENTRO do laboratorio, pode ver o que. Essa segunda camada e
 * regra de negocio e mora aqui:
 *
 *   atendente  -> as conversas atribuidas a ele + a fila nao atribuida
 *   gestor/adm -> todas as conversas do tenant
 *
 * LER conversa de outro ATENDENTE do mesmo tenant devolve `NOT_FOUND`, nao
 * `FORBIDDEN`: 403 confirmaria que aquele id existe (CLAUDE.md regra 8).
 *
 * A unica excecao e `assign`: quem clicou "Assumir" um segundo tarde demais
 * recebe `CONVERSATION_ALREADY_ASSIGNED` com o nome de quem pegou, porque essa
 * e a informacao que a tela precisa mostrar — e a conversa estava visivel para
 * ele (na fila livre) ate o instante anterior.
 *
 * ============================================================================
 * COUNTS DOS CHIPS (BUSINESS_RULES §5)
 * ============================================================================
 * `counts.mine` e `counts.unassigned` sao os numeros de "Minhas N" e "Nao
 * atribuidas N" da tela de Atendimento. Saem do MESMO `SELECT` da listagem, via
 * `COUNT(*) FILTER (...)` — nunca de contador mantido a parte, que e exatamente
 * o que "um numero, uma origem" proibe.
 *
 * ============================================================================
 * CORRIDA DE ATRIBUICAO
 * ============================================================================
 * Duas pessoas clicam "Assumir" no mesmo instante. Quem decide e o banco:
 * `UPDATE ... WHERE assigned_to IS NULL`. Quem afetar 0 linhas perdeu e recebe
 * `CONVERSATION_ALREADY_ASSIGNED` (409) com `details: { assignedTo,
 * assignedToName }` — o frontend mostra "Ana ja assumiu esta conversa".
 *
 * Isso e mais forte que o lock otimista por `updated_at` sugerido em
 * SERVICES.md §2: nao existe leitura previa cujo valor possa envelhecer entre o
 * SELECT e o UPDATE. A condicao esta na propria escrita.
 *
 * ============================================================================
 * TRANSFERENCIA (WORKFLOWS §5)
 * ============================================================================
 * Reatribuir uma conversa JA atribuida gera a mensagem de sistema "Conversa
 * transferida de A para B" e nao apaga nada: o historico inteiro continua
 * visivel para quem recebe.
 *
 * ============================================================================
 * ENCERRAR / REABRIR (D-174)
 * ============================================================================
 * `active | closed`. Encerrar e reativar pelo PATCH: so a dona, gestor ou
 * admin — `FORBIDDEN` para quem enxerga a conversa mas nao e dona (fila livre
 * inclusive). Encerrar mantem a dona e grava "Atendimento encerrado por X".
 * Reabre sozinha: paciente escreveu (`MessageService.createFromPatient`, fila
 * livre) ou atendimento manual no mesmo telefone (`createManual`, para quem
 * cadastrou).
 */
import type {
  Conversation,
  ConversationAssignee,
  ConversationDetail,
  CreateConversationRequest,
  ConversationStatus,
  ListConversationsQuery,
  ListConversationsResponse,
  PaginationMeta,
  UpdateConversationRequest,
} from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError, notFound } from '../http/errors.js';
import type { AuditService } from './audit.service.js';
import type { MessageService } from './message.service.js';
import {
  isConversationSortBy,
  phoneDigits,
  type ConversationListCriteria,
  type ConversationRepository,
  type ConversationSortBy,
  type SortOrder,
} from '../repositories/conversation.repository.js';
import * as userRepo from '../repositories/user.repository.js';

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
/**
 * Teto de `page` (Onda 7, pendencia mecanica — mesmo motivo de
 * `proposal.service.ts`). Sem ele, `?page=9007199254740991` produz um
 * `OFFSET` absurdo na consulta.
 */
export const MAX_PAGE = 10_000;
/** Teto da lista de `GET /conversations/assignees` — equipe de laboratorio. */
export const MAX_ASSIGNEES = 200;
export const DEFAULT_SORT_BY: ConversationSortBy = 'lastMessageAt';
export const DEFAULT_ORDER: SortOrder = 'desc';

/**
 * Telefone digitado a mao -> o mesmo formato que o webhook grava (`+5548...`).
 *
 * Sem isto o dedupe por telefone erraria justamente onde ele importa: o
 * atendente digita "(48) 99999-1234" (11 digitos) para um paciente que ja
 * conversa pelo WhatsApp como "+5548999991234" (13) — `selectByPhone` compara
 * digito a digito e criaria uma SEGUNDA conversa e um segundo paciente.
 * rangel: +55 fixo — produto pt-BR, tenant unico pais. Vira coluna do tenant
 * quando existir laboratorio fora do Brasil.
 */
function toE164(phone: string): string {
  const digits = phoneDigits(phone);
  return digits.length <= 11 ? `+55${digits}` : `+${digits}`;
}

/** Papeis que enxergam TODAS as conversas do laboratorio. */
const SUPERVISOR_ROLES = ['manager', 'admin'] as const;

function isSupervisor(ctx: TenantContext): boolean {
  return ctx.role === 'manager' || ctx.role === 'admin';
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(Number(value))) return fallback;
  return Math.min(Math.max(Math.trunc(Number(value)), min), max);
}

/** Query string -> criterio normalizado (com a visibilidade ja resolvida). */
export function toCriteria(
  ctx: TenantContext,
  filters: ListConversationsQuery,
): ConversationListCriteria {
  const sortBy =
    filters.sortBy !== undefined && isConversationSortBy(filters.sortBy)
      ? filters.sortBy
      : DEFAULT_SORT_BY;
  const search = filters.search?.trim();
  return {
    visibleTo: isSupervisor(ctx) ? null : ctx.userId,
    userId: ctx.userId,
    scope: filters.scope ?? 'all',
    ...(filters.status !== undefined ? { status: filters.status } : {}),
    ...(search !== undefined && search.length > 0 ? { search } : {}),
    page: clampInt(filters.page, DEFAULT_PAGE, 1, MAX_PAGE),
    limit: clampInt(filters.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
    sortBy,
    order: filters.order === 'asc' ? 'asc' : DEFAULT_ORDER,
  };
}

function paginationOf(criteria: ConversationListCriteria, total: number): PaginationMeta {
  return {
    page: criteria.page,
    limit: criteria.limit,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / criteria.limit),
  };
}

export interface ConversationServiceDeps {
  db: DbClient;
  conversations: ConversationRepository;
  messages: MessageService;
  audit: AuditService;
}

export class ConversationService {
  private readonly db: DbClient;
  private readonly repository: ConversationRepository;
  private readonly messages: MessageService;
  private readonly audit: AuditService;

  constructor(deps: ConversationServiceDeps) {
    this.db = deps.db;
    this.repository = deps.conversations;
    this.messages = deps.messages;
    this.audit = deps.audit;
  }

  /** Listagem paginada + os counts dos chips, do mesmo `SELECT`. */
  async list(
    ctx: TenantContext,
    filters: ListConversationsQuery = {},
  ): Promise<ListConversationsResponse> {
    const criteria = toCriteria(ctx, filters);
    const page = await this.repository.list(ctx.tenantId, criteria);
    return {
      conversations: page.rows,
      pagination: paginationOf(criteria, page.total),
      counts: page.counts,
    };
  }

  /**
   * Uma conversa. Inexistente, de outro tenant OU de outro atendente => 404.
   * Os tres casos respondem igual de proposito: a resposta nao pode diferenciar
   * "nao existe" de "existe e nao e sua".
   */
  async getById(ctx: TenantContext, id: string): Promise<ConversationDetail> {
    const conversation = await this.repository.findById(ctx.tenantId, id);
    if (!conversation || !this.canSee(ctx, conversation)) {
      throw notFound({ resource: 'conversation', id });
    }
    return conversation;
  }

  /**
   * Ponto de entrada do webhook (WORKFLOWS §1): acha a conversa do telefone ou
   * cria uma nova, ja na fila nao atribuida.
   *
   * A conversa nasce JA LIGADA ao paciente (`conversations.patient_id`, D-059):
   * o repositorio cria/reaproveita a linha de `patients` dentro da MESMA
   * transacao. Chamar o `PatientService` daqui abriria uma segunda transacao
   * (D-008: o driver de teste tem uma conexao so), entao a ligacao mora no
   * repositorio — ver `conversation.repository.findOrCreateByPhone`.
   *
   * Recebe `tenantId` e nao `TenantContext` porque quem chama e o canal
   * externo, sem usuario logado — a assinatura de SERVICES.md §2.
   */
  async findOrCreateByPhone(
    tenantId: string,
    phone: string,
    patientName?: string | null,
  ): Promise<ConversationDetail> {
    const { conversation, created } = await this.repository.findOrCreateByPhone(tenantId, {
      patientPhone: phone,
      patientName: patientName ?? null,
      channel: 'whatsapp',
    });
    if (created) {
      await this.audit.log({
        tenantId,
        userId: null,
        action: 'create_conversation',
        entityType: 'conversation',
        entityId: conversation.id,
        newValues: { patientPhone: conversation.patientPhone, channel: conversation.channel },
      });
    }
    return conversation;
  }

  /**
   * Atendimento que NAO veio do WhatsApp: ligacao, balcao, site
   * (API_CONTRACTS.md §2, PAGES.md §5).
   *
   * Mesmo caminho do webhook — `findOrCreateByPhone` dedupe por telefone e liga
   * o cadastro de `patients` na MESMA transacao (D-059) —, com duas diferencas:
   * o canal vem do formulario e a conversa nasce ATRIBUIDA a quem cadastrou.
   */
  async createManual(
    ctx: TenantContext,
    dto: CreateConversationRequest,
  ): Promise<ConversationDetail> {
    const found = await this.repository.findOrCreateByPhone(ctx.tenantId, {
      patientPhone: toE164(dto.patientPhone),
      patientName: dto.patientName,
      patientEmail: dto.patientEmail ?? null,
      channel: dto.channel,
      assignedTo: ctx.userId,
    });
    const { created } = found;
    let conversation = found.conversation;

    // Conversa ENCERRADA naquele telefone (D-174): o atendimento novo reabre e
    // e de quem cadastrou, qualquer que fosse a dona antiga. Perdeu a corrida
    // (o paciente reabriu no mesmo instante)? Segue com o estado relido.
    if (!created && conversation.status === 'closed') {
      conversation = await this.reopenManually(ctx, conversation);
    }

    // Telefone que ja e de OUTRO atendente. Nao rouba a conversa, e tambem nao
    // devolve 404 como `getById`: aqui o 404 mandaria o atendente montar um
    // orcamento numa conversa que ele nao consegue abrir. O 409 diz de quem e —
    // a mesma informacao que a corrida de "Assumir" mostra.
    if (!created && !this.canSee(ctx, conversation)) {
      throw new BusinessError('CONVERSATION_ALREADY_ASSIGNED', {
        assignedTo: conversation.assignedTo,
        assignedToName: conversation.assignedToName,
      });
    }

    if (created) {
      await this.audit.record(ctx, {
        action: 'create_conversation',
        entityType: 'conversation',
        entityId: conversation.id,
        newValues: { patientPhone: conversation.patientPhone, channel: conversation.channel },
      });
    }
    return conversation;
  }

  /**
   * Assume, transfere ou devolve a conversa para a fila.
   *
   * - fila livre  -> `UPDATE ... WHERE assigned_to IS NULL` decide a corrida
   * - ja atribuida -> so o proprio dono, gestor ou admin transferem; qualquer
   *   outro recebe `CONVERSATION_ALREADY_ASSIGNED`
   * - transferencia gera a mensagem de sistema de WORKFLOWS §5
   */
  async assign(
    ctx: TenantContext,
    id: string,
    userId: string | null,
  ): Promise<ConversationDetail> {
    const current = await this.repository.findById(ctx.tenantId, id);
    if (!current) throw notFound({ resource: 'conversation', id });

    // Aqui o recorte por papel NAO vira 404: quem tentou assumir uma conversa
    // que outra pessoa acabou de pegar precisa saber DE QUEM ela e — e o que
    // `CONVERSATION_ALREADY_ASSIGNED` carrega em `details`. Quem cuida disso e
    // `assertCanReassign`, chamado nos dois ramos que reatribuem.
    const target = userId === null ? null : await this.requireTenantUser(ctx.tenantId, userId);

    // --- devolver para a fila -------------------------------------------------
    if (target === null) {
      this.assertCanReassign(ctx, current);
      const released = await this.repository.setAssignee(ctx.tenantId, id, null);
      if (!released) throw notFound({ resource: 'conversation', id });
      await this.recordAssignment(ctx, current, released);
      if (current.assignedTo !== null) {
        await this.messages.createSystemEvent(
          ctx.tenantId,
          id,
          `Conversa devolvida para a fila por ${current.assignedToName ?? 'um atendente'}`,
        );
      }
      return released;
    }

    // --- ja e do proprio alvo: idempotente -----------------------------------
    if (current.assignedTo === target.id) return current;

    // --- fila livre: a corrida e decidida pelo banco -------------------------
    if (current.assignedTo === null) {
      const claimed = await this.repository.claimIfUnassigned(ctx.tenantId, id, target.id);
      if (claimed) {
        await this.recordAssignment(ctx, current, claimed);
        return claimed;
      }
      // Perdeu a corrida: alguem atribuiu entre o SELECT e o UPDATE.
      throw await this.alreadyAssigned(ctx.tenantId, id);
    }

    // --- transferencia (WORKFLOWS §5) ----------------------------------------
    this.assertCanReassign(ctx, current);
    const transferred = await this.repository.setAssignee(ctx.tenantId, id, target.id);
    if (!transferred) throw notFound({ resource: 'conversation', id });

    await this.recordAssignment(ctx, current, transferred);
    // O historico NAO e tocado: quem recebe ve a conversa inteira.
    await this.messages.createSystemEvent(
      ctx.tenantId,
      id,
      `Conversa transferida de ${current.assignedToName ?? 'fila'} para ${target.name}`,
    );
    return transferred;
  }

  /**
   * Quem pode receber uma conversa — a lista do menu "Transferir"
   * (API_CONTRACTS.md §2). Aberta a qualquer papel de tenant porque quem mais
   * transfere e a atendente, e `GET /users` e admin-only.
   *
   * Devolve so id/nome/papel: e-mail e alcada nao tem por que sair daqui.
   * rangel: reaproveita `userRepo.list` com um teto alto em vez de uma query
   * propria — equipe de laboratorio nao passa disso. Vira consulta paginada
   * quando algum tenant encostar no limite.
   */
  async listAssignees(ctx: TenantContext): Promise<ConversationAssignee[]> {
    const { users } = await this.db.withTenant(ctx.tenantId, (tx) =>
      userRepo.list(tx, { page: 1, limit: MAX_ASSIGNEES, isActive: true }),
    );
    return users
      .filter((user) => user.role !== 'platform_operator')
      .map((user) => ({
        id: user.id,
        name: user.name,
        role: user.role as ConversationAssignee['role'],
      }));
  }

  /**
   * Encerrar / reativar (D-174). A alcada vem DEPOIS do recorte por papel:
   * conversa de outra atendente continua 404; o 403 so aparece em conversa que
   * o usuario ja enxerga (a da fila livre, para atendente).
   */
  async updateStatus(
    ctx: TenantContext,
    id: string,
    status: ConversationStatus,
  ): Promise<ConversationDetail> {
    const current = await this.repository.findById(ctx.tenantId, id);
    if (!current || !this.canSee(ctx, current)) {
      throw notFound({ resource: 'conversation', id });
    }
    if (!isSupervisor(ctx) && current.assignedTo !== ctx.userId) {
      throw new BusinessError('FORBIDDEN', { requiredRoles: [...SUPERVISOR_ROLES] });
    }
    if (current.status === status) return current;

    const updated = await this.repository.setStatus(ctx.tenantId, id, status);
    if (!updated) throw notFound({ resource: 'conversation', id });

    await this.audit.record(ctx, {
      action: 'update_conversation_status',
      entityType: 'conversation',
      entityId: id,
      oldValues: { status: current.status },
      newValues: { status: updated.status },
    });
    if (status === 'closed') {
      const name = await this.userName(ctx);
      await this.messages.createSystemEvent(
        ctx.tenantId,
        id,
        `Atendimento encerrado por ${name}`,
      );
    }
    return updated;
  }

  async updateTags(ctx: TenantContext, id: string, tags: string[]): Promise<ConversationDetail> {
    const current = await this.repository.findById(ctx.tenantId, id);
    if (!current || !this.canSee(ctx, current)) {
      throw notFound({ resource: 'conversation', id });
    }
    const updated = await this.repository.setTags(ctx.tenantId, id, tags);
    if (!updated) throw notFound({ resource: 'conversation', id });
    return updated;
  }

  /**
   * `PATCH /conversations/:id` — aplica status, atribuicao e tags numa chamada,
   * cada campo pelo seu caminho (com as regras de cada um).
   */
  async update(
    ctx: TenantContext,
    id: string,
    patch: UpdateConversationRequest,
  ): Promise<ConversationDetail> {
    // Ordem proposital: status e tags ANTES da atribuicao. Um atendente que
    // transfere e encerra na mesma chamada deixaria de enxergar a conversa no
    // meio do caminho se a atribuicao viesse primeiro.
    let current: ConversationDetail | null = null;
    if (patch.status !== undefined) current = await this.updateStatus(ctx, id, patch.status);
    if (patch.tags !== undefined) current = await this.updateTags(ctx, id, patch.tags);
    if (patch.assignedTo !== undefined) current = await this.assign(ctx, id, patch.assignedTo);
    return current ?? (await this.getById(ctx, id));
  }

  /**
   * Fixa/desafixa a conversa para o usuario logado (Onda 8 §2.3).
   *
   * O recorte por papel vem antes da escrita — `getById` ja converte conversa
   * inexistente, de outro tenant ou de outra atendente em 404. Sem audit log:
   * pin e preferencia de tela, nao ato sobre o atendimento.
   */
  async setPinned(ctx: TenantContext, id: string, pinned: boolean): Promise<void> {
    await this.getById(ctx, id);
    if (pinned) await this.repository.pin(ctx.tenantId, id, ctx.userId);
    else await this.repository.unpin(ctx.tenantId, id, ctx.userId);
  }

  /** Zera `unread_count` e marca as mensagens do paciente como lidas. */
  async markAsRead(ctx: TenantContext, id: string): Promise<void> {
    const current = await this.repository.findById(ctx.tenantId, id);
    if (!current || !this.canSee(ctx, current)) {
      throw notFound({ resource: 'conversation', id });
    }
    await this.repository.markAsRead(ctx.tenantId, id);
  }

  // -------------------------------------------------------------------------
  // internos
  // -------------------------------------------------------------------------

  /** Reabre para quem cadastrou o atendimento manual (D-174). */
  private async reopenManually(
    ctx: TenantContext,
    closed: ConversationDetail,
  ): Promise<ConversationDetail> {
    const reopened = await this.repository.reopenIfClosed(ctx.tenantId, closed.id, ctx.userId);
    if (!reopened) {
      return (await this.repository.findById(ctx.tenantId, closed.id)) ?? closed;
    }
    await this.audit.record(ctx, {
      action: 'update_conversation_status',
      entityType: 'conversation',
      entityId: closed.id,
      oldValues: { status: closed.status, assignedTo: closed.assignedTo },
      newValues: { status: reopened.status, assignedTo: reopened.assignedTo },
    });
    await this.messages.createSystemEvent(
      ctx.tenantId,
      closed.id,
      `Atendimento reaberto por ${reopened.assignedToName ?? 'um atendente'}`,
    );
    return reopened;
  }

  /** Nome de quem esta logado, para o evento de sistema. */
  private async userName(ctx: TenantContext): Promise<string> {
    const user = await this.db.withTenant(ctx.tenantId, (tx) => userRepo.findById(tx, ctx.userId));
    return user?.name ?? 'um atendente';
  }

  /** Atendente ve as proprias + as livres; gestor/admin veem todas. */
  private canSee(ctx: TenantContext, conversation: Conversation): boolean {
    if (isSupervisor(ctx)) return true;
    return conversation.assignedTo === null || conversation.assignedTo === ctx.userId;
  }

  /** So o dono atual, gestor ou admin reatribuem uma conversa ja atribuida. */
  private assertCanReassign(ctx: TenantContext, current: Conversation): void {
    if (current.assignedTo === null) return;
    if (isSupervisor(ctx) || current.assignedTo === ctx.userId) return;
    throw new BusinessError('CONVERSATION_ALREADY_ASSIGNED', {
      assignedTo: current.assignedTo,
      assignedToName: current.assignedToName,
      requiredRoles: [...SUPERVISOR_ROLES],
    });
  }

  /** O alvo da atribuicao precisa ser um usuario ATIVO deste tenant. */
  private async requireTenantUser(
    tenantId: string,
    userId: string,
  ): Promise<{ id: string; name: string }> {
    const user = await this.db.withTenant(tenantId, (tx) => userRepo.findById(tx, userId));
    if (!user || !user.isActive) {
      throw new BusinessError('VALIDATION_ERROR', {
        fields: { assignedTo: 'Usuario inexistente ou inativo neste laboratorio' },
      });
    }
    return { id: user.id, name: user.name };
  }

  /** Le quem ganhou a corrida para montar `details` do 409. */
  private async alreadyAssigned(tenantId: string, id: string): Promise<BusinessError> {
    const winner = await this.repository.findById(tenantId, id);
    return new BusinessError('CONVERSATION_ALREADY_ASSIGNED', {
      assignedTo: winner?.assignedTo ?? null,
      assignedToName: winner?.assignedToName ?? null,
    });
  }

  private async recordAssignment(
    ctx: TenantContext,
    before: Conversation,
    after: Conversation,
  ): Promise<void> {
    await this.audit.record(ctx, {
      action: 'assign_conversation',
      entityType: 'conversation',
      entityId: after.id,
      oldValues: { assignedTo: before.assignedTo },
      newValues: { assignedTo: after.assignedTo },
    });
  }
}
