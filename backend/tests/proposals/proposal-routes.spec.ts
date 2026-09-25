/**
 * Endpoints de proposta — API_CONTRACTS.md §3 + envelope de API_ERRORS.md.
 *
 * O bloco "isolamento multitenant" e BLOQUEANTE de release (TESTING.md).
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ALLOWED_TRANSITIONS, type ApiErrorBody, type ListProposalsResponse, type ProposalDetail } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { proposalModule } from '../../src/controllers/proposal.routes.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import {
  createConversation,
  createExam,
  createProposal,
  createTenant,
  createUser,
} from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

/** Chaves EXATAS de `ProposalDetail` em `@crm-lab/shared` — o contrato do fio. */
const DETAIL_KEYS = [
  'id',
  'proposalNumber',
  'conversationId',
  'patientName',
  'patientPhone',
  'status',
  'discountPercent',
  'totalPrice',
  'subtotal',
  'items',
  'createdBy',
  'createdByName',
  'approvalStatus',
  'approvedBy',
  'approvedByName',
  'approvedAt',
  'rejectionReason',
  'reasonLost',
  'sentAt',
  'history',
  'createdAt',
  'updatedAt',
  'closedAt',
  'insuranceId',
  'requestingDoctor',
  // CRMLAB-52 (D-119)
  'lisBudgetNumber',
  'lisReconciledAt',
  'lisRequisitionNumber',
  'lisPaidValue',
  'lisPaidOn',
].sort();

describe('/api/v1/proposals', () => {
  let db: DbClient;
  let app: TestApp;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    app = await createTestApp({ db, modules: [proposalModule] });
  });

  async function cenario(): Promise<{
    tenantId: string;
    attendant: Awaited<ReturnType<typeof createUser>>;
    manager: Awaited<ReturnType<typeof createUser>>;
    conversationId: string;
    examId: string;
  }> {
    const tenant = await createTenant();
    const attendant = await createUser({
      tenantId: tenant.id,
      role: 'attendant',
      discountLimit: 15,
    });
    const manager = await createUser({ tenantId: tenant.id, role: 'manager', discountLimit: 30 });
    const conversation = await createConversation({
      tenantId: tenant.id,
      patientName: 'João Santos',
    });
    const exam = await createExam({ tenantId: tenant.id, pricePrivate: 89.9 });
    return {
      tenantId: tenant.id,
      attendant,
      manager,
      conversationId: conversation.id,
      examId: exam.id,
    };
  }

  // -------------------------------------------------------------------------
  // POST /proposals
  // -------------------------------------------------------------------------

  /**
   * Cria um paciente e o liga a conversa (D-059/D-060). Feito com SQL direto
   * de proposito: a fabrica de pacientes e do Agent-API-Patients, e este teste
   * so precisa do vinculo `conversations.patient_id` que o filtro resolve.
   */
  async function vincularPaciente(
    tenantId: string,
    conversationId: string,
    phone: string,
  ): Promise<string> {
    const patientId = randomUUID();
    await db.withoutTenant(async (tx) => {
      await tx.query(
        'INSERT INTO patients (id, tenant_id, name, phone) VALUES ($1, $2, $3, $4)',
        [patientId, tenantId, `Paciente ${phone}`, phone],
      );
      await tx.query('UPDATE conversations SET patient_id = $1 WHERE id = $2', [
        patientId,
        conversationId,
      ]);
    });
    return patientId;
  }

  describe('POST /proposals', () => {
    it('cria proposta e devolve o shape de API_CONTRACTS.md', async () => {
      const c = await cenario();

      const response = await app.agent
        .post('/api/v1/proposals')
        .set(app.auth(c.attendant))
        .send({
          conversationId: c.conversationId,
          items: [{ examId: c.examId, quantity: 2 }],
          discountPercent: 10,
        })
        .expect(201);

      const body = response.body as ProposalDetail;
      expect(Object.keys(body).sort()).toEqual(DETAIL_KEYS);
      expect(body.status).toBe('novo_contato');
      expect(body.patientName).toBe('João Santos');
      expect(body.subtotal).toBe(179.8);
      expect(body.totalPrice).toBe(161.82);
      expect(body.approvalStatus).toBe('approved');
      expect(body.history).toHaveLength(1);
      // Dinheiro no fio e numero decimal, nunca string formatada (regra 9).
      expect(typeof body.totalPrice).toBe('number');
      // CRMLAB-9: sem o campo no request, o medico solicitante fica null.
      expect(body.requestingDoctor).toBeNull();
    });

    // CRMLAB-9: texto livre, opcional, sem cadastro/autocomplete de medicos.
    it('grava e devolve o medico solicitante quando informado', async () => {
      const c = await cenario();

      const response = await app.agent
        .post('/api/v1/proposals')
        .set(app.auth(c.attendant))
        .send({
          conversationId: c.conversationId,
          items: [{ examId: c.examId, quantity: 1 }],
          requestingDoctor: '  Dra. Ana Souza  ',
        })
        .expect(201);

      const body = response.body as ProposalDetail;
      // Aparado pelo backend (zod `.trim()`), nunca gravado com espacos nas pontas.
      expect(body.requestingDoctor).toBe('Dra. Ana Souza');

      const reloaded = await app.agent
        .get(`/api/v1/proposals/${body.id}`)
        .set(app.auth(c.attendant))
        .expect(200);
      expect((reloaded.body as ProposalDetail).requestingDoctor).toBe('Dra. Ana Souza');
    });

    it('medico solicitante em branco vira null (nao grava string vazia)', async () => {
      const c = await cenario();

      const response = await app.agent
        .post('/api/v1/proposals')
        .set(app.auth(c.attendant))
        .send({
          conversationId: c.conversationId,
          items: [{ examId: c.examId, quantity: 1 }],
          requestingDoctor: '   ',
        })
        .expect(201);

      expect((response.body as ProposalDetail).requestingDoctor).toBeNull();
    });

    it('recusa preco/total vindos do cliente (o DTO nem aceita o campo)', async () => {
      const c = await cenario();

      const response = await app.agent
        .post('/api/v1/proposals')
        .set(app.auth(c.attendant))
        .send({
          conversationId: c.conversationId,
          items: [{ examId: c.examId, quantity: 1, unitPrice: 1 }],
          discountPercent: 0,
          totalPrice: 0.01,
        })
        .expect(400);

      const body = response.body as ApiErrorBody;
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('quantidade <= 0 -> VALIDATION_ERROR', async () => {
      const c = await cenario();
      await app.agent
        .post('/api/v1/proposals')
        .set(app.auth(c.attendant))
        .send({ conversationId: c.conversationId, items: [{ examId: c.examId, quantity: 0 }] })
        .expect(400);
    });

    it('sem token -> 401', async () => {
      const c = await cenario();
      await app.agent
        .post('/api/v1/proposals')
        .send({ conversationId: c.conversationId, items: [{ examId: c.examId, quantity: 1 }] })
        .expect(401);
    });

    it('desconto acima da alcada NAO e erro: a proposta nasce pending', async () => {
      const c = await cenario();
      const response = await app.agent
        .post('/api/v1/proposals')
        .set(app.auth(c.attendant))
        .send({
          conversationId: c.conversationId,
          items: [{ examId: c.examId, quantity: 1 }],
          discountPercent: 25,
        })
        .expect(201);

      const body = response.body as ProposalDetail;
      expect(body.approvalStatus).toBe('pending');
      // C7 (Onda 7): sem `message` pt-BR no corpo — `approvalStatus` ja diz o
      // que houve.
      expect('message' in body).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // GET /proposals
  // -------------------------------------------------------------------------
  describe('GET /proposals', () => {
    it('devolve envelope nomeado com paginacao (D-009)', async () => {
      const c = await cenario();
      await createProposal({ tenantId: c.tenantId, createdBy: c.attendant.id });

      const response = await app.agent
        .get('/api/v1/proposals')
        .set(app.auth(c.manager))
        .expect(200);

      const body = response.body as ListProposalsResponse;
      expect(Object.keys(body).sort()).toEqual(['pagination', 'proposals']);
      expect(body.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
      expect(body.proposals[0]?.createdByName).toBe(c.attendant.name);
    });

    it('filtra por multiplos status (?status=a,b)', async () => {
      const c = await cenario();
      await createProposal({
        tenantId: c.tenantId,
        createdBy: c.attendant.id,
        status: 'novo_contato',
      });
      await createProposal({
        tenantId: c.tenantId,
        createdBy: c.attendant.id,
        status: 'negociacao',
      });
      await createProposal({ tenantId: c.tenantId, createdBy: c.attendant.id, status: 'ganho' });

      const response = await app.agent
        .get('/api/v1/proposals?status=novo_contato,negociacao')
        .set(app.auth(c.manager))
        .expect(200);

      const body = response.body as ListProposalsResponse;
      expect(body.proposals).toHaveLength(2);
      expect(body.proposals.map((p) => p.status).sort()).toEqual(['negociacao', 'novo_contato']);
    });

    it('filtra por createdBy e por conversa', async () => {
      const c = await cenario();
      const outra = await createConversation({ tenantId: c.tenantId });
      await createProposal({
        tenantId: c.tenantId,
        createdBy: c.attendant.id,
        conversationId: c.conversationId,
      });
      await createProposal({
        tenantId: c.tenantId,
        createdBy: c.manager.id,
        conversationId: outra.id,
      });

      const porAutor = await app.agent
        .get(`/api/v1/proposals?createdBy=${c.manager.id}`)
        .set(app.auth(c.manager))
        .expect(200);
      expect((porAutor.body as ListProposalsResponse).proposals).toHaveLength(1);

      const porConversa = await app.agent
        .get(`/api/v1/proposals?conversationId=${c.conversationId}`)
        .set(app.auth(c.manager))
        .expect(200);
      expect((porConversa.body as ListProposalsResponse).proposals).toHaveLength(1);
    });

    // ?patientId= — D-060: a ficha do paciente lista as propostas por aqui.
    it('filtra por patientId (conversations.patient_id, D-060)', async () => {
      const c = await cenario();
      const outraConversa = await createConversation({ tenantId: c.tenantId });
      const paciente = await vincularPaciente(c.tenantId, c.conversationId, '+5548999990001');
      await vincularPaciente(c.tenantId, outraConversa.id, '+5548999990002');

      await createProposal({
        tenantId: c.tenantId,
        createdBy: c.attendant.id,
        conversationId: c.conversationId,
      });
      await createProposal({
        tenantId: c.tenantId,
        createdBy: c.attendant.id,
        conversationId: outraConversa.id,
      });

      const response = await app.agent
        .get(`/api/v1/proposals?patientId=${paciente}`)
        .set(app.auth(c.manager))
        .expect(200);
      const body = response.body as ListProposalsResponse;
      expect(body.proposals).toHaveLength(1);
      expect(body.proposals[0]?.conversationId).toBe(c.conversationId);
      expect(body.pagination.total).toBe(1);
    });

    it('patientId respeita o recorte por papel: atendente so ve as proprias (D-042)', async () => {
      const c = await cenario();
      const paciente = await vincularPaciente(c.tenantId, c.conversationId, '+5548999990003');
      await createProposal({
        tenantId: c.tenantId,
        createdBy: c.manager.id,
        conversationId: c.conversationId,
      });

      // O gestor ve a proposta do paciente...
      const doGestor = await app.agent
        .get(`/api/v1/proposals?patientId=${paciente}`)
        .set(app.auth(c.manager))
        .expect(200);
      expect((doGestor.body as ListProposalsResponse).proposals).toHaveLength(1);

      // ...e o atendente, que nao a criou, ve lista vazia na MESMA ficha.
      const doAtendente = await app.agent
        .get(`/api/v1/proposals?patientId=${paciente}`)
        .set(app.auth(c.attendant))
        .expect(200);
      expect((doAtendente.body as ListProposalsResponse).proposals).toHaveLength(0);
    });

    it('patientId de outro tenant -> lista VAZIA, nao 404 (filtro nao e oraculo)', async () => {
      const c = await cenario();
      await createProposal({
        tenantId: c.tenantId,
        createdBy: c.attendant.id,
        conversationId: c.conversationId,
      });

      const outro = await createTenant();
      const conversaAlheia = await createConversation({ tenantId: outro.id });
      const pacienteAlheio = await vincularPaciente(
        outro.id,
        conversaAlheia.id,
        '+5548999990004',
      );

      const response = await app.agent
        .get(`/api/v1/proposals?patientId=${pacienteAlheio}`)
        .set(app.auth(c.manager))
        .expect(200);
      expect((response.body as ListProposalsResponse).proposals).toHaveLength(0);

      // Paciente que nao existe em lugar nenhum: mesma resposta.
      const inexistente = await app.agent
        .get(`/api/v1/proposals?patientId=${randomUUID()}`)
        .set(app.auth(c.manager))
        .expect(200);
      expect((inexistente.body as ListProposalsResponse).proposals).toHaveLength(0);
    });

    it('patientId nao-uuid -> VALIDATION_ERROR', async () => {
      const c = await cenario();
      const response = await app.agent
        .get('/api/v1/proposals?patientId=nao-e-uuid')
        .set(app.auth(c.manager))
        .expect(400);
      expect((response.body as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
    });

    it('status invalido na query -> VALIDATION_ERROR', async () => {
      const c = await cenario();
      const response = await app.agent
        .get('/api/v1/proposals?status=inventado')
        .set(app.auth(c.manager))
        .expect(400);
      expect((response.body as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
    });

    it('atendente ve apenas as proprias', async () => {
      const c = await cenario();
      await createProposal({ tenantId: c.tenantId, createdBy: c.attendant.id });
      await createProposal({ tenantId: c.tenantId, createdBy: c.manager.id });

      const response = await app.agent
        .get('/api/v1/proposals')
        .set(app.auth(c.attendant))
        .expect(200);
      const body = response.body as ListProposalsResponse;
      expect(body.proposals).toHaveLength(1);
      expect(body.proposals[0]?.createdBy).toBe(c.attendant.id);
    });
  });

  // -------------------------------------------------------------------------
  // PATCH
  // -------------------------------------------------------------------------
  describe('PATCH /proposals/:id/status', () => {
    it('devolve a resposta parcial do contrato', async () => {
      const c = await cenario();
      const proposal = await createProposal({
        tenantId: c.tenantId,
        createdBy: c.attendant.id,
      });

      const response = await app.agent
        .patch(`/api/v1/proposals/${proposal.id}/status`)
        .set(app.auth(c.attendant))
        .send({ status: 'orcamento_enviado' })
        .expect(200);

      expect(Object.keys(response.body as object).sort()).toEqual([
        'id',
        'reasonLost',
        'status',
        'updatedAt',
      ]);
    });

    it('transicao invalida devolve o envelope de API_ERRORS.md com allowed[]', async () => {
      const c = await cenario();
      const proposal = await createProposal({
        tenantId: c.tenantId,
        createdBy: c.attendant.id,
      });

      const response = await app.agent
        .patch(`/api/v1/proposals/${proposal.id}/status`)
        .set(app.auth(c.attendant))
        .send({ status: 'ganho' })
        .expect(400);

      const body = response.body as ApiErrorBody;
      expect(body.error.code).toBe('INVALID_STATUS_TRANSITION');
      expect(body.error.statusCode).toBe(400);
      expect(body.error.details).toEqual({
        from: 'novo_contato',
        to: 'ganho',
        allowed: [...ALLOWED_TRANSITIONS.novo_contato],
      });
    });

    it('perdido sem motivo -> LOSS_REASON_REQUIRED (400)', async () => {
      const c = await cenario();
      const proposal = await createProposal({
        tenantId: c.tenantId,
        createdBy: c.attendant.id,
      });

      const response = await app.agent
        .patch(`/api/v1/proposals/${proposal.id}/status`)
        .set(app.auth(c.attendant))
        .send({ status: 'perdido' })
        .expect(400);
      expect((response.body as ApiErrorBody).error.code).toBe('LOSS_REASON_REQUIRED');
    });

    it('perdido com motivo valido fecha a proposta', async () => {
      const c = await cenario();
      const proposal = await createProposal({
        tenantId: c.tenantId,
        createdBy: c.attendant.id,
      });

      const response = await app.agent
        .patch(`/api/v1/proposals/${proposal.id}/status`)
        .set(app.auth(c.attendant))
        .send({ status: 'perdido', reasonLost: 'preco' })
        .expect(200);

      expect((response.body as { reasonLost: string }).reasonLost).toBe('preco');

      const detail = await app.agent
        .get(`/api/v1/proposals/${proposal.id}`)
        .set(app.auth(c.attendant))
        .expect(200);
      expect((detail.body as ProposalDetail).closedAt).not.toBeNull();
    });
  });

  describe('PATCH /proposals/:id/discount', () => {
    it('devolve id, desconto e total recalculado', async () => {
      const c = await cenario();
      const created = await app.agent
        .post('/api/v1/proposals')
        .set(app.auth(c.attendant))
        .send({ conversationId: c.conversationId, items: [{ examId: c.examId, quantity: 2 }] })
        .expect(201);
      const id = (created.body as ProposalDetail).id;

      const response = await app.agent
        .patch(`/api/v1/proposals/${id}/discount`)
        .set(app.auth(c.attendant))
        .send({ discountPercent: 10 })
        .expect(200);

      expect(response.body).toEqual({ id, discountPercent: 10, totalPrice: 161.82 });
    });

    it('desconto fora de 0..100 -> VALIDATION_ERROR', async () => {
      const c = await cenario();
      const proposal = await createProposal({
        tenantId: c.tenantId,
        createdBy: c.attendant.id,
      });
      await app.agent
        .patch(`/api/v1/proposals/${proposal.id}/discount`)
        .set(app.auth(c.attendant))
        .send({ discountPercent: 120 })
        .expect(400);
    });
  });

  describe('PATCH /proposals/:id/items', () => {
    it('substitui itens, recalcula total e devolve o ProposalDetail inteiro', async () => {
      const c = await cenario();
      const created = await app.agent
        .post('/api/v1/proposals')
        .set(app.auth(c.attendant))
        .send({ conversationId: c.conversationId, items: [{ examId: c.examId, quantity: 1 }] })
        .expect(201);
      const id = (created.body as ProposalDetail).id;

      const exam2 = await createExam({ tenantId: c.tenantId, pricePrivate: 50 });
      const response = await app.agent
        .patch(`/api/v1/proposals/${id}/items`)
        .set(app.auth(c.attendant))
        .send({ items: [{ examId: exam2.id, quantity: 2 }] })
        .expect(200);

      const body = response.body as ProposalDetail;
      expect(Object.keys(body).sort()).toEqual(DETAIL_KEYS);
      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.examId).toBe(exam2.id);
      expect(body.totalPrice).toBe(100);
    });

    it('atualiza medico solicitante junto com os itens', async () => {
      const c = await cenario();
      const created = await app.agent
        .post('/api/v1/proposals')
        .set(app.auth(c.attendant))
        .send({ conversationId: c.conversationId, items: [{ examId: c.examId, quantity: 1 }] })
        .expect(201);
      const id = (created.body as ProposalDetail).id;

      const response = await app.agent
        .patch(`/api/v1/proposals/${id}/items`)
        .set(app.auth(c.attendant))
        .send({ items: [{ examId: c.examId, quantity: 1 }], requestingDoctor: 'Dr. João' })
        .expect(200);

      expect((response.body as ProposalDetail).requestingDoctor).toBe('Dr. João');
    });

    it('desconto acima da alcada do proprio autor volta a proposta para pending', async () => {
      const c = await cenario();
      const created = await app.agent
        .post('/api/v1/proposals')
        .set(app.auth(c.attendant))
        .send({ conversationId: c.conversationId, items: [{ examId: c.examId, quantity: 1 }] })
        .expect(201);
      const id = (created.body as ProposalDetail).id;

      const response = await app.agent
        .patch(`/api/v1/proposals/${id}/items`)
        .set(app.auth(c.attendant))
        .send({ items: [{ examId: c.examId, quantity: 1 }], discountPercent: 25 })
        .expect(200);

      expect((response.body as ProposalDetail).approvalStatus).toBe('pending');
    });

    it('gestor mexendo no desconto de proposta de terceiro acima da propria alcada -> DISCOUNT_EXCEEDS_LIMIT', async () => {
      const c = await cenario();
      // Gestor ve TODAS as propostas (D-042), inclusive as do atendente — o
      // bloqueio de terceiro so faz sentido nesse sentido (manager > 404
      // nunca acontece aqui; o inverso, atendente vendo proposta do gestor,
      // e que daria 404 por visibilidade, nao 403).
      const proposal = await createProposal({
        tenantId: c.tenantId,
        createdBy: c.attendant.id,
        items: [{ examId: c.examId, examName: 'Exame', unitPrice: 89.9, quantity: 1 }],
      });

      const response = await app.agent
        .patch(`/api/v1/proposals/${proposal.id}/items`)
        .set(app.auth(c.manager))
        .send({ items: [{ examId: c.examId, quantity: 1 }], discountPercent: 50 })
        .expect(403);

      const body = response.body as ApiErrorBody;
      expect(body.error.code).toBe('DISCOUNT_EXCEEDS_LIMIT');
    });

    it('proposta em negociacao -> PROPOSAL_EDIT_NOT_ALLOWED', async () => {
      const c = await cenario();
      const proposal = await createProposal({
        tenantId: c.tenantId,
        createdBy: c.attendant.id,
        status: 'negociacao',
        items: [{ examId: c.examId, examName: 'Exame', unitPrice: 89.9, quantity: 1 }],
      });

      const response = await app.agent
        .patch(`/api/v1/proposals/${proposal.id}/items`)
        .set(app.auth(c.attendant))
        .send({ items: [{ examId: c.examId, quantity: 2 }] })
        .expect(409);

      const body = response.body as ApiErrorBody;
      expect(body.error.code).toBe('PROPOSAL_EDIT_NOT_ALLOWED');
    });

    it('proposta ganha (terminal) -> PROPOSAL_ALREADY_CLOSED', async () => {
      const c = await cenario();
      const proposal = await createProposal({
        tenantId: c.tenantId,
        createdBy: c.attendant.id,
        status: 'ganho',
        items: [{ examId: c.examId, examName: 'Exame', unitPrice: 89.9, quantity: 1 }],
      });

      await app.agent
        .patch(`/api/v1/proposals/${proposal.id}/items`)
        .set(app.auth(c.attendant))
        .send({ items: [{ examId: c.examId, quantity: 2 }] })
        .expect(409);
    });

    it('sem itens -> VALIDATION_ERROR', async () => {
      const c = await cenario();
      const proposal = await createProposal({
        tenantId: c.tenantId,
        createdBy: c.attendant.id,
        items: [{ examId: c.examId, examName: 'Exame', unitPrice: 89.9, quantity: 1 }],
      });

      await app.agent
        .patch(`/api/v1/proposals/${proposal.id}/items`)
        .set(app.auth(c.attendant))
        .send({ items: [] })
        .expect(400);
    });

    it('exame inexistente -> EXAM_NOT_FOUND_OR_INACTIVE', async () => {
      const c = await cenario();
      const proposal = await createProposal({
        tenantId: c.tenantId,
        createdBy: c.attendant.id,
        items: [{ examId: c.examId, examName: 'Exame', unitPrice: 89.9, quantity: 1 }],
      });

      const response = await app.agent
        .patch(`/api/v1/proposals/${proposal.id}/items`)
        .set(app.auth(c.attendant))
        .send({ items: [{ examId: randomUUID(), quantity: 1 }] })
        .expect(400);

      const body = response.body as ApiErrorBody;
      expect(body.error.code).toBe('EXAM_NOT_FOUND_OR_INACTIVE');
    });
  });

  describe('PATCH /proposals/:id/approve | /reject', () => {
    it('atendente nao aprova -> FORBIDDEN com requiredRoles', async () => {
      const c = await cenario();
      const proposal = await createProposal({
        tenantId: c.tenantId,
        createdBy: c.attendant.id,
        approvalStatus: 'pending',
        discountPercent: 25,
      });

      const response = await app.agent
        .patch(`/api/v1/proposals/${proposal.id}/approve`)
        .set(app.auth(c.attendant))
        .expect(403);

      const body = response.body as ApiErrorBody;
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.details).toEqual({ requiredRoles: ['manager', 'admin'] });
    });

    it('reject sem motivo -> VALIDATION_ERROR', async () => {
      const c = await cenario();
      const proposal = await createProposal({
        tenantId: c.tenantId,
        createdBy: c.attendant.id,
        approvalStatus: 'pending',
        discountPercent: 25,
      });

      await app.agent
        .patch(`/api/v1/proposals/${proposal.id}/reject`)
        .set(app.auth(c.manager))
        .send({})
        .expect(400);
    });

    it('gestor aprova e a resposta segue ApproveProposalResponse', async () => {
      const c = await cenario();
      const proposal = await createProposal({
        tenantId: c.tenantId,
        createdBy: c.attendant.id,
        approvalStatus: 'pending',
        discountPercent: 25,
      });

      const response = await app.agent
        .patch(`/api/v1/proposals/${proposal.id}/approve`)
        .set(app.auth(c.manager))
        .expect(200);

      // Projecao parcial de D-070, sem texto de UI em pt-BR.
      expect(Object.keys(response.body as object).sort()).toEqual([
        'approvalStatus',
        'approvedAt',
        'id',
      ]);
      expect((response.body as { approvalStatus: string }).approvalStatus).toBe('approved');
    });
  });

  // -------------------------------------------------------------------------
  // Isolamento multitenant — BLOQUEANTE (TESTING.md)
  // -------------------------------------------------------------------------
  describe('isolamento multitenant', () => {
    it('GET /proposals nao traz proposta de outro tenant', async () => {
      const a = await cenario();
      const b = await cenario();
      await createProposal({ tenantId: a.tenantId, createdBy: a.attendant.id });
      await createProposal({ tenantId: b.tenantId, createdBy: b.attendant.id });

      const response = await app.agent
        .get('/api/v1/proposals')
        .set(app.auth(a.manager))
        .expect(200);
      const body = response.body as ListProposalsResponse;
      expect(body.proposals).toHaveLength(1);
      expect(body.pagination.total).toBe(1);
    });

    it('GET /proposals/:id de outro tenant -> 404 (nao 403)', async () => {
      const a = await cenario();
      const b = await cenario();
      const alheia = await createProposal({ tenantId: b.tenantId, createdBy: b.attendant.id });

      const response = await app.agent
        .get(`/api/v1/proposals/${alheia.id}`)
        .set(app.auth(a.manager))
        .expect(404);
      expect((response.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
    });

    it('PATCH em proposta de outro tenant -> 404', async () => {
      const a = await cenario();
      const b = await cenario();
      const alheia = await createProposal({ tenantId: b.tenantId, createdBy: b.attendant.id });

      await app.agent
        .patch(`/api/v1/proposals/${alheia.id}/status`)
        .set(app.auth(a.manager))
        .send({ status: 'orcamento_enviado' })
        .expect(404);

      await app.agent
        .patch(`/api/v1/proposals/${alheia.id}/discount`)
        .set(app.auth(a.manager))
        .send({ discountPercent: 5 })
        .expect(404);
    });

    it('criar proposta apontando para conversa de outro tenant -> 404', async () => {
      const a = await cenario();
      const b = await cenario();

      const response = await app.agent
        .post('/api/v1/proposals')
        .set(app.auth(a.attendant))
        .send({
          conversationId: b.conversationId,
          items: [{ examId: a.examId, quantity: 1 }],
        })
        .expect(404);
      expect((response.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
    });

    it('exame de outro tenant em items -> EXAM_NOT_FOUND_OR_INACTIVE', async () => {
      const a = await cenario();
      const b = await cenario();

      const response = await app.agent
        .post('/api/v1/proposals')
        .set(app.auth(a.attendant))
        .send({
          conversationId: a.conversationId,
          items: [{ examId: b.examId, quantity: 1 }],
        })
        .expect(400);

      const body = response.body as ApiErrorBody;
      expect(body.error.code).toBe('EXAM_NOT_FOUND_OR_INACTIVE');
      expect(body.error.details).toEqual({ examIds: [b.examId] });
    });

    it('operador de plataforma nao acessa propostas de laboratorio', async () => {
      const a = await cenario();
      const operador = await createUser({
        tenantId: a.tenantId,
        role: 'platform_operator',
        discountLimit: 0,
      });

      await app.agent.get('/api/v1/proposals').set(app.auth(operador)).expect(403);
    });
  });
});
