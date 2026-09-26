/**
 * Proposta que nasce do orcamento do Bitlab (CRMLAB-57, D-195 a D-198).
 *
 * Service real, banco real (PGlite), WS pelo FakeWsHub. A unica coisa
 * substituida e o liga/desliga da regra (`bitlab-origin-gate`), que hoje
 * devolve sempre `true` e sera ligado as Regras do CRMLAB-56.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ApiErrorBody,
  FunnelReport,
  ListProposalsResponse,
  Proposal,
  ProposalDetail,
} from '@crm-lab/shared';
import { analyticsModule } from '../../src/controllers/analytics.routes.js';
import { proposalModule } from '../../src/controllers/proposal.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { saoPauloDateTime } from '../../src/lib/bitlab-client.js';
import { MemoryCache } from '../../src/lib/cache.js';
import type { LisSpreadsheetRow } from '../../src/lib/lis-spreadsheet.js';
import { insertBitlabProposal } from '../../src/repositories/proposal.repository.js';
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

const gate = vi.hoisted(() => ({ enabled: true }));
vi.mock('../../src/services/bitlab-origin-gate.js', () => ({
  isBitlabOriginEnabled: vi.fn(async () => gate.enabled),
}));

const ISSUED = '2026-09-20';
const SINCE = '2026-09-01';

function row(number: string, overrides: Partial<LisSpreadsheetRow> = {}): LisSpreadsheetRow {
  return {
    number,
    issuedOn: ISSUED,
    patientName: `Paciente ${number}`,
    insurance1: 'PARTICULAR',
    value1: 150.5,
    insurance2: null,
    value2: null,
    insurance3: null,
    value3: null,
    attendantName: 'MARIA SOUZA',
    insuranceAverage: 150.5,
    requisitionNumber: null,
    requisitionValue: null,
    paidValue: null,
    paidOn: null,
    ...overrides,
  };
}

let db: DbClient;
let app: TestApp;
let lis: LisImportService;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let managerA: UserRecord;
let attendantA: UserRecord;
let otherAttendantA: UserRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  gate.enabled = true;
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [proposalModule, analyticsModule] });
  lis = createLisImportService({
    db,
    cache: new MemoryCache(),
    audit: createAuditService(db),
    wsHub: app.wsHub,
  });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', db });
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
  otherAttendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
});

async function setSince(tenant: TenantRecord, since: string | null): Promise<void> {
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO tenant_settings (tenant_id, bitlab_proposals_since) VALUES ($1, $2::date)
       ON CONFLICT (tenant_id) DO UPDATE SET bitlab_proposals_since = EXCLUDED.bitlab_proposals_since`,
      [tenant.id, since],
    ),
  );
}

async function sinceOf(tenant: TenantRecord): Promise<string | null> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ since: string | null }>(
      `SELECT to_char(bitlab_proposals_since, 'YYYY-MM-DD') AS since
         FROM tenant_settings WHERE tenant_id = $1`,
      [tenant.id],
    ),
  );
  return result.rows[0]?.since ?? null;
}

async function linkAttendant(tenant: TenantRecord, name: string, user: UserRecord | null) {
  await db.withoutTenant((tx) =>
    tx.query('INSERT INTO attendants (tenant_id, name, user_id) VALUES ($1, $2, $3)', [
      tenant.id,
      name,
      user?.id ?? null,
    ]),
  );
}

async function ingest(tenant: TenantRecord, rows: LisSpreadsheetRow[]) {
  return lis.ingestRows({ tenantId: tenant.id, createdBy: null }, rows, { kind: 'sync' });
}

async function proposalsOf(tenant: TenantRecord) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{
      id: string;
      origin: string;
      status: string;
      lis_budget_number: string | null;
      created_by: string | null;
      conversation_id: string | null;
    }>(
      `SELECT id, origin, status, lis_budget_number, created_by, conversation_id
         FROM proposals WHERE tenant_id = $1 ORDER BY lis_budget_number`,
      [tenant.id],
    ),
  );
  return result.rows;
}

async function list(user: UserRecord, query = ''): Promise<Proposal[]> {
  const res = await app.agent.get(`/api/v1/proposals${query}`).set(app.auth(user));
  expect(res.status).toBe(200);
  return (res.body as ListProposalsResponse).proposals;
}

async function detail(user: UserRecord, id: string): Promise<ProposalDetail> {
  const res = await app.agent.get(`/api/v1/proposals/${id}`).set(app.auth(user));
  expect(res.status).toBe(200);
  return res.body as ProposalDetail;
}

function events(name: string) {
  return app.wsHub.emitted.filter((e) => e.event === name);
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

describe('ingestao cria a proposta de origem bitlab', () => {
  it('orcamento novo vira cartao em "Novo orcamento", sem conversa, com os dados do Bitlab', async () => {
    await setSince(tenantA, SINCE);
    await linkAttendant(tenantA, 'Maria Souza', null);
    const imported = await ingest(tenantA, [row('5001')]);
    expect(imported.proposalsCreated).toBe(1);

    const [created] = await proposalsOf(tenantA);
    expect(created).toMatchObject({
      origin: 'bitlab',
      status: 'novo_contato',
      lis_budget_number: '5001',
      created_by: null,
      conversation_id: null,
    });

    const body = await detail(managerA, created!.id);
    expect(body).toMatchObject({
      origin: 'bitlab',
      conversationId: null,
      patientName: 'Paciente 5001',
      patientPhone: '',
      totalPrice: 150.5,
      discountPercent: 0,
      approvalStatus: 'none',
      insuranceId: null,
      createdBy: null,
      createdByName: '',
      lisBudgetNumber: '5001',
      lisIssuedOn: ISSUED,
      lisAttendantName: 'MARIA SOUZA',
      lisRequisitionNumber: null,
      items: [],
    });
    expect(body.history).toEqual([
      expect.objectContaining({ status: 'novo_contato', changedBy: null }),
    ]);

    const audits = await auditOf(created!.id, 'create_proposal');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.user_id).toBeNull();
    expect(audits[0]?.new_values).toMatchObject({ origin: 'bitlab', lisBudgetNumber: '5001' });

    // WS depois do commit, um por cartao.
    expect(events('proposal.created')).toEqual([
      expect.objectContaining({ tenantId: tenantA.id, data: { proposalId: created!.id } }),
    ]);

    // A conciliacao do mesmo chunk ja gravou o vinculo do lado do orcamento.
    const link = await db.withoutTenant((tx) =>
      tx.query<{ proposal_id: string | null }>(
        'SELECT proposal_id FROM lis_budgets WHERE tenant_id = $1 AND number = $2',
        [tenantA.id, '5001'],
      ),
    );
    expect(link.rows[0]?.proposal_id).toBe(created!.id);
  });

  it('convenio resolvido do orcamento entra na proposta', async () => {
    await setSince(tenantA, SINCE);
    await ingest(tenantA, [row('5002', { insurance1: 'UNIMED', value1: 80 })]);
    const [created] = await proposalsOf(tenantA);
    const body = await detail(managerA, created!.id);
    expect(body.insuranceId).not.toBeNull();
    expect(body.totalPrice).toBe(80);
  });

  it('reimportar / re-sincronizar o mesmo orcamento nao duplica nem reaudita', async () => {
    await setSince(tenantA, SINCE);
    await ingest(tenantA, [row('5003')]);
    const again = await ingest(tenantA, [row('5003')]);
    await ingest(tenantA, [row('5003'), row('5003')]);

    expect(again.proposalsCreated).toBe(0);
    const rows = await proposalsOf(tenantA);
    expect(rows).toHaveLength(1);
    expect(await auditOf(rows[0]!.id, 'create_proposal')).toHaveLength(1);
    expect(events('proposal.created')).toHaveLength(1);
  });

  it('duas ingestoes ao mesmo tempo (planilha x sincronizacao) criam um cartao so', async () => {
    await setSince(tenantA, SINCE);
    await Promise.all([ingest(tenantA, [row('5004')]), ingest(tenantA, [row('5004')])]);
    expect(await proposalsOf(tenantA)).toHaveLength(1);
  });

  it('INSERT concorrente cai no ON CONFLICT DO NOTHING do indice parcial', async () => {
    const first = await db.withTenant(tenantA.id, (tx) =>
      insertBitlabProposal(tx, {
        tenantId: tenantA.id,
        lisBudgetNumber: '5005',
        createdBy: null,
        totalPrice: 10,
        insuranceId: null,
      }),
    );
    const second = await db.withTenant(tenantA.id, (tx) =>
      insertBitlabProposal(tx, {
        tenantId: tenantA.id,
        lisBudgetNumber: '5005',
        createdBy: null,
        totalPrice: 10,
        insuranceId: null,
      }),
    );
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('orcamento com proposta do CRM ja vinculada nao ganha cartao automatico', async () => {
    await setSince(tenantA, SINCE);
    const conversation = await createConversation({ tenantId: tenantA.id, db });
    const manual = await createProposal({
      tenantId: tenantA.id,
      conversationId: conversation.id,
      createdBy: attendantA.id,
      status: 'orcamento_enviado',
      totalPrice: 100,
      db,
    });
    const res = await app.agent
      .patch(`/api/v1/proposals/${manual.id}/lis-reference`)
      .set(app.auth(attendantA))
      .send({ lisBudgetNumber: '5006' });
    expect(res.status).toBe(200);

    await ingest(tenantA, [row('5006')]);
    const rows = await proposalsOf(tenantA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: 'crm', id: manual.id });
  });

  it('valor maior no Bitlab regrava o total do cartao ainda aberto', async () => {
    await setSince(tenantA, SINCE);
    await ingest(tenantA, [row('5007', { value1: 100 })]);
    await ingest(tenantA, [row('5007', { value1: 250 })]);
    const [created] = await proposalsOf(tenantA);
    expect((await detail(managerA, created!.id)).totalPrice).toBe(250);
  });

  it('regra desligada: nada nasce e a marca nao e gravada', async () => {
    gate.enabled = false;
    await ingest(tenantA, [row('5008')]);
    expect(await proposalsOf(tenantA)).toHaveLength(0);
    expect(await sinceOf(tenantA)).toBeNull();
  });

  it('isolamento: orcamento do tenant B nao cria cartao no A', async () => {
    await setSince(tenantA, SINCE);
    await setSince(tenantB, SINCE);
    await ingest(tenantB, [row('5009')]);
    expect(await proposalsOf(tenantA)).toHaveLength(0);
    expect(await proposalsOf(tenantB)).toHaveLength(1);
    expect(await list(managerA)).toHaveLength(0);
  });
});

describe('sem avalanche de historico (D-196 item 2)', () => {
  it('primeira ingestao grava a marca = hoje (Brasilia); orcamento anterior nao vira cartao', async () => {
    const today = saoPauloDateTime(new Date()).slice(0, 10);
    await ingest(tenantA, [row('6001', { issuedOn: '2026-06-01' }), row('6002', { issuedOn: today })]);
    expect(await sinceOf(tenantA)).toBe(today);
    const rows = await proposalsOf(tenantA);
    expect(rows.map((r) => r.lis_budget_number)).toEqual(['6002']);
  });

  it('a marca nunca anda depois de gravada', async () => {
    await setSince(tenantA, SINCE);
    await ingest(tenantA, [row('6003')]);
    await ingest(tenantA, [row('6004')]);
    expect(await sinceOf(tenantA)).toBe(SINCE);
  });

  it('orcamento anterior a marca ou sem data de emissao nao nasce', async () => {
    await setSince(tenantA, SINCE);
    await ingest(tenantA, [
      row('6005', { issuedOn: '2026-08-31' }),
      row('6006', { issuedOn: null }),
      row('6007', { issuedOn: SINCE }),
    ]);
    const rows = await proposalsOf(tenantA);
    expect(rows.map((r) => r.lis_budget_number)).toEqual(['6007']);
  });
});

describe('pre-cadastro e a excecao a D-119 (D-197)', () => {
  const REQ = { requisitionNumber: '001-0001234', requisitionValue: 150.5 };

  it('orcamento que ja chega com requisicao nasce em "Novo orcamento" com o selo, sem virar ganho', async () => {
    await setSince(tenantA, SINCE);
    await ingest(tenantA, [row('7001', REQ)]);
    await ingest(tenantA, [row('7001', REQ)]);

    const [created] = await proposalsOf(tenantA);
    expect(created?.status).toBe('novo_contato');
    const [card] = await list(managerA);
    expect(card).toMatchObject({ status: 'novo_contato', lisRequisitionNumber: '001-0001234', lisReconciledAt: null });
    expect(events('proposal.status_changed')).toHaveLength(0);
  });

  it('requisicao que aparece depois tambem so espelha enquanto o cartao esta em "Novo orcamento"', async () => {
    await setSince(tenantA, SINCE);
    await ingest(tenantA, [row('7002')]);
    await ingest(tenantA, [row('7002', REQ)]);
    const [card] = await list(managerA);
    expect(card).toMatchObject({ status: 'novo_contato', lisRequisitionNumber: '001-0001234' });
  });

  it('cartao bitlab ja enviado segue a D-119: requisicao fecha como ganho', async () => {
    await setSince(tenantA, SINCE);
    await ingest(tenantA, [row('7003')]);
    const [created] = await proposalsOf(tenantA);
    const moved = await app.agent
      .patch(`/api/v1/proposals/${created!.id}/status`)
      .set(app.auth(managerA))
      .send({ status: 'orcamento_enviado' });
    expect(moved.status).toBe(200);

    const imported = await ingest(tenantA, [row('7003', REQ)]);
    expect(imported.proposalsWon).toBe(1);
    const body = await detail(managerA, created!.id);
    expect(body.status).toBe('ganho');
    expect(body.lisReconciledAt).not.toBeNull();
  });

  it('proposta de origem crm em novo_contato continua indo a ganho (D-119 intacta)', async () => {
    await setSince(tenantA, SINCE);
    const conversation = await createConversation({ tenantId: tenantA.id, db });
    const manual = await createProposal({
      tenantId: tenantA.id,
      conversationId: conversation.id,
      createdBy: attendantA.id,
      status: 'novo_contato',
      totalPrice: 100,
      db,
    });
    await app.agent
      .patch(`/api/v1/proposals/${manual.id}/lis-reference`)
      .set(app.auth(attendantA))
      .send({ lisBudgetNumber: '7004' });
    await ingest(tenantA, [row('7004', REQ)]);
    expect((await detail(attendantA, manual.id)).status).toBe('ganho');
  });
});

describe('responsavel e visibilidade (D-195 itens 5 e 6)', () => {
  it('atendente do Bitlab ligada a um login vira a responsavel; so ela (e o gestor) ve', async () => {
    await setSince(tenantA, SINCE);
    await linkAttendant(tenantA, 'Maria Souza', attendantA);
    await ingest(tenantA, [row('8001')]);
    const [created] = await proposalsOf(tenantA);
    expect(created?.created_by).toBe(attendantA.id);

    expect((await list(attendantA)).map((p) => p.id)).toEqual([created!.id]);
    expect(await list(otherAttendantA)).toHaveLength(0);
    const hidden = await app.agent
      .get(`/api/v1/proposals/${created!.id}`)
      .set(app.auth(otherAttendantA));
    expect(hidden.status).toBe(404);
  });

  it('login inativo nao vira responsavel', async () => {
    await setSince(tenantA, SINCE);
    await linkAttendant(tenantA, 'Maria Souza', attendantA);
    await db.withoutTenant((tx) =>
      tx.query('UPDATE users SET is_active = FALSE WHERE id = $1', [attendantA.id]),
    );
    await ingest(tenantA, [row('8002')]);
    const [created] = await proposalsOf(tenantA);
    expect(created?.created_by).toBeNull();
  });

  it('sem responsavel: fila comum — toda atendente do tenant ve; outro tenant nao', async () => {
    await setSince(tenantA, SINCE);
    await ingest(tenantA, [row('8003')]);
    const [created] = await proposalsOf(tenantA);
    expect((await list(attendantA)).map((p) => p.id)).toEqual([created!.id]);
    expect((await list(otherAttendantA)).map((p) => p.id)).toEqual([created!.id]);
    await detail(otherAttendantA, created!.id);

    const attendantB = await createUser({ tenantId: tenantB.id, role: 'attendant', db });
    const res = await app.agent.get(`/api/v1/proposals/${created!.id}`).set(app.auth(attendantB));
    expect(res.status).toBe(404);
  });

  it('busca por nome acha o paciente do orcamento; filtro de paciente nao traz o cartao', async () => {
    await setSince(tenantA, SINCE);
    await ingest(tenantA, [row('8004', { patientName: 'Joana Bitlab' })]);
    expect(await list(managerA, '?search=joana')).toHaveLength(1);
    expect(await list(managerA, '?search=ninguem')).toHaveLength(0);
    expect(
      await list(managerA, '?patientId=00000000-0000-4000-8000-000000000001'),
    ).toHaveLength(0);
  });
});

describe('o que o cartao bitlab faz e nao faz', () => {
  async function card(): Promise<string> {
    await setSince(tenantA, SINCE);
    await ingest(tenantA, [row('9001')]);
    const [created] = await proposalsOf(tenantA);
    return created!.id;
  }

  it('nao edita itens, desconto nem o numero do orcamento', async () => {
    const id = await card();
    const calls = [
      app.agent.patch(`/api/v1/proposals/${id}/discount`).set(app.auth(managerA)).send({ discountPercent: 5 }),
      app.agent
        .patch(`/api/v1/proposals/${id}/items`)
        .set(app.auth(managerA))
        .send({ items: [{ examId: '00000000-0000-4000-8000-000000000001', quantity: 1 }] }),
      app.agent.patch(`/api/v1/proposals/${id}/lis-reference`).set(app.auth(managerA)).send({ lisBudgetNumber: null }),
    ];
    for (const call of calls) {
      const res = await call;
      expect(res.status).toBe(409);
      const error = (res.body as ApiErrorBody).error;
      expect(error.code).toBe('PROPOSAL_EDIT_NOT_ALLOWED');
      expect(error.details).toMatchObject({ reason: 'bitlab_origin' });
    }
  });

  it('atendente move o cartao sem conversa: enviado e depois ganho (balcao), sem mensagem de sistema', async () => {
    const id = await card();
    for (const status of ['orcamento_enviado', 'ganho']) {
      const res = await app.agent
        .patch(`/api/v1/proposals/${id}/status`)
        .set(app.auth(attendantA))
        .send({ status });
      expect(res.status).toBe(200);
    }
    const messages = await db.withoutTenant((tx) =>
      tx.query('SELECT id FROM messages WHERE tenant_id = $1', [tenantA.id]),
    );
    expect(messages.rows).toHaveLength(0);
    expect((await detail(managerA, id)).status).toBe('ganho');
  });

  it('vai direto para perdido com motivo; novo_contato -> ganho continua recusado pela matriz', async () => {
    const id = await card();
    const direct = await app.agent
      .patch(`/api/v1/proposals/${id}/status`)
      .set(app.auth(attendantA))
      .send({ status: 'ganho' });
    expect(direct.status).toBe(400);
    expect((direct.body as ApiErrorBody).error.code).toBe('INVALID_STATUS_TRANSITION');

    const lost = await app.agent
      .patch(`/api/v1/proposals/${id}/status`)
      .set(app.auth(attendantA))
      .send({ status: 'perdido', reasonLost: 'preco' });
    expect(lost.status).toBe(200);
  });

  it('funil, pipeline e ranking aguentam proposta sem responsavel', async () => {
    const id = await card();
    await app.agent.patch(`/api/v1/proposals/${id}/status`).set(app.auth(managerA)).send({ status: 'orcamento_enviado' });
    await app.agent.patch(`/api/v1/proposals/${id}/status`).set(app.auth(managerA)).send({ status: 'ganho' });

    const today = new Date().toISOString().slice(0, 10);
    const conversion = await app.agent
      .get(`/api/v1/analytics/conversion?startDate=${today}&endDate=${today}`)
      .set(app.auth(managerA));
    expect(conversion.status).toBe(200);
    const report = conversion.body as FunnelReport;
    expect(report.funnel.ganho).toBe(1);
    expect(report.topPerformers).toEqual([]);

    const pipeline = await app.agent.get('/api/v1/analytics/pipeline').set(app.auth(managerA));
    expect(pipeline.status).toBe(200);
    const team = await app.agent
      .get(`/api/v1/analytics/team?startDate=${today}&endDate=${today}`)
      .set(app.auth(managerA));
    expect(team.status).toBe(200);
  });
});

describe('numero digitado numa proposta do CRM absorve o cartao automatico (D-198)', () => {
  async function manualProposal(): Promise<string> {
    const conversation = await createConversation({ tenantId: tenantA.id, db });
    const manual = await createProposal({
      tenantId: tenantA.id,
      // Numero fora da faixa que a ingestao ja usou neste teste.
      proposalNumber: 900,
      conversationId: conversation.id,
      createdBy: attendantA.id,
      status: 'orcamento_enviado',
      totalPrice: 100,
      db,
    });
    return manual.id;
  }

  it('cartao em "Novo orcamento" e nunca enviado some e o vinculo passa para a manual', async () => {
    await setSince(tenantA, SINCE);
    await ingest(tenantA, [row('9101')]);
    const [auto] = await proposalsOf(tenantA);
    const manualId = await manualProposal();

    const res = await app.agent
      .patch(`/api/v1/proposals/${manualId}/lis-reference`)
      .set(app.auth(attendantA))
      .send({ lisBudgetNumber: '9101' });
    expect(res.status).toBe(200);
    expect((res.body as ProposalDetail).lisBudgetNumber).toBe('9101');

    const rows = await proposalsOf(tenantA);
    expect(rows.map((r) => r.id)).toEqual([manualId]);
    const absorbed = await auditOf(auto!.id, 'absorb_bitlab_proposal');
    expect(absorbed).toHaveLength(1);
    expect(absorbed[0]?.user_id).toBe(attendantA.id);
    expect(absorbed[0]?.new_values).toEqual({ absorbedBy: manualId });
    expect(
      events('proposal.updated').some((e) => (e.data as { proposalId: string }).proposalId === auto!.id),
    ).toBe(true);

    const link = await db.withoutTenant((tx) =>
      tx.query<{ proposal_id: string | null }>(
        'SELECT proposal_id FROM lis_budgets WHERE tenant_id = $1 AND number = $2',
        [tenantA.id, '9101'],
      ),
    );
    expect(link.rows[0]?.proposal_id).toBe(manualId);

    // Reingerir nao ressuscita o cartao automatico.
    await ingest(tenantA, [row('9101')]);
    expect(await proposalsOf(tenantA)).toHaveLength(1);
  });

  it('cartao que ja saiu de "Novo orcamento" nao e absorvido: CONFLICT', async () => {
    await setSince(tenantA, SINCE);
    await ingest(tenantA, [row('9102')]);
    const [auto] = await proposalsOf(tenantA);
    await app.agent
      .patch(`/api/v1/proposals/${auto!.id}/status`)
      .set(app.auth(managerA))
      .send({ status: 'orcamento_enviado' });
    const manualId = await manualProposal();

    const res = await app.agent
      .patch(`/api/v1/proposals/${manualId}/lis-reference`)
      .set(app.auth(attendantA))
      .send({ lisBudgetNumber: '9102' });
    expect(res.status).toBe(409);
    expect((res.body as ApiErrorBody).error.details).toMatchObject({
      reason: 'lis_budget_number_taken',
    });
    expect(await proposalsOf(tenantA)).toHaveLength(2);
  });
});
