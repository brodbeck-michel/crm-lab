/**
 * Regua de fatos do LIS para o cartao do Bitlab (CRMLAB-60 parcial, D-204):
 * requisicao -> negociacao, pagamento -> ganho, pelas Regras. Origem `crm`
 * continua com a D-119.
 *
 * Service real, banco real (PGlite), WS pelo FakeWsHub. O cartao nasce pela
 * ingestao (D-196) e e posto no estagio de partida por SQL.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProposalDetail } from '@crm-lab/shared';
import { proposalModule } from '../../src/controllers/proposal.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { MemoryCache } from '../../src/lib/cache.js';
import type { LisSpreadsheetRow } from '../../src/lib/lis-spreadsheet.js';
import { createAuditService } from '../../src/services/audit.service.js';
import { createLisImportService, type LisImportService } from '../../src/services/lis-import.service.js';
import {
  createConversation,
  createProposal,
  createTenant,
  createUser,
  type TenantRecord,
  type UserRecord,
} from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

function row(number: string, overrides: Partial<LisSpreadsheetRow> = {}): LisSpreadsheetRow {
  return {
    number,
    issuedOn: '2026-09-20',
    patientName: `Paciente ${number}`,
    insurance1: 'PARTICULAR',
    value1: 100,
    insurance2: null,
    value2: null,
    insurance3: null,
    value3: null,
    attendantName: null,
    insuranceAverage: 100,
    requisitionNumber: null,
    requisitionValue: null,
    paidValue: null,
    paidOn: null,
    ...overrides,
  };
}

const REQ = { requisitionNumber: '001-0001', requisitionValue: 100 };
const PAID = { paidValue: 100, paidOn: '2026-09-22' };

let db: DbClient;
let app: TestApp;
let lis: LisImportService;
let tenant: TenantRecord;
let manager: UserRecord;
let attendant: UserRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [proposalModule] });
  lis = createLisImportService({
    db,
    cache: new MemoryCache(),
    audit: createAuditService(db),
    wsHub: app.wsHub,
  });
  tenant = await createTenant({ db });
  manager = await createUser({ tenantId: tenant.id, role: 'manager', db });
  attendant = await createUser({ tenantId: tenant.id, role: 'attendant', db });
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO tenant_settings (tenant_id, bitlab_proposals_since) VALUES ($1, '2026-09-01')`,
      [tenant.id],
    ),
  );
});

async function ingest(rows: LisSpreadsheetRow[]) {
  return lis.ingestRows({ tenantId: tenant.id, createdBy: null }, rows, { kind: 'sync' });
}

/** Cartao `bitlab` no estagio pedido; `linked` = ja enviado, com conversa e dona. */
async function card(number: string, status: string, linked = true): Promise<{ id: string; conversationId: string | null }> {
  await ingest([row(number)]);
  const conversation = linked ? await createConversation({ tenantId: tenant.id, db }) : null;
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      `UPDATE proposals
          SET status = $3::text, conversation_id = $4, created_by = $5,
              sent_at = CASE WHEN $4::uuid IS NULL THEN NULL ELSE NOW() END,
              reason_lost = CASE WHEN $3::text = 'perdido' THEN 'preco' END
        WHERE tenant_id = $1 AND lis_budget_number = $2 RETURNING id`,
      [tenant.id, number, status, conversation?.id ?? null, linked ? attendant.id : null],
    ),
  );
  return { id: result.rows[0]!.id, conversationId: conversation?.id ?? null };
}

async function detail(id: string): Promise<ProposalDetail> {
  const res = await app.agent.get(`/api/v1/proposals/${id}`).set(app.auth(manager));
  expect(res.status).toBe(200);
  return res.body as ProposalDetail;
}

async function statusAudits(id: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ user_id: string | null; old_values: unknown; new_values: unknown }>(
      `SELECT user_id, old_values, new_values FROM audit_logs
        WHERE entity_id = $1 AND action = 'update_proposal_status' ORDER BY timestamp`,
      [id],
    ),
  );
  return result.rows;
}

async function historyOf(id: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ status: string; changed_by: string | null }>(
      'SELECT status, changed_by FROM proposal_status_history WHERE proposal_id = $1 ORDER BY changed_at, id',
      [id],
    ),
  );
  return result.rows;
}

async function systemMessages(conversationId: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ content: string }>(
      `SELECT content FROM messages WHERE conversation_id = $1 AND sender_type = 'system'`,
      [conversationId],
    ),
  );
  return result.rows.map((r) => r.content);
}

async function setRules(rules: unknown): Promise<void> {
  await db.withoutTenant((tx) =>
    tx.query('INSERT INTO funnel_rules (tenant_id, rules) VALUES ($1, $2::jsonb)', [
      tenant.id,
      JSON.stringify(rules),
    ]),
  );
}

function statusEvents(id: string) {
  return app.wsHub.emitted
    .filter((e) => e.event === 'proposal.status_changed')
    .map((e) => e.data as { proposalId: string; status: string })
    .filter((d) => d.proposalId === id);
}

describe('requisicao -> negociacao (cartao bitlab)', () => {
  it('em orcamento_enviado: vai a negociacao pelo sistema, sem contar como ganho', async () => {
    const { id, conversationId } = await card('1001', 'orcamento_enviado');
    app.wsHub.clear();

    const result = await ingest([row('1001', REQ)]);
    expect(result.proposalsWon).toBe(0);
    const body = await detail(id);
    expect(body).toMatchObject({ status: 'negociacao', lisRequisitionNumber: '001-0001', lisReconciledAt: null, closedAt: null });
    expect((await historyOf(id)).at(-1)).toEqual({ status: 'negociacao', changed_by: null });
    const audits = await statusAudits(id);
    expect(audits.at(-1)).toMatchObject({
      user_id: null,
      old_values: { status: 'orcamento_enviado' },
      new_values: { status: 'negociacao', source: 'lis_requisition' },
    });
    expect(statusEvents(id)).toEqual([{ proposalId: id, status: 'negociacao' }]);
    expect(await systemMessages(conversationId!)).toEqual([
      expect.stringContaining('em negociação — requisição aberta no LIS'),
    ]);
  });

  it('em follow_up tambem; em negociacao com requisicao e sem pagamento fica', async () => {
    const followUp = await card('1002', 'follow_up');
    const negotiating = await card('1003', 'negociacao');
    await ingest([row('1002', REQ), row('1003', REQ)]);
    expect((await detail(followUp.id)).status).toBe('negociacao');
    expect((await detail(negotiating.id)).status).toBe('negociacao');
    expect(await statusAudits(negotiating.id)).toHaveLength(0);
  });

  it('em novo_contato continua so o selo de pre-cadastro (D-197)', async () => {
    const { id } = await card('1004', 'novo_contato', false);
    await ingest([row('1004', REQ)]);
    expect(await detail(id)).toMatchObject({ status: 'novo_contato', lisRequisitionNumber: '001-0001' });
  });

  it('regra desligada: nao move; requisicao sozinha nunca leva a ganho', async () => {
    await setRules({ automation: { requisitionToNegotiation: { enabled: false } } });
    const { id } = await card('1005', 'orcamento_enviado');
    const result = await ingest([row('1005', REQ)]);
    expect(result.proposalsWon).toBe(0);
    expect((await detail(id)).status).toBe('orcamento_enviado');
  });

  it('idempotente: a segunda conciliacao nao gera nada', async () => {
    const { id, conversationId } = await card('1006', 'orcamento_enviado');
    await ingest([row('1006', REQ)]);
    await ingest([row('1006', { ...REQ, value1: 110, insuranceAverage: 110 })]);
    expect(await statusAudits(id)).toHaveLength(1);
    expect(await systemMessages(conversationId!)).toHaveLength(1);
  });
});

describe('pagamento -> ganho (cartao bitlab)', () => {
  it('em negociacao: ganho com lis_reconciled_at, conta em proposalsWon', async () => {
    const { id } = await card('2001', 'negociacao');
    app.wsHub.clear();
    const result = await ingest([row('2001', { ...REQ, ...PAID })]);
    expect(result.proposalsWon).toBe(1);
    const body = await detail(id);
    expect(body.status).toBe('ganho');
    expect(body.closedAt).not.toBeNull();
    expect(body.lisReconciledAt).not.toBeNull();
    expect((await statusAudits(id)).at(-1)?.new_values).toEqual({ status: 'ganho', source: 'lis_payment' });
    expect(statusEvents(id)).toEqual([{ proposalId: id, status: 'ganho' }]);
  });

  it('balcao: pago em novo_contato, sem conversa, vai a ganho sem mensagem de sistema', async () => {
    const { id } = await card('2002', 'novo_contato', false);
    const result = await ingest([row('2002', PAID)]);
    expect(result.proposalsWon).toBe(1);
    expect((await detail(id)).status).toBe('ganho');
    const messages = await db.withoutTenant((tx) =>
      tx.query('SELECT id FROM messages WHERE tenant_id = $1', [tenant.id]),
    );
    expect(messages.rows).toHaveLength(0);
  });

  it('requisicao e pagamento juntos em orcamento_enviado: direto a ganho; qualquer valor conta', async () => {
    const { id } = await card('2003', 'orcamento_enviado');
    await ingest([row('2003', { ...REQ, paidValue: 0, paidOn: '2026-09-22' })]);
    expect((await detail(id)).status).toBe('ganho');
    expect((await historyOf(id)).map((h) => h.status)).toEqual(['novo_contato', 'ganho']);
  });

  it('estorno depois de ganho: o cartao nao reabre e o valor pago espelhado vai a 0 (CRMLAB-53, D-188 item 7)', async () => {
    const { id } = await card('2005', 'negociacao');
    const pago = { ...REQ, paidValue: 100, paidOn: '2026-09-22', paidAt: '2026-09-22 08:00:00', paymentId: '77' };
    await ingest([row('2005', { ...pago, paymentStatus: 'ativo' })]);
    expect((await detail(id)).status).toBe('ganho');

    await ingest([row('2005', { ...pago, paymentStatus: 'estornado', reversedAt: '2026-09-23 09:00:00' })]);
    const after = await detail(id);
    expect(after.status).toBe('ganho');
    expect(after.lisPaidValue).toBe(0);
    expect(after.lisPaidOn).toBeNull();
  });

  it('regra desligada: pagamento nao move', async () => {
    await setRules({ automation: { paymentToWon: { enabled: false } } });
    const { id } = await card('2004', 'negociacao');
    const result = await ingest([row('2004', { ...REQ, ...PAID })]);
    expect(result.proposalsWon).toBe(0);
    expect(await detail(id)).toMatchObject({ status: 'negociacao', lisPaidOn: '2026-09-22' });
  });

  it('perdido nao reabre: espelha e audita o conflito uma vez', async () => {
    const { id } = await card('2005', 'perdido');
    await ingest([row('2005', { ...REQ, ...PAID })]);
    await ingest([row('2005', { ...REQ, ...PAID })]);
    expect((await detail(id)).status).toBe('perdido');
    const conflicts = await db.withoutTenant((tx) =>
      tx.query(
        `SELECT id FROM audit_logs WHERE entity_id = $1 AND action = 'lis_reconcile_conflict'`,
        [id],
      ),
    );
    expect(conflicts.rows).toHaveLength(1);
  });
});

describe('origem crm: mesma regua (D-252, substitui a D-119)', () => {
  /** Proposta do CRM vinculada pelo nº digitado (PATCH lis-reference). */
  async function manual(number: string, status: string): Promise<{ id: string }> {
    const conversation = await createConversation({ tenantId: tenant.id, db });
    const proposal = await createProposal({
      tenantId: tenant.id,
      conversationId: conversation.id,
      createdBy: attendant.id,
      status,
      approvalStatus: 'approved',
      totalPrice: 100,
      db,
    });
    await app.agent
      .patch(`/api/v1/proposals/${proposal.id}/lis-reference`)
      .set(app.auth(attendant))
      .send({ lisBudgetNumber: number })
      .expect(200);
    return { id: proposal.id };
  }

  it('requisicao em orcamento_enviado leva a negociacao, nao a ganho', async () => {
    const { id } = await manual('3001', 'orcamento_enviado');
    const result = await ingest([row('3001', REQ)]);
    expect(result.proposalsWon).toBe(0);
    const body = await detail(id);
    expect(body.status).toBe('negociacao');
    expect(body.lisReconciledAt).toBeNull();
    expect((await statusAudits(id)).at(-1)?.new_values).toEqual({
      status: 'negociacao',
      source: 'lis_requisition',
    });
  });

  it('requisicao em novo_contato nao move', async () => {
    const { id } = await manual('3002', 'novo_contato');
    await ingest([row('3002', REQ)]);
    expect(await detail(id)).toMatchObject({ status: 'novo_contato', lisRequisitionNumber: '001-0001' });
  });

  it('pagamento leva a ganho de qualquer estagio aberto', async () => {
    const { id } = await manual('3003', 'novo_contato');
    const result = await ingest([row('3003', PAID)]);
    expect(result.proposalsWon).toBe(1);
    const body = await detail(id);
    expect(body.status).toBe('ganho');
    expect(body.lisReconciledAt).not.toBeNull();
    expect((await statusAudits(id)).at(-1)?.new_values).toEqual({ status: 'ganho', source: 'lis_payment' });
  });

  it('regras desligadas: requisicao e pagamento nao movem', async () => {
    await setRules({
      automation: { requisitionToNegotiation: { enabled: false }, paymentToWon: { enabled: false } },
    });
    const { id } = await manual('3004', 'orcamento_enviado');
    const result = await ingest([row('3004', { ...REQ, ...PAID })]);
    expect(result.proposalsWon).toBe(0);
    expect(await detail(id)).toMatchObject({ status: 'orcamento_enviado', lisPaidOn: '2026-09-22' });
  });
});
