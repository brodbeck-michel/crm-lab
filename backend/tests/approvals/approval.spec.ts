/**
 * ApprovalService — SERVICES.md §6 e WORKFLOWS.md §3.
 *
 * O fluxo completo do doc: atendente cria 25% -> pending -> post em #aprovacoes
 * -> gestor decide dentro da PROPRIA alcada -> criador notificado -> auditado.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { isBusinessError } from '../../src/http/errors.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import {
  createConversation,
  createExam,
  createProposal,
  createTenant,
  createUser,
} from '../helpers/factories.js';
import { FakeWsHub } from '../helpers/fake-ws.js';
import {
  auditActionsFor,
  buildHarness,
  channelPosts,
  ctxOf,
  type Harness,
} from '../proposals/support.js';

async function businessErrorOf(promise: Promise<unknown>): Promise<{
  code: string;
  statusCode: number;
  details?: Record<string, unknown>;
}> {
  try {
    await promise;
  } catch (err) {
    if (isBusinessError(err)) {
      return {
        code: err.code,
        statusCode: err.statusCode,
        ...(err.details !== undefined ? { details: err.details } : {}),
      };
    }
    throw err;
  }
  throw new Error('Esperava BusinessError, mas a promise resolveu');
}

describe('ApprovalService', () => {
  let db: DbClient;
  let h: Harness;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    h = buildHarness(db, new FakeWsHub());
  });

  /** Atendente (15%) cria proposta de R$ 200 com o desconto pedido. */
  async function cenarioPendente(discountPercent = 25): Promise<{
    tenantId: string;
    attendant: Awaited<ReturnType<typeof createUser>>;
    manager: Awaited<ReturnType<typeof createUser>>;
    admin: Awaited<ReturnType<typeof createUser>>;
    proposalId: string;
  }> {
    const tenant = await createTenant();
    const attendant = await createUser({
      tenantId: tenant.id,
      role: 'attendant',
      discountLimit: 15,
    });
    const manager = await createUser({ tenantId: tenant.id, role: 'manager', discountLimit: 30 });
    const admin = await createUser({ tenantId: tenant.id, role: 'admin', discountLimit: 100 });
    const conversation = await createConversation({ tenantId: tenant.id });
    const exam = await createExam({ tenantId: tenant.id, pricePrivate: 200 });

    const created = await h.proposals.create(ctxOf(attendant), {
      conversationId: conversation.id,
      items: [{ examId: exam.id, quantity: 1 }],
      discountPercent,
    });
    h.wsHub.clear();

    return { tenantId: tenant.id, attendant, manager, admin, proposalId: created.id };
  }

  it('gestor aprova dentro da alcada: status, aprovador e notificacao ao criador', async () => {
    const c = await cenarioPendente(25);

    const approved = await h.approvals.approve(ctxOf(c.manager), c.proposalId);
    expect(approved.approvalStatus).toBe('approved');

    const detail = await h.proposals.getById(ctxOf(c.manager), c.proposalId);
    expect(detail.approvedBy).toBe(c.manager.id);
    expect(detail.approvedByName).toBe(c.manager.name);
    expect(detail.approvedAt).not.toBeNull();

    const eventos = h.wsHub.eventsForUser(c.tenantId, c.attendant.id, 'approval.decided');
    expect(eventos).toHaveLength(1);
    expect(eventos[0]?.data).toEqual({ proposalId: c.proposalId, decision: 'approved' });

    expect(await auditActionsFor(db, c.proposalId)).toContain('approve_proposal_discount');
  });

  it('proposta aprovada pode enfim ser enviada ao paciente', async () => {
    const c = await cenarioPendente(25);
    await h.approvals.approve(ctxOf(c.manager), c.proposalId);

    const sent = await h.proposals.updateStatus(
      ctxOf(c.attendant),
      c.proposalId,
      'orcamento_enviado',
    );
    expect(sent.status).toBe('orcamento_enviado');
  });

  it('gestor de 30% NAO aprova 40% -> APPROVAL_NOT_ALLOWED com discount e approverLimit', async () => {
    const c = await cenarioPendente(40);

    const error = await businessErrorOf(h.approvals.approve(ctxOf(c.manager), c.proposalId));
    expect(error.code).toBe('APPROVAL_NOT_ALLOWED');
    expect(error.statusCode).toBe(403);
    expect(error.details).toEqual({ discount: 40, approverLimit: 30 });

    // Continua pendente — e o admin (100%) resolve.
    const admin = await h.approvals.approve(ctxOf(c.admin), c.proposalId);
    expect(admin.approvalStatus).toBe('approved');
  });

  it.each(['attendant'] as const)('%s nao decide -> FORBIDDEN', async (role) => {
    const c = await cenarioPendente(25);
    const outro = await createUser({ tenantId: c.tenantId, role, discountLimit: 15 });

    const aprovacao = await businessErrorOf(h.approvals.approve(ctxOf(outro), c.proposalId));
    expect(aprovacao.code).toBe('FORBIDDEN');
    expect(aprovacao.details).toEqual({ requiredRoles: ['manager', 'admin'] });

    const rejeicao = await businessErrorOf(h.approvals.reject(ctxOf(outro), c.proposalId, 'nao'));
    expect(rejeicao.code).toBe('FORBIDDEN');
  });

  it('ninguem aprova a propria proposta — nem admin (D-046)', async () => {
    const tenant = await createTenant();
    const admin = await createUser({ tenantId: tenant.id, role: 'admin', discountLimit: 100 });
    const conversation = await createConversation({ tenantId: tenant.id });
    const exam = await createExam({ tenantId: tenant.id, pricePrivate: 100 });

    // Admin cria com 90% (dentro da alcada dele) e depois tem a alcada reduzida:
    // e o unico caminho em que o criador chegaria a decidir sobre si mesmo.
    const created = await h.proposals.create(ctxOf(admin), {
      conversationId: conversation.id,
      items: [{ examId: exam.id, quantity: 1 }],
      discountPercent: 90,
    });
    await db.withoutTenant((tx) =>
      tx.query('UPDATE proposals SET approval_status = $1 WHERE id = $2', [
        'pending',
        created.id,
      ]),
    );

    const error = await businessErrorOf(h.approvals.approve(ctxOf(admin), created.id));
    expect(error.code).toBe('FORBIDDEN');
    expect(error.details).toEqual({ reason: 'self_approval' });
  });

  it('rejeicao exige motivo e o motivo aparece em ProposalDetail.rejectionReason', async () => {
    const c = await cenarioPendente(25);

    const semMotivo = await businessErrorOf(h.approvals.reject(ctxOf(c.manager), c.proposalId, '  '));
    expect(semMotivo.code).toBe('VALIDATION_ERROR');

    const rejected = await h.approvals.reject(
      ctxOf(c.manager),
      c.proposalId,
      'Margem insuficiente neste convenio',
    );
    expect(rejected.approvalStatus).toBe('rejected');

    const detail = await h.proposals.getById(ctxOf(c.manager), c.proposalId);
    expect(detail.rejectionReason).toBe('Margem insuficiente neste convenio');
    // `approvedBy` null continua significando "nao foi aprovada" (§10).
    expect(detail.approvedBy).toBeNull();

    const eventos = h.wsHub.eventsForUser(c.tenantId, c.attendant.id, 'approval.decided');
    expect(eventos[0]?.data).toEqual({ proposalId: c.proposalId, decision: 'rejected' });
    expect(await auditActionsFor(db, c.proposalId)).toContain('reject_proposal_discount');
  });

  it('proposta rejeitada nao vai ao paciente; ajustar o desconto reabre o caminho', async () => {
    const c = await cenarioPendente(25);
    await h.approvals.reject(ctxOf(c.manager), c.proposalId, 'Desconto alto demais');

    // Rejeitada tambem nao vai ao paciente (D-047).
    const bloqueio = await businessErrorOf(
      h.proposals.updateStatus(ctxOf(c.attendant), c.proposalId, 'orcamento_enviado'),
    );
    expect(bloqueio.code).toBe('PROPOSAL_PENDING_APPROVAL');
    expect(bloqueio.details).toEqual({ approvalStatus: 'rejected' });

    // Caminho documentado: ajusta o desconto para dentro da alcada e envia.
    const ajustada = await h.proposals.updateDiscount(ctxOf(c.attendant), c.proposalId, 10);
    expect(ajustada.approvalStatus).toBe('approved');

    const enviada = await h.proposals.updateStatus(
      ctxOf(c.attendant),
      c.proposalId,
      'orcamento_enviado',
    );
    expect(enviada.status).toBe('orcamento_enviado');
  });

  it('decisao so vale uma vez: aprovar duas vezes -> CONFLICT', async () => {
    const c = await cenarioPendente(25);
    await h.approvals.approve(ctxOf(c.manager), c.proposalId);

    const error = await businessErrorOf(h.approvals.approve(ctxOf(c.manager), c.proposalId));
    expect(error.code).toBe('CONFLICT');
    expect(error.details).toEqual({ approvalStatus: 'approved' });
  });

  it('proposta encerrada nao recebe decisao', async () => {
    const tenant = await createTenant();
    const manager = await createUser({ tenantId: tenant.id, role: 'manager', discountLimit: 30 });
    const proposal = await createProposal({
      tenantId: tenant.id,
      status: 'perdido',
      approvalStatus: 'pending',
      discountPercent: 25,
      totalPrice: 10,
    });

    const error = await businessErrorOf(h.approvals.approve(ctxOf(manager), proposal.id));
    expect(error.code).toBe('PROPOSAL_ALREADY_CLOSED');
  });

  it('listPending mostra a fila do tenant e so para quem decide', async () => {
    const c = await cenarioPendente(25);
    const outroTenant = await createTenant();
    await createProposal({
      tenantId: outroTenant.id,
      approvalStatus: 'pending',
      discountPercent: 50,
      totalPrice: 10,
    });

    const fila = await h.approvals.listPending(ctxOf(c.manager));
    expect(fila).toHaveLength(1);
    expect(fila[0]?.id).toBe(c.proposalId);

    const negado = await businessErrorOf(h.approvals.listPending(ctxOf(c.attendant)));
    expect(negado.code).toBe('FORBIDDEN');
  });

  it('gestor de outro tenant nao decide sobre proposta alheia -> NOT_FOUND', async () => {
    const c = await cenarioPendente(25);
    const outro = await createTenant();
    const gestorAlheio = await createUser({
      tenantId: outro.id,
      role: 'manager',
      discountLimit: 30,
    });

    const error = await businessErrorOf(
      h.approvals.approve(ctxOf(gestorAlheio), c.proposalId),
    );
    expect(error.code).toBe('NOT_FOUND');
    expect(error.statusCode).toBe(404);
  });

  it('o pedido e a decisao ficam registrados em #aprovacoes com a proposta anexada', async () => {
    const c = await cenarioPendente(25);
    await h.approvals.approve(ctxOf(c.manager), c.proposalId);

    const posts = await channelPosts(db, c.tenantId, 'aprovacoes');
    expect(posts).toHaveLength(2);
    expect(posts.every((post) => post.isSystem)).toBe(true);
    expect(posts.every((post) => post.attachedProposalId === c.proposalId)).toBe(true);
    expect(posts[0]?.content).toContain('Pedido de aprovação de desconto');
    expect(posts[1]?.content).toContain('APROVADO');
  });
});
