/**
 * Rotas de propostas — API_CONTRACTS.md §3.
 *
 *   GET   /api/v1/proposals               atendente ve as proprias; gestor/admin, todas
 *   GET   /api/v1/proposals/:id           detalhe (items, subtotal, history)
 *   POST  /api/v1/proposals               cria (precos vem do catalogo)
 *   PATCH /api/v1/proposals/:id/status    transicao de estagio
 *   PATCH /api/v1/proposals/:id/discount  novo desconto (total recalculado)
 *   PATCH /api/v1/proposals/:id/items     substitui itens/desconto/medico solicitante
 *                                         (CRMLAB-12, D-132) — so em novo_contato/orcamento_enviado
 *   PATCH /api/v1/proposals/:id/lis-reference  nº do orcamento no LIS (CRMLAB-52, D-119):
 *                                         dona ou manager+, concilia na mesma transacao
 *   POST  /api/v1/proposals/:id/send      "Enviar orcamento" do cartao do Bitlab (CRMLAB-58, D-200/D-201)
 *   POST  /api/v1/proposals/:id/resend    "Reenviar mensagem" pela conversa vinculada (D-202)
 *   PATCH /api/v1/proposals/:id/conversation  troca a conversa vinculada (D-202)
 *   PATCH /api/v1/proposals/:id/responsible   edita o responsavel (D-202)
 *   PATCH /api/v1/proposals/:id/approve   manager/admin
 *   PATCH /api/v1/proposals/:id/reject    manager/admin (motivo obrigatorio)
 *
 * Controller fino (CONVENTIONS.md): valida o DTO, chama o service, responde.
 * `tenantId` vem SEMPRE de `getContext(req)` — nunca de query/body/header.
 *
 * O DTO de criacao NAO aceita preco nem total: `.strict()` recusa campos extras,
 * entao um cliente que tentar mandar `totalPrice` recebe `VALIDATION_ERROR` em
 * vez de ser silenciosamente ignorado (BUSINESS_RULES §1).
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  LOSS_REASONS,
  PROPOSAL_STATUSES,
  SEND_PROPOSAL_MESSAGE_MAX,
  type CreateProposalResponse,
  type Message,
  type ListProposalsResponse,
  type ProposalDetail,
  type UpdateProposalItemsResponse,
} from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { ExamRepository } from '../repositories/exam.repository.js';
import { InsuranceRepository } from '../repositories/insurance.repository.js';
import { ExamCatalogService } from '../services/exam-catalog.service.js';
import { createAuditService } from '../services/audit.service.js';
import { createInternalChatService } from '../services/internal-chat.service.js';
import { ApprovalService } from '../services/approval.service.js';
import { createMessageService } from '../services/message.service.js';
import { MAX_LIMIT, ProposalService, type ProposalFilters } from '../services/proposal.service.js';
import type { WhatsAppService } from '../services/whatsapp.service.js';

const statusEnum = z.enum(
  PROPOSAL_STATUSES as unknown as [string, ...string[]],
);
const lossReasonEnum = z.enum(LOSS_REASONS as unknown as [string, ...string[]]);

export const listProposalsQuerySchema = z.object({
  /** Lista separada por virgula: `?status=novo_contato,orcamento_enviado`. */
  status: z.string().max(200).optional(),
  conversationId: z.string().uuid().optional(),
  /** `?patientId=` — propostas do paciente (D-060). */
  patientId: z.string().uuid().optional(),
  createdBy: z.string().uuid().optional(),
  startDate: z.string().min(4).max(40).optional(),
  endDate: z.string().min(4).max(40).optional(),
  /** `?search=` — nome do paciente, case-insensitive. */
  search: z.string().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  sortBy: z.enum(['createdAt', 'updatedAt', 'totalPrice', 'status']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

export const createProposalSchema = z
  .object({
    conversationId: z.string().uuid(),
    items: z
      .array(
        z
          .object({
            examId: z.string().uuid(),
            quantity: z.number().int().positive().max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    discountPercent: z.number().min(0).max(100).optional(),
    // Onda 7: convenio da proposta. Ausente/`null` = particular. Imutavel apos
    // a criacao — nao existe campo equivalente em `updateDiscountSchema`.
    insuranceId: z.string().uuid().nullable().optional(),
    // CRMLAB-9: medico solicitante, texto livre. Ausente/`null`/vazio = nao
    // informado — o `.trim()` normaliza espacos antes do `.max()`, e o
    // service ainda converte string vazia para `null` (ver
    // `normalizeRequestingDoctor`). Sem cadastro/autocomplete de medicos.
    requestingDoctor: z.string().trim().max(255).nullable().optional(),
  })
  .strict();

export const updateStatusSchema = z
  .object({
    status: statusEnum,
    reasonLost: lossReasonEnum.optional(),
  })
  .strict();

export const updateDiscountSchema = z
  .object({ discountPercent: z.number().min(0).max(100) })
  .strict();

/** CRMLAB-12 / D-132 — `insuranceId` fica de fora: continua imutavel (D-082). */
export const updateItemsSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            examId: z.string().uuid(),
            quantity: z.number().int().positive().max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    discountPercent: z.number().min(0).max(100).optional(),
    requestingDoctor: z.string().trim().max(255).nullable().optional(),
  })
  .strict();

// A forma (so digitos, 1..20) e checada no service, que normaliza e devolve
// VALIDATION_ERROR com `details.fields.lisBudgetNumber` (API_CONTRACTS.md §3).
export const updateLisReferenceSchema = z
  .object({ lisBudgetNumber: z.string().max(40).nullable() })
  .strict();

/** CRMLAB-58 (D-200..D-202) — mesma faixa de `POST /conversations/:id/messages`. */
const sendMessageText = z.string().trim().min(1).max(SEND_PROPOSAL_MESSAGE_MAX);

export const sendProposalSchema = z
  .object({ conversationId: z.string().uuid(), message: sendMessageText })
  .strict();

export const resendProposalSchema = z.object({ message: sendMessageText }).strict();

export const updateConversationSchema = z.object({ conversationId: z.string().uuid() }).strict();

export const updateResponsibleSchema = z.object({ userId: z.string().uuid() }).strict();

export const rejectSchema = z.object({ reason: z.string().min(1).max(500) }).strict();

export const proposalIdParamSchema = z.object({ id: z.string().uuid() });

type CreateProposalBody = z.infer<typeof createProposalSchema>;
type UpdateStatusBody = z.infer<typeof updateStatusSchema>;
type UpdateDiscountBody = z.infer<typeof updateDiscountSchema>;
type UpdateItemsBody = z.infer<typeof updateItemsSchema>;
type UpdateLisReferenceBody = z.infer<typeof updateLisReferenceSchema>;
type RejectBody = z.infer<typeof rejectSchema>;
type SendProposalBody = z.infer<typeof sendProposalSchema>;
type ResendProposalBody = z.infer<typeof resendProposalSchema>;
type UpdateConversationBody = z.infer<typeof updateConversationSchema>;
type UpdateResponsibleBody = z.infer<typeof updateResponsibleSchema>;

/** `Promise` rejeitada em handler async precisa chegar ao error-handler. */
function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export interface ProposalModuleServices {
  proposals: ProposalService;
  approvals: ApprovalService;
}

/**
 * Monta a arvore de services do dominio de propostas.
 *
 * O ciclo Proposal <-> Approval e resolvido aqui: o ApprovalService e criado
 * primeiro e injetado no ProposalService pela interface `ApprovalRequester`.
 */
export interface ProposalModuleOverrides {
  /** O teste injeta o driver do canal (sucesso, falha) — mesmo padrao do modulo de conversas. */
  whatsapp?: WhatsAppService;
}

export function createProposalServices(
  deps: ApiModuleDeps,
  overrides: ProposalModuleOverrides = {},
): ProposalModuleServices {
  const audit = createAuditService(deps.db);
  const chat = createInternalChatService(deps.db, deps.wsHub);
  const examCatalog = new ExamCatalogService(new ExamRepository(deps.db), deps.cache);
  const approvals = new ApprovalService({
    db: deps.db,
    wsHub: deps.wsHub,
    audit,
    chat,
  });
  const proposals = new ProposalService({
    db: deps.db,
    wsHub: deps.wsHub,
    audit,
    examCatalog,
    approvals,
    // Mesmo cache do AnalyticsService: mutacao de proposta invalida relatorio.
    cache: deps.cache,
    // Onda 7: valida `insuranceId` em `create` (existe e ativo no tenant).
    insurances: new InsuranceRepository(deps.db),
    // Envio pelo cartao (CRMLAB-58): o MESMO caminho do Composer do atendimento.
    messages: createMessageService(deps, overrides.whatsapp ? { whatsapp: overrides.whatsapp } : {}),
  });
  return { proposals, approvals };
}

export function listProposals(service: ProposalService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const filters = validated<ProposalFilters>(req, 'query');
    const body: ListProposalsResponse = await service.list(ctx, filters);
    res.status(200).json(body);
  });
}

export function getProposal(service: ProposalService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const detail: ProposalDetail = await service.getById(ctx, id);
    res.status(200).json(detail);
  });
}

export function createProposal(service: ProposalService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const dto = validated<CreateProposalBody>(req, 'body');
    const created: CreateProposalResponse = await service.create(ctx, {
      conversationId: dto.conversationId,
      items: dto.items,
      ...(dto.discountPercent !== undefined ? { discountPercent: dto.discountPercent } : {}),
      ...(dto.insuranceId !== undefined ? { insuranceId: dto.insuranceId } : {}),
      ...(dto.requestingDoctor !== undefined ? { requestingDoctor: dto.requestingDoctor } : {}),
    });
    res.status(201).json(created);
  });
}

export function updateProposalStatus(service: ProposalService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<UpdateStatusBody>(req, 'body');
    const proposal = await service.updateStatus(
      ctx,
      id,
      dto.status as ProposalDetail['status'],
      dto.reasonLost,
    );
    // Resposta parcial, exatamente como o contrato mostra.
    res.status(200).json({
      id: proposal.id,
      status: proposal.status,
      reasonLost: proposal.reasonLost,
      updatedAt: proposal.updatedAt,
    });
  });
}

export function updateProposalDiscount(service: ProposalService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<UpdateDiscountBody>(req, 'body');
    const proposal = await service.updateDiscount(ctx, id, dto.discountPercent);
    res.status(200).json({
      id: proposal.id,
      discountPercent: proposal.discountPercent,
      totalPrice: proposal.totalPrice,
    });
  });
}

export function updateProposalItems(service: ProposalService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<UpdateItemsBody>(req, 'body');
    const detail: UpdateProposalItemsResponse = await service.updateItems(ctx, id, {
      items: dto.items,
      ...(dto.discountPercent !== undefined ? { discountPercent: dto.discountPercent } : {}),
      ...(dto.requestingDoctor !== undefined ? { requestingDoctor: dto.requestingDoctor } : {}),
    });
    res.status(200).json(detail);
  });
}

export function updateProposalLisReference(service: ProposalService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<UpdateLisReferenceBody>(req, 'body');
    const detail: ProposalDetail = await service.setLisReference(ctx, id, dto.lisBudgetNumber);
    res.status(200).json(detail);
  });
}

export function sendProposal(service: ProposalService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<SendProposalBody>(req, 'body');
    const detail: ProposalDetail = await service.sendFromCard(ctx, id, dto);
    res.status(200).json(detail);
  });
}

export function resendProposal(service: ProposalService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<ResendProposalBody>(req, 'body');
    const message: Message = await service.resendFromCard(ctx, id, dto.message);
    res.status(201).json(message);
  });
}

export function updateProposalConversation(service: ProposalService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<UpdateConversationBody>(req, 'body');
    const detail: ProposalDetail = await service.relinkConversation(ctx, id, dto.conversationId);
    res.status(200).json(detail);
  });
}

export function updateProposalResponsible(service: ProposalService): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<UpdateResponsibleBody>(req, 'body');
    const detail: ProposalDetail = await service.setResponsible(ctx, id, dto.userId);
    res.status(200).json(detail);
  });
}

export function approveProposal(services: ProposalModuleServices): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    await services.approvals.approve(ctx, id);
    const detail = await services.proposals.getById(ctx, id);
    // Projecao parcial registrada na tabela de excecoes de D-070. Sem `message`:
    // texto de UI e do frontend (i18n), e `approvalStatus` ja diz o que houve.
    res.status(200).json({
      id: detail.id,
      approvalStatus: detail.approvalStatus,
      approvedAt: detail.approvedAt,
    });
  });
}

export function rejectProposal(services: ProposalModuleServices): RequestHandler {
  return handle(async (req, res) => {
    const ctx = getContext(req);
    const { id } = validated<{ id: string }>(req, 'params');
    const dto = validated<RejectBody>(req, 'body');
    await services.approvals.reject(ctx, id, dto.reason);
    const detail = await services.proposals.getById(ctx, id);
    // Simetrico a /approve: projecao parcial, sem texto de UI (ver D-070).
    res.status(200).json({
      id: detail.id,
      approvalStatus: detail.approvalStatus,
      approvedAt: detail.approvedAt,
    });
  });
}

export function makeProposalModule(
  overrides: ProposalModuleOverrides = {},
): (deps: ApiModuleDeps) => ApiModule {
  return (deps) => buildProposalModule(deps, overrides);
}

export function proposalModule(deps: ApiModuleDeps): ApiModule {
  return buildProposalModule(deps, {});
}

function buildProposalModule(deps: ApiModuleDeps, overrides: ProposalModuleOverrides): ApiModule {
  const services = createProposalServices(deps, overrides);
  const router = Router();

  router.get(
    '/',
    requireAuth(),
    denyPlatformOperator(),
    validate(listProposalsQuerySchema, 'query'),
    listProposals(services.proposals),
  );

  router.get(
    '/:id',
    requireAuth(),
    denyPlatformOperator(),
    validate(proposalIdParamSchema, 'params'),
    getProposal(services.proposals),
  );

  router.post(
    '/',
    requireAuth(),
    denyPlatformOperator(),
    validate(createProposalSchema, 'body'),
    createProposal(services.proposals),
  );

  router.patch(
    '/:id/status',
    requireAuth(),
    denyPlatformOperator(),
    validate(proposalIdParamSchema, 'params'),
    validate(updateStatusSchema, 'body'),
    updateProposalStatus(services.proposals),
  );

  router.patch(
    '/:id/discount',
    requireAuth(),
    denyPlatformOperator(),
    validate(proposalIdParamSchema, 'params'),
    validate(updateDiscountSchema, 'body'),
    updateProposalDiscount(services.proposals),
  );

  router.patch(
    '/:id/items',
    requireAuth(),
    denyPlatformOperator(),
    validate(proposalIdParamSchema, 'params'),
    validate(updateItemsSchema, 'body'),
    updateProposalItems(services.proposals),
  );

  router.patch(
    '/:id/lis-reference',
    requireAuth(),
    denyPlatformOperator(),
    validate(proposalIdParamSchema, 'params'),
    validate(updateLisReferenceSchema, 'body'),
    updateProposalLisReference(services.proposals),
  );

  router.post(
    '/:id/send',
    requireAuth(),
    denyPlatformOperator(),
    validate(proposalIdParamSchema, 'params'),
    validate(sendProposalSchema, 'body'),
    sendProposal(services.proposals),
  );

  router.post(
    '/:id/resend',
    requireAuth(),
    denyPlatformOperator(),
    validate(proposalIdParamSchema, 'params'),
    validate(resendProposalSchema, 'body'),
    resendProposal(services.proposals),
  );

  router.patch(
    '/:id/conversation',
    requireAuth(),
    denyPlatformOperator(),
    validate(proposalIdParamSchema, 'params'),
    validate(updateConversationSchema, 'body'),
    updateProposalConversation(services.proposals),
  );

  router.patch(
    '/:id/responsible',
    requireAuth(),
    denyPlatformOperator(),
    validate(proposalIdParamSchema, 'params'),
    validate(updateResponsibleSchema, 'body'),
    updateProposalResponsible(services.proposals),
  );

  // `denyPlatformOperator()` ANTES de `requireRoles`: o operador da plataforma
  // nao tem caminho para dado de laboratorio por decisao propria (PAGES.md §11),
  // e nao de tabela — hoje ele tambem cairia no `requireRoles`, mas essa defesa
  // sumiria no dia em que os papeis fossem afrouxados.
  // `requireRoles` ANTES do `validate`: atendente recebe FORBIDDEN com
  // `details.requiredRoles`, e nao um VALIDATION_ERROR que vazaria o shape.
  router.patch(
    '/:id/approve',
    requireAuth(),
    denyPlatformOperator(),
    requireRoles('manager', 'admin'),
    validate(proposalIdParamSchema, 'params'),
    approveProposal(services),
  );

  router.patch(
    '/:id/reject',
    requireAuth(),
    denyPlatformOperator(),
    requireRoles('manager', 'admin'),
    validate(proposalIdParamSchema, 'params'),
    validate(rejectSchema, 'body'),
    rejectProposal(services),
  );

  return { basePath: '/proposals', router, requiresAuth: true };
}
