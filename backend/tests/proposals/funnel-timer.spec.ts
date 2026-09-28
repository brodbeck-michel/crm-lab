/**
 * Motor de tempo do funil (CRMLAB-59, D-205..D-209). SERVICES.md §27.
 *
 * Banco real (PGlite), WS pelo FakeWsHub, relogio SEMPRE injetado: a entrada
 * no estagio e gravada com `changed_at` explicito e o motor recebe `now`.
 * Nenhum teste depende da data de hoje, exceto o de "manual zera o prazo",
 * que usa o `updateStatus` real e por isso mede a partir do relogio real.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Shared from '@crm-lab/shared';
import type { ProposalStatus, UpdateFunnelRulesRequest } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { MemoryCache } from '../../src/lib/cache.js';
import { cachePrefix } from '../../src/services/analytics.service.js';
import { createAuditService } from '../../src/services/audit.service.js';
import { createFunnelRulesService } from '../../src/services/funnel-rules.service.js';
import {
  createFunnelTimerService,
  resetFunnelTimerLocksForTest,
  type FunnelTimerService,
} from '../../src/services/funnel-timer.service.js';
import {
  createProposal,
  createTenant,
  createUser,
  type TenantRecord,
  type UserRecord,
} from '../helpers/factories.js';
import { FakeWsHub } from '../helpers/fake-ws.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { buildHarness, ctxOf, systemMessagesOf } from './support.js';

/** Matriz controlavel: prova que o motor respeita a matriz vigente (D-206 item 3). */
const matrix = vi.hoisted(() => ({ drop: null as null | { from: string; to: string } }));
vi.mock('@crm-lab/shared', async (importOriginal) => {
  const original = await importOriginal<typeof Shared>();
  return {
    ...original,
    buildAllowedTransitions: (rules: Parameters<typeof original.buildAllowedTransitions>[0]) => {
      const base = original.buildAllowedTransitions(rules);
      const drop = matrix.drop;
      if (drop === null) return base;
      return {
        ...base,
        [drop.from]: base[drop.from as ProposalStatus].filter((to) => to !== drop.to),
      };
    },
  };
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Segunda-feira 21/09/2026, 10:00 em Brasilia. */
const MONDAY_10H = new Date('2026-09-21T13:00:00.000Z');
/** Quinta-feira 24/09/2026, 10:00 em Brasilia. */
const THURSDAY_10H = new Date('2026-09-24T13:00:00.000Z');

let db: DbClient;
let ws: FakeWsHub;
let cache: MemoryCache;
let clock: Date;
let timer: FunnelTimerService;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let adminA: UserRecord;
let managerA: UserRecord;
let attendantA: UserRecord;
let otherAttendantA: UserRecord;
let adminB: UserRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  resetFunnelTimerLocksForTest();
  matrix.drop = null;
  ws = new FakeWsHub();
  cache = new MemoryCache();
  clock = MONDAY_10H;
  timer = createFunnelTimerService({ db, wsHub: ws, cache, now: () => clock });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  adminA = await createUser({ tenantId: tenantA.id, role: 'admin', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', db });
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
  otherAttendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
  adminB = await createUser({ tenantId: tenantB.id, role: 'admin', db });
});

async function setRules(admin: UserRecord, patch: UpdateFunnelRulesRequest): Promise<void> {
  const service = createFunnelRulesService({ db, audit: createAuditService(db) });
  await service.update(ctxOf({ ...admin, discountLimit: 100 }), patch);
}

interface CardInput {
  tenant?: TenantRecord;
  status: ProposalStatus;
  enteredAt: Date;
  createdBy?: string;
  paidOn?: string | null;
  requisition?: string | null;
  bitlab?: boolean;
}

/** Cartao no estagio `status` desde `enteredAt` (linha de historico explicita). */
async function card(input: CardInput): Promise<string> {
  const tenant = input.tenant ?? tenantA;
  const proposal = await createProposal({
    tenantId: tenant.id,
    status: input.status,
    createdBy: input.createdBy ?? (tenant === tenantA ? attendantA.id : adminB.id),
    totalPrice: 100,
    reasonLost: input.status === 'perdido' ? 'preco' : null,
    db,
  });
  await db.withoutTenant(async (tx) => {
    await tx.query(
      `INSERT INTO proposal_status_history (tenant_id, proposal_id, status, changed_by, changed_at)
       VALUES ($1, $2, 'novo_contato', NULL, $3::timestamp)`,
      [tenant.id, proposal.id, new Date(input.enteredAt.getTime() - DAY).toISOString()],
    );
    if (input.status !== 'novo_contato') {
      await tx.query(
        `INSERT INTO proposal_status_history (tenant_id, proposal_id, status, changed_by, changed_at)
         VALUES ($1, $2, $3, $4, $5::timestamp)`,
        [tenant.id, proposal.id, input.status, proposal.createdBy, input.enteredAt.toISOString()],
      );
    } else {
      await tx.query(
        `UPDATE proposal_status_history SET changed_at = $2::timestamp WHERE proposal_id = $1`,
        [proposal.id, input.enteredAt.toISOString()],
      );
    }
    await tx.query(
      `UPDATE proposals SET lis_paid_on = $2::date, lis_requisition_number = $3 WHERE id = $1`,
      [proposal.id, input.paidOn ?? null, input.requisition ?? null],
    );
    if (input.bitlab) {
      await tx.query(
        `UPDATE proposals SET origin = 'bitlab', conversation_id = NULL, created_by = NULL WHERE id = $1`,
        [proposal.id],
      );
    }
  });
  return proposal.id;
}

async function statusOf(id: string): Promise<{ status: string; reason_lost: string | null; closed_at: unknown }> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ status: string; reason_lost: string | null; closed_at: unknown }>(
      'SELECT status, reason_lost, closed_at FROM proposals WHERE id = $1',
      [id],
    ),
  );
  const row = result.rows[0];
  if (!row) throw new Error('proposta sumiu');
  return row;
}

async function historyOf(id: string): Promise<Array<{ status: string; changed_by: string | null; automation: unknown }>> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ status: string; changed_by: string | null; automation: unknown }>(
      `SELECT status, changed_by, automation FROM proposal_status_history
        WHERE proposal_id = $1 ORDER BY changed_at ASC, id ASC`,
      [id],
    ),
  );
  return result.rows;
}

async function ruleAudits(id: string): Promise<Array<{ user_id: string | null; new_values: unknown }>> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ user_id: string | null; new_values: unknown }>(
      `SELECT user_id, new_values FROM audit_logs
        WHERE entity_id = $1 AND action = 'update_proposal_status' ORDER BY timestamp ASC`,
      [id],
    ),
  );
  return result.rows;
}

function conversationOf(id: string): Promise<string> {
  return db
    .withoutTenant((tx) =>
      tx.query<{ conversation_id: string }>('SELECT conversation_id FROM proposals WHERE id = $1', [id]),
    )
    .then((r) => r.rows[0]?.conversation_id ?? '');
}

describe('Orçamento enviado há X dias → Follow-up (sentToFollowUp)', () => {
  it('X = 3 corridos: não move no dia 2 (nem 1 min antes do prazo) e move no dia 3', async () => {
    const id = await card({ status: 'orcamento_enviado', enteredAt: MONDAY_10H });

    clock = new Date(MONDAY_10H.getTime() + 2 * DAY);
    await timer.runForTenant(tenantA.id);
    clock = new Date(MONDAY_10H.getTime() + 3 * DAY - 60_000);
    await timer.runForTenant(tenantA.id);
    expect((await statusOf(id)).status).toBe('orcamento_enviado');

    clock = new Date(MONDAY_10H.getTime() + 3 * DAY);
    const result = await timer.runForTenant(tenantA.id);
    expect(result).toEqual({ tenantId: tenantA.id, moved: 1, alerted: 0, reengaged: 0 });
    expect((await statusOf(id)).status).toBe('follow_up');
  });

  it('registra como sistema: histórico sem pessoa e com a regra, mensagem, audit source "rule", WS e cache', async () => {
    const id = await card({ status: 'orcamento_enviado', enteredAt: MONDAY_10H });
    await cache.set(`${cachePrefix(tenantA.id)}all:funnel:x`, { stale: true }, 300);
    clock = new Date(MONDAY_10H.getTime() + 3 * DAY);
    await timer.runForTenant(tenantA.id);

    const history = await historyOf(id);
    const last = history[history.length - 1];
    expect(last).toMatchObject({ status: 'follow_up', changed_by: null });
    expect(last?.automation).toEqual({ rule: 'sentToFollowUp', days: 3, dayCounting: 'calendar' });

    const audits = await ruleAudits(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.user_id).toBeNull();
    expect(audits[0]?.new_values).toMatchObject({
      status: 'follow_up',
      source: 'rule',
      rule: 'sentToFollowUp',
      days: 3,
      dayCounting: 'calendar',
    });

    const messages = await systemMessagesOf(db, await conversationOf(id));
    expect(messages.some((m) => m.includes('movida para Follow-up pela regra: enviado há 3 dias'))).toBe(true);

    expect(ws.eventsFor(tenantA.id, 'proposal.status_changed')).toEqual([
      expect.objectContaining({ data: { proposalId: id, status: 'follow_up' } }),
    ]);
    expect(await cache.get(`${cachePrefix(tenantA.id)}all:funnel:x`)).toBeNull();
  });

  it('o detalhe expõe history[].automation e stageEnteredAt', async () => {
    const id = await card({ status: 'orcamento_enviado', enteredAt: MONDAY_10H });
    clock = new Date(MONDAY_10H.getTime() + 3 * DAY);
    await timer.runForTenant(tenantA.id);

    const h = buildHarness(db, ws);
    const detail = await h.proposals.getById(ctxOf({ ...managerA, discountLimit: 30 }), id);
    expect(detail.stageEnteredAt).toBe(clock.toISOString());
    const last = detail.history[detail.history.length - 1];
    expect(last?.automation).toEqual({ rule: 'sentToFollowUp', days: 3, dayCounting: 'calendar' });
    expect(last?.changedBy).toBeNull();
    expect(detail.history[0]?.automation).toBeNull();
  });

  it('dias úteis pulam o fim de semana: entrada quinta 10h com X = 3 vence terça 10h', async () => {
    await setRules(adminA, { automation: { dayCounting: 'business' } });
    const id = await card({ status: 'orcamento_enviado', enteredAt: THURSDAY_10H });

    // Domingo 10h (3 corridos) e segunda 10h (4 corridos, 2 úteis): não move.
    clock = new Date(THURSDAY_10H.getTime() + 3 * DAY);
    await timer.runForTenant(tenantA.id);
    clock = new Date(THURSDAY_10H.getTime() + 4 * DAY);
    await timer.runForTenant(tenantA.id);
    expect((await statusOf(id)).status).toBe('orcamento_enviado');

    clock = new Date(THURSDAY_10H.getTime() + 5 * DAY);
    await timer.runForTenant(tenantA.id);
    expect((await statusOf(id)).status).toBe('follow_up');
    const history = await historyOf(id);
    expect(history[history.length - 1]?.automation).toEqual({
      rule: 'sentToFollowUp',
      days: 3,
      dayCounting: 'business',
    });
  });

  it('regra desligada não move', async () => {
    await setRules(adminA, { automation: { sentToFollowUp: { enabled: false } } });
    const id = await card({ status: 'orcamento_enviado', enteredAt: MONDAY_10H });
    clock = new Date(MONDAY_10H.getTime() + 30 * DAY);
    await timer.runForTenant(tenantA.id);
    expect((await statusOf(id)).status).toBe('orcamento_enviado');
  });

  it('fato vence tempo: pagamento ou requisição impedem', async () => {
    const paid = await card({ status: 'orcamento_enviado', enteredAt: MONDAY_10H, paidOn: '2026-09-22' });
    const requisition = await card({ status: 'orcamento_enviado', enteredAt: MONDAY_10H, requisition: '777' });
    clock = new Date(MONDAY_10H.getTime() + 10 * DAY);
    const result = await timer.runForTenant(tenantA.id);
    expect(result.moved).toBe(0);
    expect((await statusOf(paid)).status).toBe('orcamento_enviado');
    expect((await statusOf(requisition)).status).toBe('orcamento_enviado');
  });

  it('matriz vigente sem o passo impede (e não grava nada)', async () => {
    matrix.drop = { from: 'orcamento_enviado', to: 'follow_up' };
    const id = await card({ status: 'orcamento_enviado', enteredAt: MONDAY_10H });
    clock = new Date(MONDAY_10H.getTime() + 10 * DAY);
    await timer.runForTenant(tenantA.id);
    expect((await statusOf(id)).status).toBe('orcamento_enviado');
    expect(await ruleAudits(id)).toHaveLength(0);
  });

  it('idempotente: dois tiques seguidos fazem uma transição só', async () => {
    const id = await card({ status: 'orcamento_enviado', enteredAt: MONDAY_10H });
    clock = new Date(MONDAY_10H.getTime() + 3 * DAY);
    await timer.runTick();
    await timer.runTick();
    expect((await historyOf(id)).filter((h) => h.status === 'follow_up')).toHaveLength(1);
    expect(await ruleAudits(id)).toHaveLength(1);
    expect(ws.eventsFor(tenantA.id, 'proposal.status_changed')).toHaveLength(1);
  });
});

describe('manual zera o prazo', () => {
  it('cartão que voltou para o estágio conta de novo a partir da volta', async () => {
    // Relogio real: o `updateStatus` grava o historico com NOW().
    const real = new Date();
    const id = await card({
      status: 'orcamento_enviado',
      enteredAt: new Date(real.getTime() - 10 * DAY),
    });
    const h = buildHarness(db, ws);
    const ctx = ctxOf({ ...attendantA, discountLimit: 10 });
    await h.proposals.updateStatus(ctx, id, 'novo_contato');
    await h.proposals.updateStatus(ctx, id, 'orcamento_enviado');

    clock = new Date(Date.now() + 2 * DAY);
    await timer.runForTenant(tenantA.id);
    expect((await statusOf(id)).status).toBe('orcamento_enviado');

    clock = new Date(Date.now() + 3 * DAY + HOUR);
    await timer.runForTenant(tenantA.id);
    expect((await statusOf(id)).status).toBe('follow_up');
  });
});

describe('Negociação há Y dias sem pagamento → Follow-up', () => {
  it('Y = 7: move no dia 7; requisição sem pagamento anda; pagamento impede', async () => {
    const plain = await card({ status: 'negociacao', enteredAt: MONDAY_10H });
    const withRequisition = await card({ status: 'negociacao', enteredAt: MONDAY_10H, requisition: '555' });
    const paid = await card({ status: 'negociacao', enteredAt: MONDAY_10H, requisition: '556', paidOn: '2026-09-25' });

    clock = new Date(MONDAY_10H.getTime() + 6 * DAY);
    await timer.runForTenant(tenantA.id);
    expect((await statusOf(plain)).status).toBe('negociacao');

    clock = new Date(MONDAY_10H.getTime() + 7 * DAY);
    await timer.runForTenant(tenantA.id);
    expect((await statusOf(plain)).status).toBe('follow_up');
    expect((await statusOf(withRequisition)).status).toBe('follow_up');
    expect((await statusOf(paid)).status).toBe('negociacao');
  });

  it('prazo encurtado (7 → 3) vale no próximo tique para quem já passou do novo', async () => {
    const id = await card({ status: 'negociacao', enteredAt: MONDAY_10H });
    clock = new Date(MONDAY_10H.getTime() + 4 * DAY);
    await timer.runForTenant(tenantA.id);
    expect((await statusOf(id)).status).toBe('negociacao');

    await setRules(adminA, { automation: { negotiationToFollowUp: { days: 3 } } });
    await timer.runForTenant(tenantA.id);
    expect((await statusOf(id)).status).toBe('follow_up');
    const history = await historyOf(id);
    expect(history[history.length - 1]?.automation).toMatchObject({ rule: 'negotiationToFollowUp', days: 3 });
  });
});

describe('Follow-up há Z dias → Perdido (Silêncio)', () => {
  it('desligada por padrão: não perde ninguém', async () => {
    const id = await card({ status: 'follow_up', enteredAt: MONDAY_10H });
    clock = new Date(MONDAY_10H.getTime() + 60 * DAY);
    await timer.runForTenant(tenantA.id);
    expect((await statusOf(id)).status).toBe('follow_up');
  });

  it('ligada: perdido com motivo "silencio" e closed_at; requisição impede', async () => {
    await setRules(adminA, { automation: { followUpToLost: { enabled: true, days: 15 } } });
    const id = await card({ status: 'follow_up', enteredAt: MONDAY_10H });
    const requisition = await card({ status: 'follow_up', enteredAt: MONDAY_10H, requisition: '9' });
    clock = new Date(MONDAY_10H.getTime() + 15 * DAY);
    await timer.runForTenant(tenantA.id);
    const row = await statusOf(id);
    expect(row.status).toBe('perdido');
    expect(row.reason_lost).toBe('silencio');
    expect(row.closed_at).not.toBeNull();
    expect((await ruleAudits(id))[0]?.new_values).toMatchObject({ reasonLost: 'silencio', source: 'rule' });
    expect((await statusOf(requisition)).status).toBe('follow_up');
  });

  it('um tique só dá um passo: enviado há 30 dias vai para follow-up, não direto para perdido', async () => {
    await setRules(adminA, { automation: { followUpToLost: { enabled: true, days: 1 } } });
    const id = await card({ status: 'orcamento_enviado', enteredAt: MONDAY_10H });
    clock = new Date(MONDAY_10H.getTime() + 30 * DAY);
    await timer.runForTenant(tenantA.id);
    expect((await statusOf(id)).status).toBe('follow_up');
  });
});

describe('terminais', () => {
  it('ganho e perdido nunca se movem, nem com "Reabrir" ligado', async () => {
    await setRules(adminA, {
      automation: { followUpToLost: { enabled: true, days: 1 } },
      manualMoves: { reopenClosed: { enabled: true, roles: ['manager'] } },
    });
    const won = await card({ status: 'ganho', enteredAt: MONDAY_10H });
    const lost = await card({ status: 'perdido', enteredAt: MONDAY_10H });
    clock = new Date(MONDAY_10H.getTime() + 90 * DAY);
    const result = await timer.runForTenant(tenantA.id);
    expect(result).toEqual({ tenantId: tenantA.id, moved: 0, alerted: 0, reengaged: 0 });
    expect((await statusOf(won)).status).toBe('ganho');
    expect((await statusOf(lost)).status).toBe('perdido');
  });
});

describe('alerta de "Novo orçamento" parado (D-207)', () => {
  it('sai uma vez só por entrada, para a responsável, sem mover o cartão', async () => {
    const id = await card({ status: 'novo_contato', enteredAt: MONDAY_10H, createdBy: attendantA.id });

    clock = new Date(MONDAY_10H.getTime() + 3 * HOUR);
    expect((await timer.runForTenant(tenantA.id)).alerted).toBe(0);

    clock = new Date(MONDAY_10H.getTime() + 5 * HOUR);
    expect((await timer.runForTenant(tenantA.id)).alerted).toBe(1);
    clock = new Date(MONDAY_10H.getTime() + 9 * HOUR);
    expect((await timer.runForTenant(tenantA.id)).alerted).toBe(0);

    expect((await statusOf(id)).status).toBe('novo_contato');
    const alerts = ws.eventsFor(tenantA.id, 'proposal.stale_alert');
    expect(alerts).toEqual([
      expect.objectContaining({ userId: attendantA.id, data: { proposalId: id, hours: 5 } }),
    ]);
  });

  it('sair e voltar para a coluna permite um alerta novo', async () => {
    const id = await card({ status: 'novo_contato', enteredAt: MONDAY_10H, createdBy: attendantA.id });
    clock = new Date(MONDAY_10H.getTime() + 5 * HOUR);
    await timer.runForTenant(tenantA.id);

    const back = new Date(MONDAY_10H.getTime() + 6 * HOUR);
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO proposal_status_history (tenant_id, proposal_id, status, changed_by, changed_at)
         VALUES ($1, $2, 'novo_contato', $3, $4::timestamp)`,
        [tenantA.id, id, attendantA.id, back.toISOString()],
      ),
    );
    clock = new Date(back.getTime() + 4 * HOUR);
    expect((await timer.runForTenant(tenantA.id)).alerted).toBe(1);
    expect(ws.eventsFor(tenantA.id, 'proposal.stale_alert')).toHaveLength(2);
  });

  it('cartão sem responsável alerta gestores e admins ativos, não atendentes', async () => {
    const inactiveManager = await createUser({ tenantId: tenantA.id, role: 'manager', isActive: false, db });
    const id = await card({ status: 'novo_contato', enteredAt: MONDAY_10H, bitlab: true });
    clock = new Date(MONDAY_10H.getTime() + 4 * HOUR);
    await timer.runForTenant(tenantA.id);

    const recipients = ws.eventsFor(tenantA.id, 'proposal.stale_alert').map((e) => e.userId).sort();
    expect(recipients).toEqual([adminA.id, managerA.id].sort());
    expect(recipients).not.toContain(inactiveManager.id);
    expect(recipients).not.toContain(otherAttendantA.id);
    expect(ws.eventsFor(tenantA.id, 'proposal.stale_alert')[0]?.data).toEqual({ proposalId: id, hours: 4 });
  });

  it('desligado ou com pagamento não alerta', async () => {
    await card({ status: 'novo_contato', enteredAt: MONDAY_10H, paidOn: '2026-09-21' });
    clock = new Date(MONDAY_10H.getTime() + 10 * HOUR);
    expect((await timer.runForTenant(tenantA.id)).alerted).toBe(0);

    await setRules(adminA, { automation: { staleNewBudgetAlert: { enabled: false } } });
    await card({ status: 'novo_contato', enteredAt: MONDAY_10H });
    expect((await timer.runForTenant(tenantA.id)).alerted).toBe(0);
    expect(ws.eventsFor(tenantA.id, 'proposal.stale_alert')).toHaveLength(0);
  });
});

describe('agendador', () => {
  it('isolamento: cada laboratório com as próprias regras, eventos só no próprio tenant', async () => {
    await setRules(adminB, { automation: { sentToFollowUp: { enabled: false } } });
    const a = await card({ status: 'orcamento_enviado', enteredAt: MONDAY_10H });
    const b = await card({ tenant: tenantB, status: 'orcamento_enviado', enteredAt: MONDAY_10H });
    clock = new Date(MONDAY_10H.getTime() + 5 * DAY);

    const tick = await timer.runTick();
    expect(tick.skipped).toBe(false);
    expect(tick.tenants.map((t) => t.tenantId).sort()).toEqual([tenantA.id, tenantB.id].sort());
    expect((await statusOf(a)).status).toBe('follow_up');
    expect((await statusOf(b)).status).toBe('orcamento_enviado');
    expect(ws.eventsFor(tenantB.id)).toHaveLength(0);
  });

  it('tenant inativo não entra no tique', async () => {
    await db.withoutTenant((tx) => tx.query('UPDATE tenants SET is_active = FALSE WHERE id = $1', [tenantB.id]));
    await card({ tenant: tenantB, status: 'orcamento_enviado', enteredAt: MONDAY_10H });
    clock = new Date(MONDAY_10H.getTime() + 5 * DAY);
    const tick = await timer.runTick();
    expect(tick.tenants.map((t) => t.tenantId)).not.toContain(tenantB.id);
  });

  it('trava contra execução dupla: tique sobreposto é ignorado', async () => {
    const id = await card({ status: 'orcamento_enviado', enteredAt: MONDAY_10H });
    clock = new Date(MONDAY_10H.getTime() + 5 * DAY);
    const [first, second] = await Promise.all([timer.runTick(), timer.runTick()]);
    expect(first.skipped).toBe(false);
    expect(second.skipped).toBe(true);
    expect((await historyOf(id)).filter((h) => h.status === 'follow_up')).toHaveLength(1);
    // Depois de terminar, a trava solta.
    expect((await timer.runTick()).skipped).toBe(false);
  });
});
