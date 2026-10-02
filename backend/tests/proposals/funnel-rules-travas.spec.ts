/**
 * Travas das Regras do funil em `ProposalService` (CRMLAB-56, D-192/D-193).
 *
 * Com os padroes o comportamento antigo e provado por `proposal-service.spec.ts`
 * (que continua verde sem mudar). Aqui: o que muda quando o laboratorio edita
 * as regras, e a excecao de sistema (conciliacao LIS) que nao passa por elas.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SEQUENTIAL_TRANSITIONS,
  type UpdateFunnelRulesRequest,
} from '@crm-lab/shared';
import type { DbClient, DbTx } from '../../src/db/types.js';
import { isBusinessError } from '../../src/http/errors.js';
import { createAuditService } from '../../src/services/audit.service.js';
import { createFunnelRulesService } from '../../src/services/funnel-rules.service.js';
import { applySystemTransition } from '../../src/services/proposal.service.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import {
  createConversation,
  createExam,
  createProposal,
  createTenant,
  createUser,
  type TenantRecord,
  type UserRecord,
} from '../helpers/factories.js';
import { FakeWsHub } from '../helpers/fake-ws.js';
import { buildHarness, ctxOf, type Harness } from './support.js';

async function errorOf(promise: Promise<unknown>): Promise<{
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

describe('Regras do funil no ProposalService', () => {
  let db: DbClient;
  let h: Harness;
  let tenant: TenantRecord;
  let admin: UserRecord;
  let manager: UserRecord;
  let attendant: UserRecord;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    h = buildHarness(db, new FakeWsHub());
    tenant = await createTenant();
    admin = await createUser({ tenantId: tenant.id, role: 'admin' });
    manager = await createUser({ tenantId: tenant.id, role: 'manager' });
    attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });
  });

  /** O que a conciliacao faz quando acha pagamento no LIS (D-252 item 1). */
  function wonFromLisPayment(tx: DbTx, proposalId: string) {
    return applySystemTransition(tx, tenant.id, proposalId, {
      to: 'ganho',
      source: 'lis_payment',
      systemMessage: null,
      lisReconciled: true,
    });
  }

  async function setRules(patch: UpdateFunnelRulesRequest): Promise<void> {
    const service = createFunnelRulesService({ db, audit: createAuditService(db) });
    await service.update(ctxOf(admin), patch);
  }

  describe('origem: Criar proposta manualmente no CRM (D-193)', () => {
    it('desligada -> POST /proposals recusa com MANUAL_PROPOSAL_DISABLED (409)', async () => {
      await setRules({ origin: { manualInCrm: false } });
      const conversation = await createConversation({ tenantId: tenant.id });
      const exam = await createExam({ tenantId: tenant.id, pricePrivate: 50 });

      const error = await errorOf(
        h.proposals.create(ctxOf(attendant), {
          conversationId: conversation.id,
          items: [{ examId: exam.id, quantity: 1 }],
        }),
      );
      expect(error).toMatchObject({ code: 'MANUAL_PROPOSAL_DISABLED', statusCode: 409 });

      const count = await db.withoutTenant((tx) =>
        tx.query<{ total: number }>('SELECT COUNT(*)::int AS total FROM proposals'),
      );
      expect(count.rows[0]?.total).toBe(0);
    });

    it('recusa antes de validar o corpo (itens vazios nao viram VALIDATION_ERROR)', async () => {
      await setRules({ origin: { manualInCrm: false } });
      const error = await errorOf(
        h.proposals.create(ctxOf(attendant), { conversationId: 'x', items: [] }),
      );
      expect(error.code).toBe('MANUAL_PROPOSAL_DISABLED');
    });

    it('a regra de um laboratorio nao desliga o outro', async () => {
      await setRules({ origin: { manualInCrm: false } });
      const other = await createTenant();
      const otherUser = await createUser({ tenantId: other.id, role: 'attendant' });
      const conversation = await createConversation({ tenantId: other.id });
      const exam = await createExam({ tenantId: other.id, pricePrivate: 50 });

      const created = await h.proposals.create(ctxOf(otherUser), {
        conversationId: conversation.id,
        items: [{ examId: exam.id, quantity: 1 }],
      });
      expect(created.status).toBe('novo_contato');
    });
  });

  describe('reabrir Ganho/Perdido', () => {
    it('ligada para gestor: ganho volta para follow_up limpando closedAt', async () => {
      await setRules({ manualMoves: { reopenClosed: { enabled: true } } });
      const proposal = await createProposal({
        tenantId: tenant.id,
        createdBy: manager.id,
        status: 'ganho',
        totalPrice: 10,
      });
      await db.withoutTenant((tx) =>
        tx.query('UPDATE proposals SET closed_at = NOW() WHERE id = $1', [proposal.id]),
      );

      const reopened = await h.proposals.updateStatus(ctxOf(manager), proposal.id, 'follow_up');
      expect(reopened.status).toBe('follow_up');
      expect(reopened.closedAt).toBeNull();
    });

    it('perdido reaberto perde o motivo', async () => {
      await setRules({ manualMoves: { reopenClosed: { enabled: true } } });
      const proposal = await createProposal({
        tenantId: tenant.id,
        createdBy: manager.id,
        status: 'perdido',
        reasonLost: 'preco',
        totalPrice: 10,
      });
      const reopened = await h.proposals.updateStatus(ctxOf(manager), proposal.id, 'negociacao');
      expect(reopened.reasonLost).toBeNull();
    });

    it('so para REOPEN_TARGETS: ganho -> novo_contato e ganho -> perdido sao recusados', async () => {
      await setRules({ manualMoves: { reopenClosed: { enabled: true } } });
      const proposal = await createProposal({
        tenantId: tenant.id,
        createdBy: manager.id,
        status: 'ganho',
        totalPrice: 10,
      });
      for (const to of ['novo_contato', 'perdido'] as const) {
        const error = await errorOf(
          h.proposals.updateStatus(ctxOf(manager), proposal.id, to, 'preco'),
        );
        expect(error.code).toBe('INVALID_STATUS_TRANSITION');
        expect(error.details?.allowed).toEqual(['orcamento_enviado', 'follow_up', 'negociacao']);
      }
    });

    it('perfil fora da lista -> FORBIDDEN reopen_not_allowed; admin sempre pode', async () => {
      await setRules({ manualMoves: { reopenClosed: { enabled: true, roles: ['manager'] } } });
      const own = await createProposal({
        tenantId: tenant.id,
        createdBy: attendant.id,
        status: 'perdido',
        reasonLost: 'preco',
        totalPrice: 10,
      });
      const error = await errorOf(
        h.proposals.updateStatus(ctxOf(attendant), own.id, 'follow_up'),
      );
      expect(error).toMatchObject({
        code: 'FORBIDDEN',
        statusCode: 403,
        details: { reason: 'reopen_not_allowed' },
      });

      await setRules({ manualMoves: { reopenClosed: { roles: [] } } });
      const byAdmin = await h.proposals.updateStatus(ctxOf(admin), own.id, 'follow_up');
      expect(byAdmin.status).toBe('follow_up');
    });

    it('atendente liberada reabre a propria', async () => {
      await setRules({ manualMoves: { reopenClosed: { enabled: true, roles: ['attendant'] } } });
      const own = await createProposal({
        tenantId: tenant.id,
        createdBy: attendant.id,
        status: 'ganho',
        totalPrice: 10,
      });
      const reopened = await h.proposals.updateStatus(ctxOf(attendant), own.id, 'negociacao');
      expect(reopened.status).toBe('negociacao');
    });

    it('ganho conciliado pelo LIS nunca reabre', async () => {
      await setRules({ manualMoves: { reopenClosed: { enabled: true } } });
      const proposal = await createProposal({
        tenantId: tenant.id,
        createdBy: manager.id,
        status: 'orcamento_enviado',
        totalPrice: 10,
      });
      await db.withTenant(tenant.id, (tx) => wonFromLisPayment(tx, proposal.id));

      const error = await errorOf(
        h.proposals.updateStatus(ctxOf(admin), proposal.id, 'follow_up'),
      );
      expect(error).toMatchObject({
        code: 'PROPOSAL_ALREADY_CLOSED',
        details: { status: 'ganho', reason: 'lis_reconciled' },
      });
    });
  });

  describe('pular etapas desligado', () => {
    it('orcamento_enviado -> ganho recusado com allowed da matriz sequencial', async () => {
      await setRules({ manualMoves: { skipStages: false } });
      const proposal = await createProposal({
        tenantId: tenant.id,
        createdBy: manager.id,
        status: 'orcamento_enviado',
        totalPrice: 10,
      });
      const error = await errorOf(h.proposals.updateStatus(ctxOf(manager), proposal.id, 'ganho'));
      expect(error.code).toBe('INVALID_STATUS_TRANSITION');
      expect(error.details).toEqual({
        from: 'orcamento_enviado',
        to: 'ganho',
        allowed: [...SEQUENTIAL_TRANSITIONS.orcamento_enviado],
      });
    });

    it('o passo seguinte continua valendo', async () => {
      await setRules({ manualMoves: { skipStages: false } });
      const proposal = await createProposal({
        tenantId: tenant.id,
        createdBy: manager.id,
        status: 'negociacao',
        totalPrice: 10,
      });
      const won = await h.proposals.updateStatus(ctxOf(manager), proposal.id, 'ganho');
      expect(won.status).toBe('ganho');
    });

    it('conciliacao LIS ignora a trava: novo_contato vai direto a ganho (D-252)', async () => {
      await setRules({ manualMoves: { skipStages: false } });
      const proposal = await createProposal({ tenantId: tenant.id, createdBy: manager.id });
      const won = await db.withTenant(tenant.id, (tx) => wonFromLisPayment(tx, proposal.id));
      expect(won).toMatchObject({ from: 'novo_contato', to: 'ganho', source: 'lis_payment' });
    });
  });

  describe('motivo no Perdido', () => {
    it('nao exigido: perdido sem motivo e aceito, reasonLost fica null', async () => {
      await setRules({ manualMoves: { requireLossReason: false } });
      const proposal = await createProposal({ tenantId: tenant.id, createdBy: manager.id });
      const lost = await h.proposals.updateStatus(ctxOf(manager), proposal.id, 'perdido');
      expect(lost.status).toBe('perdido');
      expect(lost.reasonLost).toBeNull();
      expect(lost.closedAt).not.toBeNull();
    });

    it('nao exigido, mas motivo enviado continua tendo que ser do enum', async () => {
      await setRules({ manualMoves: { requireLossReason: false } });
      const proposal = await createProposal({ tenantId: tenant.id, createdBy: manager.id });
      const error = await errorOf(
        h.proposals.updateStatus(ctxOf(manager), proposal.id, 'perdido', 'nao_gostou'),
      );
      expect(error.code).toBe('INVALID_LOSS_REASON');
    });
  });

  describe('mover card de outra atendente', () => {
    it('desligado: gestor nao move card alheio (FORBIDDEN), move o proprio', async () => {
      await setRules({ manualMoves: { moveOthersCards: false } });
      const others = await createProposal({ tenantId: tenant.id, createdBy: attendant.id });
      const error = await errorOf(
        h.proposals.updateStatus(ctxOf(manager), others.id, 'orcamento_enviado'),
      );
      expect(error).toMatchObject({
        code: 'FORBIDDEN',
        details: { reason: 'move_others_not_allowed' },
      });

      const mine = await createProposal({ tenantId: tenant.id, createdBy: manager.id });
      const moved = await h.proposals.updateStatus(ctxOf(manager), mine.id, 'orcamento_enviado');
      expect(moved.status).toBe('orcamento_enviado');
    });

    it('desligado: admin continua movendo qualquer card', async () => {
      await setRules({ manualMoves: { moveOthersCards: false } });
      const others = await createProposal({ tenantId: tenant.id, createdBy: attendant.id });
      const moved = await h.proposals.updateStatus(ctxOf(admin), others.id, 'orcamento_enviado');
      expect(moved.status).toBe('orcamento_enviado');
    });

    it('ligado (padrao): gestor move card da atendente', async () => {
      const others = await createProposal({ tenantId: tenant.id, createdBy: attendant.id });
      const moved = await h.proposals.updateStatus(ctxOf(manager), others.id, 'orcamento_enviado');
      expect(moved.status).toBe('orcamento_enviado');
    });
  });
});
