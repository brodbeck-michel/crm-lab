/**
 * ProposalService — regras de BUSINESS_RULES.md §1 (calculo), §2 (alcada) e
 * §3 (estagios). Os casos nominais de TESTING.md estao todos aqui.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  LOSS_REASONS,
  PROPOSAL_STATUSES,
  calculateTotal,
  type ProposalStatus,
} from '@crm-lab/shared';
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
  setExamPrice,
  systemMessagesOf,
  type Harness,
} from './support.js';

/** Captura o erro de negocio de uma promise, com asserts legiveis. */
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

describe('ProposalService', () => {
  let db: DbClient;
  let h: Harness;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    h = buildHarness(db, new FakeWsHub());
  });

  // -------------------------------------------------------------------------
  // §1 — calculo do total
  // -------------------------------------------------------------------------
  describe('calculo de total (regra §1)', () => {
    it('deriva total de items + desconto, com precos do catalogo', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
      const conversation = await createConversation({ tenantId: tenant.id });
      const a = await createExam({ tenantId: tenant.id, pricePrivate: 89.9 });
      const b = await createExam({ tenantId: tenant.id, pricePrivate: 100 });

      const created = await h.proposals.create(ctxOf(user), {
        conversationId: conversation.id,
        items: [
          { examId: a.id, quantity: 1 },
          { examId: b.id, quantity: 1 },
        ],
        discountPercent: 10,
      });

      expect(created.subtotal).toBe(189.9);
      expect(created.totalPrice).toBe(170.91);
      expect(created.items.map((item) => item.unitPrice)).toEqual([89.9, 100]);
      expect(created.status).toBe('novo_contato');
    });

    it('preserva a ordem dos itens pedida pelo atendente', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
      const conversation = await createConversation({ tenantId: tenant.id });
      const nomes = ['Zinco', 'Alfa', 'Meio', 'Beta'];
      const exames = [];
      for (const name of nomes) {
        exames.push(await createExam({ tenantId: tenant.id, name, pricePrivate: 10 }));
      }

      const created = await h.proposals.create(ctxOf(user), {
        conversationId: conversation.id,
        items: exames.map((exam) => ({ examId: exam.id, quantity: 1 })),
      });

      expect(created.items.map((item) => item.examName)).toEqual(nomes);
      const relida = await h.proposals.getById(ctxOf(user), created.id);
      expect(relida.items.map((item) => item.examName)).toEqual(nomes);
    });

    // D-071: a ordem vive em `position`, nao no timestamp. Achatar `created_at`
    // simula o que um reprocessamento/importacao faz — antes da coluna, a lista
    // caia no desempate por `id` (UUID aleatorio) e voltava embaralhada.
    it('mantem a ordem dos itens quando todos compartilham o mesmo created_at', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
      const conversation = await createConversation({ tenantId: tenant.id });
      const nomes = ['Zinco', 'Alfa', 'Meio', 'Beta', 'Omega', 'Delta'];
      const exames = [];
      for (const name of nomes) {
        exames.push(await createExam({ tenantId: tenant.id, name, pricePrivate: 10 }));
      }

      const created = await h.proposals.create(ctxOf(user), {
        conversationId: conversation.id,
        items: exames.map((exam) => ({ examId: exam.id, quantity: 1 })),
      });

      // O INSERT gravou o indice do array (base 0), nao tudo em 0.
      const posicoes = await db.withoutTenant((tx) =>
        tx.query<{ position: number; exam_name: string }>(
          `SELECT "position", exam_name FROM proposal_items
            WHERE proposal_id = $1 ORDER BY "position" ASC`,
          [created.id],
        ),
      );
      expect(posicoes.rows.map((r) => r.position)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(posicoes.rows.map((r) => r.exam_name)).toEqual(nomes);

      // Timestamps identicos: o unico criterio que resta e `position`.
      await db.withoutTenant((tx) =>
        tx.query(`UPDATE proposal_items SET created_at = TIMESTAMP '2020-01-01 00:00:00'
                   WHERE proposal_id = $1`, [created.id]),
      );

      const relida = await h.proposals.getById(ctxOf(user), created.id);
      expect(relida.items.map((item) => item.examName)).toEqual(nomes);
    });

    it('multiplica pela quantidade', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
      const conversation = await createConversation({ tenantId: tenant.id });
      const exam = await createExam({ tenantId: tenant.id, pricePrivate: 25.5 });

      const created = await h.proposals.create(ctxOf(user), {
        conversationId: conversation.id,
        items: [{ examId: exam.id, quantity: 3 }],
      });

      expect(created.subtotal).toBe(76.5);
      expect(created.totalPrice).toBe(76.5);
    });

    it('usa o preco do catalogo mesmo quando o exame acabou de mudar de preco', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
      const conversation = await createConversation({ tenantId: tenant.id });
      const exam = await createExam({ tenantId: tenant.id, pricePrivate: 50 });

      // O catalogo tem cache de 1h; `resolveActiveByIds` NAO passa por ele.
      await h.examCatalog.list(tenant.id, {});
      await setExamPrice(db, exam.id, 80);

      const created = await h.proposals.create(ctxOf(user), {
        conversationId: conversation.id,
        items: [{ examId: exam.id, quantity: 1 }],
      });

      expect(created.items[0]?.unitPrice).toBe(80);
      expect(created.totalPrice).toBe(80);
    });

    it('preco do catalogo mudou depois: a proposta antiga preserva o snapshot (D-004)', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
      const conversation = await createConversation({ tenantId: tenant.id });
      const exam = await createExam({ tenantId: tenant.id, pricePrivate: 100, name: 'Antigo' });

      const antiga = await h.proposals.create(ctxOf(user), {
        conversationId: conversation.id,
        items: [{ examId: exam.id, quantity: 2 }],
        discountPercent: 10,
      });
      expect(antiga.totalPrice).toBe(180);

      await setExamPrice(db, exam.id, 250);

      const relida = await h.proposals.getById(ctxOf(user), antiga.id);
      expect(relida.items[0]?.unitPrice).toBe(100);
      expect(relida.items[0]?.examName).toBe('Antigo');
      expect(relida.subtotal).toBe(200);
      expect(relida.totalPrice).toBe(180);

      const nova = await h.proposals.create(ctxOf(user), {
        conversationId: conversation.id,
        items: [{ examId: exam.id, quantity: 2 }],
        discountPercent: 10,
      });
      expect(nova.totalPrice).toBe(450);
    });

    it('recalcula o total ao mudar o desconto (D-003)', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
      const conversation = await createConversation({ tenantId: tenant.id });
      const exam = await createExam({ tenantId: tenant.id, pricePrivate: 200 });

      const created = await h.proposals.create(ctxOf(user), {
        conversationId: conversation.id,
        items: [{ examId: exam.id, quantity: 1 }],
        discountPercent: 0,
      });
      expect(created.totalPrice).toBe(200);

      const updated = await h.proposals.updateDiscount(ctxOf(user), created.id, 15);
      expect(updated.discountPercent).toBe(15);
      expect(updated.totalPrice).toBe(170);

      const detail = await h.proposals.getById(ctxOf(user), created.id);
      expect(detail.totalPrice).toBe(170);
      // O subtotal (snapshot) nao muda com o desconto.
      expect(detail.subtotal).toBe(200);
    });

    it('arredondamento em centavos nao acumula erro (3 itens quebrados)', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
      const conversation = await createConversation({ tenantId: tenant.id });
      const precos = [33.33, 66.67, 10.01];
      const exames = [];
      for (const preco of precos) {
        exames.push(await createExam({ tenantId: tenant.id, pricePrivate: preco }));
      }

      const created = await h.proposals.create(ctxOf(user), {
        conversationId: conversation.id,
        items: exames.map((exam) => ({ examId: exam.id, quantity: 1 })),
        discountPercent: 7,
      });

      expect(created.subtotal).toBe(110.01);
      expect(created.totalPrice).toBe(102.31);
      // Mesma origem que o frontend usa (`@crm-lab/shared`).
      expect(created.totalPrice).toBe(
        calculateTotal(
          precos.map((unitPrice) => ({ unitPrice, quantity: 1 })),
          7,
        ),
      );
    });

    it('exame inativo ou de outro tenant -> EXAM_NOT_FOUND_OR_INACTIVE com examIds', async () => {
      const tenant = await createTenant();
      const outro = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
      const conversation = await createConversation({ tenantId: tenant.id });
      const inativo = await createExam({ tenantId: tenant.id, isActive: false });
      const alheio = await createExam({ tenantId: outro.id });

      const error = await businessErrorOf(
        h.proposals.create(ctxOf(user), {
          conversationId: conversation.id,
          items: [
            { examId: inativo.id, quantity: 1 },
            { examId: alheio.id, quantity: 1 },
          ],
        }),
      );

      expect(error.code).toBe('EXAM_NOT_FOUND_OR_INACTIVE');
      expect(error.statusCode).toBe(400);
      expect(error.details?.examIds).toEqual([inativo.id, alheio.id]);
    });
  });

  // -------------------------------------------------------------------------
  // §2 — alcada
  // -------------------------------------------------------------------------
  describe('alcada de desconto (regra §2)', () => {
    async function cenario(discountLimit = 15): Promise<{
      tenantId: string;
      user: Awaited<ReturnType<typeof createUser>>;
      conversationId: string;
      examId: string;
    }> {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'attendant', discountLimit });
      const conversation = await createConversation({ tenantId: tenant.id });
      const exam = await createExam({ tenantId: tenant.id, pricePrivate: 200 });
      return {
        tenantId: tenant.id,
        user,
        conversationId: conversation.id,
        examId: exam.id,
      };
    }

    it('dentro do limite: aprovada por si mesma', async () => {
      const c = await cenario(15);
      const created = await h.proposals.create(ctxOf(c.user), {
        conversationId: c.conversationId,
        items: [{ examId: c.examId, quantity: 1 }],
        discountPercent: 15,
      });

      expect(created.approvalStatus).toBe('approved');
      expect(created.approvedBy).toBe(c.user.id);
      expect(created.approvedAt).not.toBeNull();
    });

    it('acima do limite: pending + post em #aprovacoes + WS approval.requested', async () => {
      const c = await cenario(15);
      const created = await h.proposals.create(ctxOf(c.user), {
        conversationId: c.conversationId,
        items: [{ examId: c.examId, quantity: 1 }],
        discountPercent: 25,
      });

      expect(created.approvalStatus).toBe('pending');
      expect(created.approvedBy).toBeNull();

      const posts = await channelPosts(db, c.tenantId, 'aprovacoes');
      expect(posts).toHaveLength(1);
      expect(posts[0]?.isSystem).toBe(true);
      expect(posts[0]?.attachedProposalId).toBe(created.id);
      expect(posts[0]?.content).toContain('Pedido de aprovação de desconto');
      expect(posts[0]?.content).toContain('R$ 150,00');
      expect(posts[0]?.content).toContain('25%');
      expect(posts[0]?.content).toContain('15%');

      const eventos = h.wsHub.eventsFor(c.tenantId, 'approval.requested');
      expect(eventos).toHaveLength(1);
      expect(eventos[0]?.data).toEqual({ proposalId: created.id });
    });

    it('impede envio de proposta pending -> PROPOSAL_PENDING_APPROVAL (409)', async () => {
      const c = await cenario(15);
      const created = await h.proposals.create(ctxOf(c.user), {
        conversationId: c.conversationId,
        items: [{ examId: c.examId, quantity: 1 }],
        discountPercent: 40,
      });

      const error = await businessErrorOf(
        h.proposals.updateStatus(ctxOf(c.user), created.id, 'orcamento_enviado'),
      );
      expect(error.code).toBe('PROPOSAL_PENDING_APPROVAL');
      expect(error.statusCode).toBe(409);
    });

    it('subir o desconto acima do limite devolve a proposta para pending', async () => {
      const c = await cenario(15);
      const created = await h.proposals.create(ctxOf(c.user), {
        conversationId: c.conversationId,
        items: [{ examId: c.examId, quantity: 1 }],
        discountPercent: 10,
      });
      expect(created.approvalStatus).toBe('approved');

      const updated = await h.proposals.updateDiscount(ctxOf(c.user), created.id, 30);
      expect(updated.approvalStatus).toBe('pending');
      expect(updated.totalPrice).toBe(140);

      const posts = await channelPosts(db, c.tenantId, 'aprovacoes');
      expect(posts).toHaveLength(1);
    });

    it('baixar o desconto para dentro do limite reaprova', async () => {
      const c = await cenario(15);
      const created = await h.proposals.create(ctxOf(c.user), {
        conversationId: c.conversationId,
        items: [{ examId: c.examId, quantity: 1 }],
        discountPercent: 30,
      });
      expect(created.approvalStatus).toBe('pending');

      const updated = await h.proposals.updateDiscount(ctxOf(c.user), created.id, 12);
      expect(updated.approvalStatus).toBe('approved');
      expect(updated.totalPrice).toBe(176);

      await h.proposals.updateStatus(ctxOf(c.user), created.id, 'orcamento_enviado');
      const detail = await h.proposals.getById(ctxOf(c.user), created.id);
      expect(detail.status).toBe('orcamento_enviado');
    });

    it('mexer no desconto da proposta de terceiro acima da propria alcada -> DISCOUNT_EXCEEDS_LIMIT', async () => {
      const tenant = await createTenant();
      const autor = await createUser({ tenantId: tenant.id, role: 'attendant', discountLimit: 15 });
      const gestor = await createUser({ tenantId: tenant.id, role: 'manager', discountLimit: 30 });
      const conversation = await createConversation({ tenantId: tenant.id });
      const exam = await createExam({ tenantId: tenant.id, pricePrivate: 100 });

      const created = await h.proposals.create(ctxOf(autor), {
        conversationId: conversation.id,
        items: [{ examId: exam.id, quantity: 1 }],
        discountPercent: 10,
      });

      const error = await businessErrorOf(
        h.proposals.updateDiscount(ctxOf(gestor), created.id, 40),
      );
      expect(error.code).toBe('DISCOUNT_EXCEEDS_LIMIT');
      expect(error.statusCode).toBe(403);
      expect(error.details).toMatchObject({
        requestedDiscount: 40,
        userLimit: 30,
        approvalRequired: true,
      });
    });

    it('a alcada vem do banco, nao do token', async () => {
      const c = await cenario(15);
      // Token diz 100%; o banco diz 15% — o servidor acredita no banco.
      const created = await h.proposals.create(ctxOf(c.user, { discountLimit: 100 }), {
        conversationId: c.conversationId,
        items: [{ examId: c.examId, quantity: 1 }],
        discountPercent: 40,
      });
      expect(created.approvalStatus).toBe('pending');
    });

    it('proposta fechada nao aceita novo desconto', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'attendant' });
      const proposal = await createProposal({
        tenantId: tenant.id,
        createdBy: user.id,
        status: 'ganho',
        totalPrice: 100,
      });

      const error = await businessErrorOf(h.proposals.updateDiscount(ctxOf(user), proposal.id, 5));
      expect(error.code).toBe('PROPOSAL_ALREADY_CLOSED');
      expect(error.details).toEqual({ status: 'ganho' });
    });
  });

  // -------------------------------------------------------------------------
  // §3 — transicoes
  // -------------------------------------------------------------------------
  describe('transicoes de estagio (regra §3)', () => {
    const validPairs: Array<[ProposalStatus, ProposalStatus]> = [];
    for (const from of PROPOSAL_STATUSES) {
      for (const to of ALLOWED_TRANSITIONS[from]) {
        validPairs.push([from, to]);
      }
    }

    it.each(validPairs)('aceita %s -> %s', async (from, to) => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'manager' });
      const proposal = await createProposal({
        tenantId: tenant.id,
        createdBy: user.id,
        status: from,
        totalPrice: 100,
      });

      const updated = await h.proposals.updateStatus(
        ctxOf(user),
        proposal.id,
        to,
        to === 'perdido' ? 'preco' : undefined,
      );
      expect(updated.status).toBe(to);
    });

    it('rejeita pular estagio (novo_contato -> ganho) com allowed[] na resposta', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'manager' });
      const proposal = await createProposal({ tenantId: tenant.id, createdBy: user.id });

      const error = await businessErrorOf(
        h.proposals.updateStatus(ctxOf(user), proposal.id, 'ganho'),
      );
      expect(error.code).toBe('INVALID_STATUS_TRANSITION');
      expect(error.statusCode).toBe(400);
      expect(error.details).toEqual({
        from: 'novo_contato',
        to: 'ganho',
        allowed: [...ALLOWED_TRANSITIONS.novo_contato],
      });
    });

    it.each(['ganho', 'perdido'] as const)(
      'rejeita transicao a partir de %s (terminal)',
      async (terminal) => {
        const tenant = await createTenant();
        const user = await createUser({ tenantId: tenant.id, role: 'manager' });
        const proposal = await createProposal({
          tenantId: tenant.id,
          createdBy: user.id,
          status: terminal,
          totalPrice: 10,
        });

        const error = await businessErrorOf(
          h.proposals.updateStatus(ctxOf(user), proposal.id, 'follow_up'),
        );
        expect(error.code).toBe('PROPOSAL_ALREADY_CLOSED');
        expect(error.statusCode).toBe(409);
        expect(error.details).toEqual({ status: terminal });
      },
    );

    it('exige reasonLost ao marcar perdido', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'manager' });
      const proposal = await createProposal({ tenantId: tenant.id, createdBy: user.id });

      const error = await businessErrorOf(
        h.proposals.updateStatus(ctxOf(user), proposal.id, 'perdido'),
      );
      expect(error.code).toBe('LOSS_REASON_REQUIRED');
      expect(error.statusCode).toBe(400);
    });

    it('rejeita reasonLost fora do enum, devolvendo allowed[]', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'manager' });
      const proposal = await createProposal({ tenantId: tenant.id, createdBy: user.id });

      const error = await businessErrorOf(
        h.proposals.updateStatus(ctxOf(user), proposal.id, 'perdido', 'nao_gostou'),
      );
      expect(error.code).toBe('INVALID_LOSS_REASON');
      expect(error.details).toEqual({ allowed: [...LOSS_REASONS] });
    });

    it('closedAt so nos terminais', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'manager' });
      const conversation = await createConversation({ tenantId: tenant.id });
      const exam = await createExam({ tenantId: tenant.id, pricePrivate: 100 });

      const created = await h.proposals.create(ctxOf(user), {
        conversationId: conversation.id,
        items: [{ examId: exam.id, quantity: 1 }],
      });
      expect(created.closedAt).toBeNull();

      const enviada = await h.proposals.updateStatus(
        ctxOf(user),
        created.id,
        'orcamento_enviado',
      );
      expect(enviada.closedAt).toBeNull();

      const ganha = await h.proposals.updateStatus(ctxOf(user), created.id, 'ganho');
      expect(ganha.closedAt).not.toBeNull();
    });

    it('grava proposal_status_history a cada transicao aceita, comecando em novo_contato', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'manager' });
      const conversation = await createConversation({ tenantId: tenant.id });
      const exam = await createExam({ tenantId: tenant.id, pricePrivate: 100 });

      const created = await h.proposals.create(ctxOf(user), {
        conversationId: conversation.id,
        items: [{ examId: exam.id, quantity: 1 }],
      });
      await h.proposals.updateStatus(ctxOf(user), created.id, 'orcamento_enviado');
      await h.proposals.updateStatus(ctxOf(user), created.id, 'negociacao');

      const detail = await h.proposals.getById(ctxOf(user), created.id);
      expect(detail.history.map((entry) => entry.status)).toEqual([
        'novo_contato',
        'orcamento_enviado',
        'negociacao',
      ]);
      expect(detail.history.every((entry) => entry.changedBy === user.id)).toBe(true);
      expect(detail.history[0]?.changedByName).toBe(user.name);
    });

    it('emite proposal.status_changed apenas para o tenant certo', async () => {
      const tenant = await createTenant();
      const outro = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'manager' });
      const proposal = await createProposal({ tenantId: tenant.id, createdBy: user.id });

      await h.proposals.updateStatus(ctxOf(user), proposal.id, 'orcamento_enviado');

      const eventos = h.wsHub.eventsFor(tenant.id, 'proposal.status_changed');
      expect(eventos).toHaveLength(1);
      expect(eventos[0]?.data).toEqual({
        proposalId: proposal.id,
        status: 'orcamento_enviado',
      });
      expect(h.wsHub.eventsFor(outro.id)).toHaveLength(0);
    });

    it('mensagem de sistema na conversa ao enviar orcamento e ao ganhar', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'manager' });
      const conversation = await createConversation({ tenantId: tenant.id });
      const exam = await createExam({ tenantId: tenant.id, pricePrivate: 179.8 });

      const created = await h.proposals.create(ctxOf(user), {
        conversationId: conversation.id,
        items: [{ examId: exam.id, quantity: 1 }],
      });
      await h.proposals.updateStatus(ctxOf(user), created.id, 'orcamento_enviado');
      await h.proposals.updateStatus(ctxOf(user), created.id, 'ganho');

      const mensagens = await systemMessagesOf(db, conversation.id);
      expect(mensagens).toHaveLength(2);
      expect(mensagens[0]).toContain('Orçamento #');
      expect(mensagens[0]).toContain('R$ 179,80');
      expect(mensagens[1]).toContain('ganha');
    });
  });

  // -------------------------------------------------------------------------
  // Auditoria e visibilidade
  // -------------------------------------------------------------------------
  describe('auditoria (regra §9)', () => {
    it('registra criacao e mudanca de estagio', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'manager' });
      const conversation = await createConversation({ tenantId: tenant.id });
      const exam = await createExam({ tenantId: tenant.id, pricePrivate: 100 });

      const created = await h.proposals.create(ctxOf(user), {
        conversationId: conversation.id,
        items: [{ examId: exam.id, quantity: 1 }],
      });
      await h.proposals.updateStatus(ctxOf(user), created.id, 'orcamento_enviado');
      await h.proposals.updateDiscount(ctxOf(user), created.id, 5);

      expect(await auditActionsFor(db, created.id)).toEqual([
        'create_proposal',
        'update_proposal_status',
        'update_proposal_discount',
      ]);
      expect(h.audit.failures).toHaveLength(0);
    });
  });

  describe('visibilidade por papel (D-042)', () => {
    it('atendente nao enxerga proposta de outro atendente do mesmo tenant', async () => {
      const tenant = await createTenant();
      const a = await createUser({ tenantId: tenant.id, role: 'attendant' });
      const b = await createUser({ tenantId: tenant.id, role: 'attendant' });
      const proposal = await createProposal({ tenantId: tenant.id, createdBy: b.id });

      const error = await businessErrorOf(h.proposals.getById(ctxOf(a), proposal.id));
      expect(error.code).toBe('NOT_FOUND');
      expect(error.statusCode).toBe(404);

      const lista = await h.proposals.list(ctxOf(a), {});
      expect(lista.proposals).toHaveLength(0);
    });

    it('gestor enxerga todas as propostas do tenant', async () => {
      const tenant = await createTenant();
      const gestor = await createUser({ tenantId: tenant.id, role: 'manager' });
      const atendente = await createUser({ tenantId: tenant.id, role: 'attendant' });
      await createProposal({ tenantId: tenant.id, createdBy: atendente.id });
      await createProposal({ tenantId: tenant.id, createdBy: gestor.id });

      const lista = await h.proposals.list(ctxOf(gestor), {});
      expect(lista.proposals).toHaveLength(2);
      expect(lista.pagination).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
    });
  });

  describe('busca por nome do paciente (?search=)', () => {
    it('filtra por trecho do nome, ignorando maiusculas', async () => {
      const tenant = await createTenant();
      const gestor = await createUser({ tenantId: tenant.id, role: 'manager' });
      const maria = await createConversation({ tenantId: tenant.id, patientName: 'Maria Souza' });
      const joao = await createConversation({ tenantId: tenant.id, patientName: 'Joao Lima' });
      await createProposal({ tenantId: tenant.id, conversationId: maria.id, createdBy: gestor.id });
      await createProposal({ tenantId: tenant.id, conversationId: joao.id, createdBy: gestor.id });

      const lista = await h.proposals.list(ctxOf(gestor), { search: 'sOuZ' });

      expect(lista.proposals.map((p) => p.patientName)).toEqual(['Maria Souza']);
      expect(lista.pagination.total).toBe(1);
    });

    it('nao escapa do recorte por papel: atendente segue vendo so as proprias', async () => {
      const tenant = await createTenant();
      const a = await createUser({ tenantId: tenant.id, role: 'attendant' });
      const b = await createUser({ tenantId: tenant.id, role: 'attendant' });
      const conv = await createConversation({ tenantId: tenant.id, patientName: 'Maria Souza' });
      await createProposal({ tenantId: tenant.id, conversationId: conv.id, createdBy: b.id });

      const lista = await h.proposals.list(ctxOf(a), { search: 'Maria' });

      expect(lista.proposals).toHaveLength(0);
    });
  });
});
