/**
 * Enviar orcamento pelo cartao do Bitlab (CRMLAB-58, D-200..D-202).
 *
 * Service real, banco real (PGlite), WS pelo FakeWsHub. O cartao nasce pelo
 * caminho de verdade (`ingestRows`, D-196). O unico dublê e o driver do canal,
 * para o teste mandar o WhatsApp falhar.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, ListProposalsResponse, Message, ProposalDetail } from '@crm-lab/shared';
import { makeProposalModule } from '../../src/controllers/proposal.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { MemoryCache } from '../../src/lib/cache.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import type { LisSpreadsheetRow } from '../../src/lib/lis-spreadsheet.js';
import { createAuditService } from '../../src/services/audit.service.js';
import { createLisImportService, type LisImportService } from '../../src/services/lis-import.service.js';
import {
  WhatsAppService,
  type SendResult,
  type WhatsAppDriver,
} from '../../src/services/whatsapp.service.js';
import {
  createConversation,
  createProposal,
  createTenant,
  createUser,
  type ConversationRecord,
  type TenantRecord,
  type UserRecord,
} from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createPatient, linkConversation } from '../patients/helpers.js';
import { testCredentialsResolver } from '../whatsapp/fixtures.js';

/** Driver que entrega ou falha, e guarda o que saiu. */
class ControlledDriver implements WhatsAppDriver {
  readonly name = 'controlled';
  failing = false;
  readonly sent: Array<{ phone: string; content: string }> = [];

  async send(_c: unknown, phone: string, content: string): Promise<SendResult> {
    if (this.failing) throw new Error('502 do gateway');
    this.sent.push({ phone, content });
    return { externalId: `wamid.${this.sent.length}.${Math.random()}` };
  }

  async sendMedia(): Promise<SendResult> {
    throw new Error('nao usado');
  }
}

function row(number: string, overrides: Partial<LisSpreadsheetRow> = {}): LisSpreadsheetRow {
  return {
    number,
    issuedOn: '2026-09-20',
    patientName: 'MARIA DA SILVA SOUZA',
    insurance1: 'PARTICULAR',
    value1: 150.5,
    insurance2: null,
    value2: null,
    insurance3: null,
    value3: null,
    attendantName: null,
    insuranceAverage: 150.5,
    requisitionNumber: null,
    requisitionValue: null,
    paidValue: null,
    paidOn: null,
    ...overrides,
  };
}

const MESSAGE = 'Olá, Maria! Segue o orçamento nº 5001 (Particular), no valor de R$ 150,50.';

let db: DbClient;
let app: TestApp;
let driver: ControlledDriver;
let lis: LisImportService;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let adminA: UserRecord;
let managerA: UserRecord;
let ana: UserRecord;
let bia: UserRecord;
let anaConversation: ConversationRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  driver = new ControlledDriver();
  const whatsapp = new WhatsAppService({
    credentials: testCredentialsResolver(new Map()),
    driver,
    queue: createInMemoryQueue({ sleep: async () => {}, defaults: { backoffMs: 1 } }),
    attempts: 3,
  });
  app = await createTestApp({ db, modules: [makeProposalModule({ whatsapp })] });
  lis = createLisImportService({
    db,
    cache: new MemoryCache(),
    audit: createAuditService(db),
    wsHub: app.wsHub,
  });
  tenantA = await createTenant({ db });
  tenantB = await createTenant({ db });
  adminA = await createUser({ tenantId: tenantA.id, role: 'admin', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', db });
  ana = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
  bia = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
  anaConversation = await createConversation({
    tenantId: tenantA.id,
    assignedTo: ana.id,
    patientName: 'Maria Souza',
    patientPhone: '+5548999990001',
    db,
  });
  await setSince(tenantA);
  await setSince(tenantB);
});

async function setSince(tenant: TenantRecord): Promise<void> {
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO tenant_settings (tenant_id, bitlab_proposals_since) VALUES ($1, '2026-09-01')
       ON CONFLICT (tenant_id) DO UPDATE SET bitlab_proposals_since = EXCLUDED.bitlab_proposals_since`,
      [tenant.id],
    ),
  );
}

/** Cartao `bitlab` em "Novo orcamento", sem conversa e sem responsavel. */
async function bitlabCard(
  tenant: TenantRecord,
  number: string,
  overrides: Partial<LisSpreadsheetRow> = {},
): Promise<string> {
  await lis.ingestRows({ tenantId: tenant.id, createdBy: null }, [row(number, overrides)], {
    kind: 'sync',
  });
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      'SELECT id FROM proposals WHERE tenant_id = $1 AND lis_budget_number = $2',
      [tenant.id, number],
    ),
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('cartao nao nasceu');
  return id;
}

async function rawProposal(id: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{
      status: string;
      conversation_id: string | null;
      created_by: string | null;
      sent_at: unknown;
      send_claim_id: string | null;
    }>(
      'SELECT status, conversation_id, created_by, sent_at, send_claim_id FROM proposals WHERE id = $1',
      [id],
    ),
  );
  return result.rows[0];
}

async function auditOf(entityId: string, action: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ user_id: string | null; old_values: unknown; new_values: unknown }>(
      'SELECT user_id, old_values, new_values FROM audit_logs WHERE entity_id = $1 AND action = $2',
      [entityId, action],
    ),
  );
  return result.rows;
}

async function historyOf(proposalId: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ status: string; changed_by: string | null }>(
      'SELECT status, changed_by FROM proposal_status_history WHERE proposal_id = $1 ORDER BY changed_at, id',
      [proposalId],
    ),
  );
  return result.rows;
}

async function messagesOf(conversationId: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ sender_type: string; content: string; status: string }>(
      'SELECT sender_type, content, status FROM messages WHERE conversation_id = $1 ORDER BY created_at, id',
      [conversationId],
    ),
  );
  return result.rows;
}

function send(user: UserRecord, id: string, conversationId: string, message = MESSAGE) {
  return app.agent
    .post(`/api/v1/proposals/${id}/send`)
    .set(app.auth(user))
    .send({ conversationId, message });
}

function errorOf(res: { body: unknown }) {
  return (res.body as ApiErrorBody).error;
}

async function setRules(tenant: TenantRecord, rules: unknown): Promise<void> {
  await db.withoutTenant((tx) =>
    tx.query('INSERT INTO funnel_rules (tenant_id, rules) VALUES ($1, $2::jsonb)', [
      tenant.id,
      JSON.stringify(rules),
    ]),
  );
}

describe('POST /proposals/:id/send', () => {
  it('sem requisicao: envia pelo canal, vincula a conversa, dona = quem enviou, vai a orcamento_enviado', async () => {
    const id = await bitlabCard(tenantA, '5001');
    app.wsHub.clear();

    const res = await send(ana, id, anaConversation.id);
    expect(res.status).toBe(200);
    const body = res.body as ProposalDetail;
    expect(body).toMatchObject({
      status: 'orcamento_enviado',
      conversationId: anaConversation.id,
      createdBy: ana.id,
      patientName: 'Maria Souza',
    });
    expect(body.sentAt).not.toBeNull();

    expect(driver.sent).toEqual([{ phone: '+5548999990001', content: MESSAGE }]);
    const messages = await messagesOf(anaConversation.id);
    expect(messages.map((m) => m.sender_type)).toEqual(['agent', 'system']);
    expect(messages[0]).toMatchObject({ content: MESSAGE, status: 'sent' });
    expect(messages[1]?.content).toContain('enviado — R$ 150,50');

    expect(await historyOf(id)).toEqual([
      { status: 'novo_contato', changed_by: null },
      { status: 'orcamento_enviado', changed_by: ana.id },
    ]);
    const [audit] = await auditOf(id, 'update_proposal_status');
    expect(audit?.user_id).toBe(ana.id);
    expect(audit?.old_values).toEqual({ status: 'novo_contato', conversationId: null, createdBy: null });
    expect(audit?.new_values).toMatchObject({
      status: 'orcamento_enviado',
      source: 'send',
      conversationId: anaConversation.id,
      createdBy: ana.id,
      messageId: expect.any(String),
    });
    expect(app.wsHub.eventsFor(tenantA.id, 'proposal.status_changed')).toHaveLength(1);
    expect(app.wsHub.eventsFor(tenantA.id, 'conversation.new_message')).toHaveLength(1);
    expect((await rawProposal(id))?.send_claim_id).toBeNull();
  });

  it('conversa da fila livre: enviar o cartao assume a conversa para quem enviou (CRMLAB-75)', async () => {
    const id = await bitlabCard(tenantA, '5009');
    const livre = await createConversation({
      tenantId: tenantA.id,
      assignedTo: null,
      patientPhone: '+5548999990009',
      db,
    });

    const res = await send(ana, id, livre.id);
    expect(res.status).toBe(200);
    const owner = await db.withoutTenant((tx) =>
      tx.query<{ assigned_to: string | null }>('SELECT assigned_to FROM conversations WHERE id = $1', [
        livre.id,
      ]),
    );
    expect(owner.rows[0]?.assigned_to).toBe(ana.id);
    const [audit] = await auditOf(livre.id, 'assign_conversation');
    expect(audit).toMatchObject({ user_id: ana.id, new_values: { assignedTo: ana.id } });
  });

  it('com requisicao (pre-cadastro) vai direto a negociacao', async () => {
    const id = await bitlabCard(tenantA, '5002', { requisitionNumber: '001-1', requisitionValue: 150.5 });
    const res = await send(ana, id, anaConversation.id);
    expect(res.status).toBe(200);
    expect((res.body as ProposalDetail).status).toBe('negociacao');
    expect((await historyOf(id)).map((h) => h.status)).toEqual(['novo_contato', 'negociacao']);
  });

  it('com requisicao e "Requisicao -> Negociacao" desligada: orcamento_enviado', async () => {
    await setRules(tenantA, { automation: { requisitionToNegotiation: { enabled: false } } });
    const id = await bitlabCard(tenantA, '5003', { requisitionNumber: '001-2', requisitionValue: 150.5 });
    const res = await send(ana, id, anaConversation.id);
    expect((res.body as ProposalDetail).status).toBe('orcamento_enviado');
  });

  it('WhatsApp falhou: 502, o cartao nao muda e a reserva e desfeita', async () => {
    const id = await bitlabCard(tenantA, '5004');
    driver.failing = true;
    app.wsHub.clear();

    const res = await send(ana, id, anaConversation.id);
    expect(res.status).toBe(502);
    expect(errorOf(res).code).toBe('MESSAGE_SEND_FAILED');

    expect(await rawProposal(id)).toEqual({
      status: 'novo_contato',
      conversation_id: null,
      created_by: null,
      sent_at: null,
      send_claim_id: null,
    });
    expect(await historyOf(id)).toHaveLength(1);
    expect(await auditOf(id, 'update_proposal_status')).toHaveLength(0);
    expect(app.wsHub.eventsFor(tenantA.id, 'proposal.status_changed')).toHaveLength(0);
    // A mensagem fica na conversa como falha, igual ao envio do atendimento.
    expect(await messagesOf(anaConversation.id)).toEqual([
      { sender_type: 'agent', content: MESSAGE, status: 'failed' },
    ]);

    // Canal de volta: a mesma atendente tenta de novo e passa.
    driver.failing = false;
    const retry = await send(ana, id, anaConversation.id);
    expect(retry.status).toBe(200);
  });

  it('duas atendentes ao mesmo tempo: so uma vence, o paciente recebe uma mensagem so', async () => {
    const id = await bitlabCard(tenantA, '5005');
    const biaConversation = await createConversation({ tenantId: tenantA.id, assignedTo: bia.id, db });

    const [first, second] = await Promise.all([
      send(ana, id, anaConversation.id),
      send(bia, id, biaConversation.id),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    expect(errorOf(loser).code).toBe('PROPOSAL_ALREADY_SENT');
    expect(driver.sent).toHaveLength(1);
    expect((await historyOf(id)).filter((h) => h.status === 'orcamento_enviado')).toHaveLength(1);
  });

  it('reserva viva de outra tentativa -> in_progress; reserva abandonada (> 2 min) e retomada', async () => {
    const id = await bitlabCard(tenantA, '5006');
    await db.withoutTenant((tx) =>
      tx.query(
        `UPDATE proposals SET send_claim_id = gen_random_uuid(), send_claimed_at = NOW() WHERE id = $1`,
        [id],
      ),
    );
    const busy = await send(ana, id, anaConversation.id);
    expect(busy.status).toBe(409);
    expect(errorOf(busy).details).toEqual({ reason: 'in_progress' });
    expect(driver.sent).toHaveLength(0);

    await db.withoutTenant((tx) =>
      tx.query(
        `UPDATE proposals SET send_claimed_at = NOW() - INTERVAL '3 minutes' WHERE id = $1`,
        [id],
      ),
    );
    expect((await send(ana, id, anaConversation.id)).status).toBe(200);
  });

  it('ja enviado -> PROPOSAL_ALREADY_SENT sent; fora de novo_contato -> INVALID_STATUS_TRANSITION', async () => {
    const id = await bitlabCard(tenantA, '5007');
    expect((await send(ana, id, anaConversation.id)).status).toBe(200);
    const again = await send(ana, id, anaConversation.id);
    expect(again.status).toBe(409);
    expect(errorOf(again)).toMatchObject({ code: 'PROPOSAL_ALREADY_SENT', details: { reason: 'sent' } });

    const moved = await bitlabCard(tenantA, '5008');
    await db.withoutTenant((tx) =>
      tx.query(`UPDATE proposals SET status = 'follow_up' WHERE id = $1`, [moved]),
    );
    const res = await send(ana, moved, anaConversation.id);
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('INVALID_STATUS_TRANSITION');

    const lost = await bitlabCard(tenantA, '5009');
    await db.withoutTenant((tx) =>
      tx.query(`UPDATE proposals SET status = 'perdido', reason_lost = 'preco' WHERE id = $1`, [lost]),
    );
    expect(errorOf(await send(ana, lost, anaConversation.id)).code).toBe('PROPOSAL_ALREADY_CLOSED');
    expect(driver.sent).toHaveLength(1);
  });

  it('proposta de origem crm -> PROPOSAL_EDIT_NOT_ALLOWED crm_origin', async () => {
    const crm = await createProposal({
      tenantId: tenantA.id,
      conversationId: anaConversation.id,
      createdBy: ana.id,
      approvalStatus: 'approved',
      totalPrice: 100,
      db,
    });
    const res = await send(ana, crm.id, anaConversation.id);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toMatchObject({
      code: 'PROPOSAL_EDIT_NOT_ALLOWED',
      details: { reason: 'crm_origin' },
    });
  });

  it('conversa de outra atendente, de outro tenant ou encerrada nao serve', async () => {
    const id = await bitlabCard(tenantA, '5010');
    const biaConversation = await createConversation({ tenantId: tenantA.id, assignedTo: bia.id, db });
    const other = await createConversation({ tenantId: tenantB.id, db });
    const closed = await createConversation({
      tenantId: tenantA.id,
      assignedTo: ana.id,
      status: 'closed',
      db,
    });

    expect(errorOf(await send(ana, id, biaConversation.id)).code).toBe('NOT_FOUND');
    expect(errorOf(await send(ana, id, other.id)).code).toBe('NOT_FOUND');
    const archived = await send(ana, id, closed.id);
    expect(archived.status).toBe(409);
    expect(errorOf(archived).code).toBe('CONVERSATION_ARCHIVED');
    expect(driver.sent).toHaveLength(0);
    expect((await rawProposal(id))?.send_claim_id).toBeNull();

    // A fila livre serve para a atendente; gestor usa qualquer conversa.
    const free = await createConversation({ tenantId: tenantA.id, db });
    expect((await send(managerA, id, biaConversation.id)).status).toBe(200);
    const id2 = await bitlabCard(tenantA, '5011');
    expect((await send(ana, id2, free.id)).status).toBe(200);
  });

  it('isolamento: cartao de outro tenant -> 404', async () => {
    const foreign = await bitlabCard(tenantB, '5012');
    const res = await send(adminA, foreign, anaConversation.id);
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe('NOT_FOUND');
  });

  it('trava "mover card de outra atendente" desligada: gestor nao envia o cartao da atendente', async () => {
    const id = await bitlabCard(tenantA, '5013');
    await db.withoutTenant((tx) =>
      tx.query('UPDATE proposals SET created_by = $2 WHERE id = $1', [id, ana.id]),
    );
    await setRules(tenantA, { manualMoves: { moveOthersCards: false } });
    const res = await send(managerA, id, anaConversation.id);
    expect(res.status).toBe(403);
    expect(errorOf(res).details).toEqual({ reason: 'move_others_not_allowed' });
    // Admin sempre pode; a atendente que nao e dona nem ve.
    expect((await send(bia, id, anaConversation.id)).status).toBe(404);
    expect((await send(adminA, id, anaConversation.id)).status).toBe(200);
  });

  it('mensagem vazia -> VALIDATION_ERROR', async () => {
    const id = await bitlabCard(tenantA, '5014');
    const res = await send(ana, id, anaConversation.id, '   ');
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  });

  it('depois do vinculo a ficha do paciente lista a proposta', async () => {
    const patient = await createPatient({ tenantId: tenantA.id, phone: anaConversation.patientPhone, db });
    await linkConversation(anaConversation.id, patient.id, { db });
    const id = await bitlabCard(tenantA, '5015');

    const before = await app.agent
      .get(`/api/v1/proposals?patientId=${patient.id}`)
      .set(app.auth(managerA));
    expect((before.body as ListProposalsResponse).proposals).toHaveLength(0);

    expect((await send(ana, id, anaConversation.id)).status).toBe(200);
    const after = await app.agent
      .get(`/api/v1/proposals?patientId=${patient.id}`)
      .set(app.auth(ana));
    expect((after.body as ListProposalsResponse).proposals.map((p) => p.id)).toEqual([id]);
  });
});

describe('POST /proposals/:id/resend', () => {
  async function sentCard(number: string): Promise<string> {
    const id = await bitlabCard(tenantA, number);
    expect((await send(ana, id, anaConversation.id)).status).toBe(200);
    return id;
  }

  it('manda de novo pela conversa vinculada sem mudar o estagio', async () => {
    const id = await sentCard('6001');
    await db.withoutTenant((tx) =>
      tx.query(`UPDATE proposals SET status = 'follow_up' WHERE id = $1`, [id]),
    );
    const before = await rawProposal(id);

    const res = await app.agent
      .post(`/api/v1/proposals/${id}/resend`)
      .set(app.auth(ana))
      .send({ message: 'Lembrete do orçamento' });
    expect(res.status).toBe(201);
    expect((res.body as Message).content).toBe('Lembrete do orçamento');
    expect(driver.sent.map((s) => s.content)).toEqual([MESSAGE, 'Lembrete do orçamento']);

    const after = await rawProposal(id);
    expect(after?.status).toBe('follow_up');
    expect(after?.sent_at).toEqual(before?.sent_at);
    const [audit] = await auditOf(id, 'resend_proposal_message');
    expect(audit?.new_values).toEqual({
      conversationId: anaConversation.id,
      messageId: (res.body as Message).id,
    });
  });

  it('cartao nao enviado, crm ou fechado: recusa; falha do canal nao muda nada', async () => {
    const unsent = await bitlabCard(tenantA, '6002');
    const r1 = await app.agent
      .post(`/api/v1/proposals/${unsent}/resend`)
      .set(app.auth(managerA))
      .send({ message: 'x' });
    expect(errorOf(r1)).toMatchObject({ code: 'PROPOSAL_EDIT_NOT_ALLOWED', details: { reason: 'not_sent' } });

    const id = await sentCard('6003');
    driver.failing = true;
    const failed = await app.agent
      .post(`/api/v1/proposals/${id}/resend`)
      .set(app.auth(ana))
      .send({ message: 'x' });
    expect(failed.status).toBe(502);
    expect(await auditOf(id, 'resend_proposal_message')).toHaveLength(0);
    expect((await rawProposal(id))?.status).toBe('orcamento_enviado');

    driver.failing = false;
    await db.withoutTenant((tx) =>
      tx.query(`UPDATE proposals SET status = 'ganho', closed_at = NOW() WHERE id = $1`, [id]),
    );
    const closed = await app.agent
      .post(`/api/v1/proposals/${id}/resend`)
      .set(app.auth(ana))
      .send({ message: 'x' });
    expect(errorOf(closed).code).toBe('PROPOSAL_ALREADY_CLOSED');
  });

  it('outra atendente nem enxerga (404); gestor reenvia', async () => {
    const id = await sentCard('6004');
    const other = await app.agent
      .post(`/api/v1/proposals/${id}/resend`)
      .set(app.auth(bia))
      .send({ message: 'x' });
    expect(other.status).toBe(404);
    const byManager = await app.agent
      .post(`/api/v1/proposals/${id}/resend`)
      .set(app.auth(managerA))
      .send({ message: 'x' });
    expect(byManager.status).toBe(201);
  });
});

describe('PATCH /proposals/:id/conversation', () => {
  async function sentCard(number: string): Promise<string> {
    const id = await bitlabCard(tenantA, number);
    expect((await send(ana, id, anaConversation.id)).status).toBe(200);
    return id;
  }

  function relink(user: UserRecord, id: string, conversationId: string) {
    return app.agent
      .patch(`/api/v1/proposals/${id}/conversation`)
      .set(app.auth(user))
      .send({ conversationId });
  }

  it('a dona troca a conversa, com audit e sem mandar mensagem', async () => {
    const id = await sentCard('7001');
    const right = await createConversation({ tenantId: tenantA.id, assignedTo: ana.id, db });
    app.wsHub.clear();

    const res = await relink(ana, id, right.id);
    expect(res.status).toBe(200);
    expect((res.body as ProposalDetail).conversationId).toBe(right.id);
    expect(driver.sent).toHaveLength(1);
    const [audit] = await auditOf(id, 'update_proposal_conversation');
    expect(audit?.old_values).toEqual({ conversationId: anaConversation.id });
    expect(audit?.new_values).toEqual({ conversationId: right.id });
    expect(app.wsHub.eventsFor(tenantA.id, 'proposal.updated')).toHaveLength(1);

    // Mesma conversa: nada gravado.
    await relink(ana, id, right.id);
    expect(await auditOf(id, 'update_proposal_conversation')).toHaveLength(1);
  });

  it('nao enviado, fechado, conversa invisivel ou de outro tenant: recusa', async () => {
    const unsent = await bitlabCard(tenantA, '7002');
    expect(errorOf(await relink(managerA, unsent, anaConversation.id)).details).toMatchObject({
      reason: 'not_sent',
    });

    const id = await sentCard('7003');
    const biaConversation = await createConversation({ tenantId: tenantA.id, assignedTo: bia.id, db });
    const foreign = await createConversation({ tenantId: tenantB.id, db });
    expect((await relink(ana, id, biaConversation.id)).status).toBe(404);
    expect((await relink(managerA, id, foreign.id)).status).toBe(404);
    expect((await relink(managerA, id, biaConversation.id)).status).toBe(200);

    await db.withoutTenant((tx) =>
      tx.query(`UPDATE proposals SET status = 'perdido', reason_lost = 'preco' WHERE id = $1`, [id]),
    );
    expect(errorOf(await relink(managerA, id, anaConversation.id)).code).toBe('PROPOSAL_ALREADY_CLOSED');
  });
});

describe('PATCH /proposals/:id/responsible', () => {
  function setOwner(user: UserRecord, id: string, userId: string) {
    return app.agent
      .patch(`/api/v1/proposals/${id}/responsible`)
      .set(app.auth(user))
      .send({ userId });
  }

  it('gestor define qualquer usuario ativo, inclusive em proposta ganha', async () => {
    const id = await bitlabCard(tenantA, '8001');
    app.wsHub.clear();
    const res = await setOwner(managerA, id, bia.id);
    expect(res.status).toBe(200);
    expect((res.body as ProposalDetail).createdBy).toBe(bia.id);
    const [audit] = await auditOf(id, 'update_proposal_responsible');
    expect(audit?.old_values).toEqual({ createdBy: null });
    expect(audit?.new_values).toEqual({ createdBy: bia.id });
    expect(app.wsHub.eventsFor(tenantA.id, 'proposal.updated')).toHaveLength(1);

    await db.withoutTenant((tx) =>
      tx.query(`UPDATE proposals SET status = 'ganho', closed_at = NOW() WHERE id = $1`, [id]),
    );
    expect((await setOwner(adminA, id, managerA.id)).status).toBe(200);
  });

  it('atendente dona passa para outra atendente e deixa de ver o cartao', async () => {
    const id = await bitlabCard(tenantA, '8002');
    expect((await send(ana, id, anaConversation.id)).status).toBe(200);

    expect((await setOwner(ana, id, bia.id)).status).toBe(200);
    expect((await app.agent.get(`/api/v1/proposals/${id}`).set(app.auth(ana))).status).toBe(404);
    expect((await app.agent.get(`/api/v1/proposals/${id}`).set(app.auth(bia))).status).toBe(200);
  });

  it('atendente: nao passa para gestor, nao mexe no que nao e dela nem em fechada', async () => {
    const id = await bitlabCard(tenantA, '8003');
    // Cartao sem responsavel nao e "dela".
    const unowned = await setOwner(ana, id, bia.id);
    expect(unowned.status).toBe(403);
    expect(errorOf(unowned).details).toEqual({ reason: 'not_owner' });

    expect((await send(ana, id, anaConversation.id)).status).toBe(200);
    const toManager = await setOwner(ana, id, managerA.id);
    expect(toManager.status).toBe(400);
    expect(errorOf(toManager).code).toBe('VALIDATION_ERROR');

    await db.withoutTenant((tx) =>
      tx.query(`UPDATE proposals SET status = 'ganho', closed_at = NOW() WHERE id = $1`, [id]),
    );
    expect(errorOf(await setOwner(ana, id, bia.id)).details).toEqual({ reason: 'closed' });
  });

  it('usuario inativo ou de outro tenant -> VALIDATION_ERROR; proposta de outro tenant -> 404', async () => {
    const id = await bitlabCard(tenantA, '8004');
    const inactive = await createUser({ tenantId: tenantA.id, role: 'attendant', isActive: false, db });
    const foreignUser = await createUser({ tenantId: tenantB.id, role: 'attendant', db });
    expect((await setOwner(managerA, id, inactive.id)).status).toBe(400);
    expect((await setOwner(managerA, id, foreignUser.id)).status).toBe(400);
    expect(await auditOf(id, 'update_proposal_responsible')).toHaveLength(0);

    const foreign = await bitlabCard(tenantB, '8005');
    expect((await setOwner(adminA, foreign, bia.id)).status).toBe(404);
  });

  it('vale tambem para proposta de origem crm', async () => {
    const crm = await createProposal({
      tenantId: tenantA.id,
      conversationId: anaConversation.id,
      createdBy: ana.id,
      totalPrice: 100,
      db,
    });
    expect((await setOwner(managerA, crm.id, bia.id)).status).toBe(200);
  });
});
