/**
 * Conciliacao LIS <-> propostas (CRMLAB-52, D-119).
 *
 * Exercita os dois momentos do item 3: o `PATCH /proposals/:id/lis-reference`
 * contra um orcamento que ja existe, e o hook por chunk de `ingestRows` (o
 * mesmo caminho da planilha e da API). Sem mock de regra: service real, banco
 * real (PGlite), WS pelo FakeWsHub do app de teste.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, FunnelReport, ProposalDetail } from '@crm-lab/shared';
import { analyticsModule } from '../../src/controllers/analytics.routes.js';
import { lisImportModule } from '../../src/controllers/lis-import.routes.js';
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
  type ProposalRecord,
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

const PAID = { requisitionNumber: '001-0009876', requisitionValue: 100, paidValue: 100, paidOn: '2026-09-22' };

let db: DbClient;
let app: TestApp;
let lis: LisImportService;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let adminA: UserRecord;
let managerA: UserRecord;
let attendantA: UserRecord;
let otherAttendantA: UserRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [proposalModule, lisImportModule, analyticsModule] });
  lis = createLisImportService({
    db,
    cache: new MemoryCache(),
    audit: createAuditService(db),
    wsHub: app.wsHub,
  });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  adminA = await createUser({ tenantId: tenantA.id, role: 'admin', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', db });
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
  otherAttendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
});

async function proposalOf(
  owner: UserRecord,
  status = 'orcamento_enviado',
  extra: { approvalStatus?: 'approved' | 'pending'; reasonLost?: string } = {},
): Promise<ProposalRecord> {
  const conversation = await createConversation({ tenantId: owner.tenantId, db });
  return createProposal({
    tenantId: owner.tenantId,
    conversationId: conversation.id,
    createdBy: owner.id,
    status,
    approvalStatus: extra.approvalStatus ?? 'approved',
    reasonLost: extra.reasonLost ?? null,
    totalPrice: 100,
    db,
  });
}

async function link(user: UserRecord, proposalId: string, lisBudgetNumber: string | null) {
  return app.agent
    .patch(`/api/v1/proposals/${proposalId}/lis-reference`)
    .set(app.auth(user))
    .send({ lisBudgetNumber });
}

async function ingest(tenant: TenantRecord, rows: LisSpreadsheetRow[]) {
  return lis.ingestRows({ tenantId: tenant.id, createdBy: null }, rows, { kind: 'sync' });
}

async function detail(user: UserRecord, proposalId: string): Promise<ProposalDetail> {
  const res = await app.agent.get(`/api/v1/proposals/${proposalId}`).set(app.auth(user));
  expect(res.status).toBe(200);
  return res.body as ProposalDetail;
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

async function budgetLink(tenant: TenantRecord, number: string): Promise<string | null> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ proposal_id: string | null }>(
      'SELECT proposal_id FROM lis_budgets WHERE tenant_id = $1 AND number = $2',
      [tenant.id, number],
    ),
  );
  return result.rows[0]?.proposal_id ?? null;
}

function wonEvents(proposalId: string) {
  return app.wsHub.emitted.filter(
    (e) => e.event === 'proposal.status_changed' && (e.data as { proposalId: string }).proposalId === proposalId,
  );
}

describe('PATCH /proposals/:id/lis-reference', () => {
  it('grava o numero sem zeros a esquerda e, sem orcamento no CRM, nao muda o estagio', async () => {
    const proposal = await proposalOf(attendantA);
    const res = await link(attendantA, proposal.id, ' 001234 ');
    expect(res.status).toBe(200);
    const body = res.body as ProposalDetail;
    expect(body).toMatchObject({
      status: 'orcamento_enviado',
      lisBudgetNumber: '1234',
      lisReconciledAt: null,
      lisRequisitionNumber: null,
      lisPaidValue: null,
      lisPaidOn: null,
    });
    const audits = await auditOf(proposal.id, 'update_proposal_lis_reference');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.new_values).toEqual({ lisBudgetNumber: '1234' });
  });

  it('recusa numero com letra ou longo demais', async () => {
    const proposal = await proposalOf(attendantA);
    for (const value of ['12a4', '', '123456789012345678901']) {
      const res = await link(attendantA, proposal.id, value);
      expect(res.status).toBe(400);
      expect((res.body as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('numero ja usado por outra proposta do tenant -> CONFLICT com o numero da outra', async () => {
    const first = await proposalOf(attendantA);
    const second = await proposalOf(attendantA);
    expect((await link(attendantA, first.id, '1234')).status).toBe(200);
    const res = await link(attendantA, second.id, '01234');
    expect(res.status).toBe(409);
    expect((res.body as ApiErrorBody).error.details).toMatchObject({
      reason: 'lis_budget_number_taken',
      proposalNumber: first.proposalNumber,
    });
  });

  it('o mesmo numero em outro tenant nao conflita', async () => {
    const adminB = await createUser({ tenantId: tenantB.id, role: 'admin', db });
    const inA = await proposalOf(attendantA);
    const inB = await proposalOf(adminB);
    expect((await link(attendantA, inA.id, '1234')).status).toBe(200);
    expect((await link(adminB, inB.id, '1234')).status).toBe(200);
  });

  it('proposta ganha -> PROPOSAL_ALREADY_CLOSED; perdida aceita o vinculo', async () => {
    const won = await proposalOf(attendantA, 'ganho');
    const res = await link(attendantA, won.id, '1');
    expect(res.status).toBe(409);
    expect((res.body as ApiErrorBody).error.code).toBe('PROPOSAL_ALREADY_CLOSED');

    const lost = await proposalOf(attendantA, 'perdido', { reasonLost: 'preco' });
    expect((await link(attendantA, lost.id, '2')).status).toBe(200);
  });

  it('atendente que nao e dona: NOT_FOUND (nem enxerga); gestor pode', async () => {
    const proposal = await proposalOf(attendantA);
    expect((await link(otherAttendantA, proposal.id, '1')).status).toBe(404);
    expect((await link(managerA, proposal.id, '1')).status).toBe(200);
  });

  it('orcamento ja importado com requisicao: vai a ganho na propria chamada', async () => {
    await ingest(tenantA, [row('1234', PAID)]);
    const proposal = await proposalOf(attendantA, 'novo_contato');

    const res = await link(attendantA, proposal.id, '1234');
    expect(res.status).toBe(200);
    const body = res.body as ProposalDetail;
    expect(body.status).toBe('ganho');
    expect(body.lisReconciledAt).not.toBeNull();
    expect(body.closedAt).not.toBeNull();
    expect(body).toMatchObject({ lisRequisitionNumber: '001-0009876', lisPaidValue: 100, lisPaidOn: '2026-09-22' });

    expect(await budgetLink(tenantA, '1234')).toBe(proposal.id);
    expect(wonEvents(proposal.id)).toHaveLength(1);
    const statusAudit = await auditOf(proposal.id, 'update_proposal_status');
    expect(statusAudit).toHaveLength(1);
    expect(statusAudit[0]).toMatchObject({
      user_id: null,
      old_values: { status: 'novo_contato' },
      new_values: { status: 'ganho', source: 'lis' },
    });
    expect((await historyOf(proposal.id)).at(-1)).toEqual({ status: 'ganho', changed_by: null });
  });

  it('null desfaz o vinculo e limpa o espelho e o proposal_id do orcamento', async () => {
    await ingest(tenantA, [row('1234', { paidValue: 50, paidOn: '2026-09-22' })]);
    const proposal = await proposalOf(attendantA);
    expect(((await link(attendantA, proposal.id, '1234')).body as ProposalDetail).lisPaidValue).toBe(50);
    expect(await budgetLink(tenantA, '1234')).toBe(proposal.id);

    const res = await link(attendantA, proposal.id, null);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ lisBudgetNumber: null, lisPaidValue: null, lisPaidOn: null });
    expect(await budgetLink(tenantA, '1234')).toBeNull();
  });
});

describe('conciliacao pela importacao/sincronizacao (ingestRows)', () => {
  it('requisicao nova leva a ganho, conta em proposalsWon e emite WS depois', async () => {
    const proposal = await proposalOf(attendantA, 'negociacao');
    await link(attendantA, proposal.id, '1234');

    const first = await ingest(tenantA, [row('1234')]);
    expect(first.proposalsWon).toBe(0);
    expect((await detail(attendantA, proposal.id)).status).toBe('negociacao');

    const second = await ingest(tenantA, [row('1234', PAID)]);
    expect(second.proposalsWon).toBe(1);
    const after = await detail(attendantA, proposal.id);
    expect(after.status).toBe('ganho');
    expect(after.lisRequisitionNumber).toBe('001-0009876');
    expect(wonEvents(proposal.id)).toHaveLength(1);
  });

  it('proposta com aprovacao pendente tambem fecha', async () => {
    const proposal = await proposalOf(attendantA, 'novo_contato', { approvalStatus: 'pending' });
    await link(attendantA, proposal.id, '77');
    await ingest(tenantA, [row('77', PAID)]);
    expect((await detail(attendantA, proposal.id)).status).toBe('ganho');
  });

  it('idempotente: rodar 2x nao duplica historico, mensagem, audit nem WS', async () => {
    const proposal = await proposalOf(attendantA);
    await link(attendantA, proposal.id, '1234');
    await ingest(tenantA, [row('1234', PAID)]);
    const again = await ingest(tenantA, [row('1234', PAID)]);

    expect(again.proposalsWon).toBe(0);
    expect((await historyOf(proposal.id)).filter((h) => h.status === 'ganho')).toHaveLength(1);
    expect(await auditOf(proposal.id, 'update_proposal_status')).toHaveLength(1);
    expect(wonEvents(proposal.id)).toHaveLength(1);
    const messages = await db.withoutTenant((tx) =>
      tx.query<{ content: string }>(
        `SELECT content FROM messages WHERE conversation_id = $1 AND content LIKE '%LIS%'`,
        [proposal.conversationId],
      ),
    );
    expect(messages.rows).toHaveLength(1);
  });

  it('perdido nao reabre: grava o espelho e audita o conflito uma vez so', async () => {
    const proposal = await proposalOf(attendantA, 'perdido', { reasonLost: 'preco' });
    await link(attendantA, proposal.id, '1234');
    await ingest(tenantA, [row('1234', PAID)]);
    await ingest(tenantA, [row('1234', PAID)]);

    const after = await detail(attendantA, proposal.id);
    expect(after.status).toBe('perdido');
    expect(after.lisRequisitionNumber).toBe('001-0009876');
    expect(after.lisReconciledAt).toBeNull();
    const conflicts = await auditOf(proposal.id, 'lis_reconcile_conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.new_values).toEqual({ lisBudgetNumber: '1234', lisRequisitionNumber: '001-0009876' });
  });

  it('pagamento sem requisicao grava valor e data, sem mudar o estagio', async () => {
    const proposal = await proposalOf(attendantA);
    await link(attendantA, proposal.id, '1234');
    await ingest(tenantA, [row('1234', { paidValue: 80, paidOn: '2026-09-23' })]);
    const after = await detail(attendantA, proposal.id);
    expect(after).toMatchObject({ status: 'orcamento_enviado', lisPaidValue: 80, lisPaidOn: '2026-09-23' });
  });

  it('orcamento do tenant B com o mesmo numero nao concilia proposta do tenant A', async () => {
    const proposal = await proposalOf(attendantA);
    await link(attendantA, proposal.id, '1234');
    const result = await ingest(tenantB, [row('1234', PAID)]);
    expect(result.proposalsWon).toBe(0);
    expect((await detail(attendantA, proposal.id)).status).toBe('orcamento_enviado');
    expect(await budgetLink(tenantB, '1234')).toBeNull();
  });
});

describe('purge com conciliacao', () => {
  it('bloqueia com CONFLICT lis_budgets_reconciled e nao apaga nada', async () => {
    const proposal = await proposalOf(attendantA);
    await ingest(tenantA, [row('1234'), row('5678')]);
    await link(attendantA, proposal.id, '1234');

    const res = await app.agent
      .post('/api/v1/lis-imports/purge')
      .set(app.auth(adminA))
      .send({ confirm: 'LIMPAR' });
    expect(res.status).toBe(409);
    expect((res.body as ApiErrorBody).error.details).toMatchObject({
      reason: 'lis_budgets_reconciled',
      linkedCount: 1,
    });
    expect(await budgetLink(tenantA, '1234')).toBe(proposal.id);
  });

  it('sem vinculo, o purge continua apagando', async () => {
    await ingest(tenantA, [row('1234')]);
    const res = await app.agent
      .post('/api/v1/lis-imports/purge')
      .set(app.auth(adminA))
      .send({ confirm: 'LIMPAR' });
    expect(res.status).toBe(201);
  });
});

describe('GET /analytics/conversion -> realized', () => {
  it('conta ganhos pelo LIS e pagamentos no periodo; atendente ve so os dela', async () => {
    const mine = await proposalOf(attendantA);
    const other = await proposalOf(otherAttendantA);
    await proposalOf(attendantA, 'ganho'); // ganho manual: nao entra em wonFromLis
    await link(attendantA, mine.id, '1');
    await link(otherAttendantA, other.id, '2');
    const today = new Date().toISOString().slice(0, 10);
    await ingest(tenantA, [
      row('1', { ...PAID, paidValue: 150, paidOn: today }),
      row('2', { paidValue: 40, paidOn: today }),
    ]);

    const range = `?startDate=${today}&endDate=${today}`;
    const asManager = await app.agent.get(`/api/v1/analytics/conversion${range}`).set(app.auth(managerA));
    expect(asManager.status).toBe(200);
    expect((asManager.body as FunnelReport).realized).toEqual({ wonFromLis: 1, paidCount: 2, paidValue: 190 });

    const asAttendant = await app.agent.get(`/api/v1/analytics/conversion${range}`).set(app.auth(attendantA));
    expect((asAttendant.body as FunnelReport).realized).toEqual({ wonFromLis: 1, paidCount: 1, paidValue: 150 });
  });
});
