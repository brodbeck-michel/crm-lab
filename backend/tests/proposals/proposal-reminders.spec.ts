/**
 * Lembrete de proposta parada (CRMLAB-102, D-272). SERVICES.md §34.
 *
 * Banco real (PGlite), WS pelo FakeWsHub. O motor recebe o relogio injetado
 * (`clock`); a "criacao ha N dias" e gravada direto em `proposals.created_at`.
 * O service de lembrete usa o relogio real — as datas de agenda partem de
 * `saoPauloToday(new Date())`.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addDaysToIsoDate,
  saoPauloToday,
  type ProposalStatus,
  type UpdateFunnelRulesRequest,
} from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { MemoryCache } from '../../src/lib/cache.js';
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
import { auditActionsFor, buildHarness, ctxOf, type Harness } from './support.js';

const DAY = 24 * 60 * 60 * 1000;

let db: DbClient;
let ws: FakeWsHub;
let h: Harness;
let clock: Date;
let timer: FunnelTimerService;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let adminA: UserRecord;
let managerA: UserRecord;
let attendantA: UserRecord;
let otherAttendantA: UserRecord;
let adminB: UserRecord;

const ctx = (user: UserRecord) => ctxOf({ ...user, discountLimit: 100 });
const today = () => saoPauloToday(new Date());

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  resetFunnelTimerLocksForTest();
  ws = new FakeWsHub();
  h = buildHarness(db, ws);
  clock = new Date();
  timer = createFunnelTimerService({ db, wsHub: ws, cache: new MemoryCache(), now: () => clock });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  adminA = await createUser({ tenantId: tenantA.id, role: 'admin', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', db });
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
  otherAttendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
  adminB = await createUser({ tenantId: tenantB.id, role: 'admin', db });
});

async function setRules(patch: UpdateFunnelRulesRequest): Promise<void> {
  const service = createFunnelRulesService({ db, audit: createAuditService(db) });
  await service.update(ctx(adminA), patch);
}

/** Proposta do tenant A criada ha `ageDays` dias (relativo a `clock`). */
async function proposal(
  status: ProposalStatus,
  ageDays = 0,
  createdBy: string = attendantA.id,
): Promise<string> {
  const p = await createProposal({
    tenantId: tenantA.id,
    status,
    createdBy,
    totalPrice: 100,
    reasonLost: status === 'perdido' ? 'preco' : null,
    db,
  });
  await db.withoutTenant((tx) =>
    tx.query('UPDATE proposals SET created_at = $2::timestamp WHERE id = $1', [
      p.id,
      new Date(clock.getTime() - ageDays * DAY).toISOString(),
    ]),
  );
  return p.id;
}

interface ReminderRowT {
  id: string;
  origin: string;
  due_date: string;
  note: string | null;
  outcome: string | null;
  outcome_note: string | null;
  resolved_by: string | null;
  resolved_at: unknown;
}

async function remindersOf(proposalId: string): Promise<ReminderRowT[]> {
  const result = await db.withoutTenant((tx) =>
    tx.query<ReminderRowT>(
      `SELECT id, origin, to_char(due_date, 'YYYY-MM-DD') AS due_date, note, outcome,
              outcome_note, resolved_by, resolved_at
         FROM proposal_reminders WHERE proposal_id = $1 ORDER BY created_at, id`,
      [proposalId],
    ),
  );
  return result.rows;
}

async function statusOf(proposalId: string): Promise<string> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ status: string }>('SELECT status FROM proposals WHERE id = $1', [proposalId]),
  );
  return result.rows[0]?.status ?? '';
}

describe('lembrete automatico (motor de tempo)', () => {
  it('padrao desligado: nenhuma proposta antiga ganha lembrete', async () => {
    const id = await proposal('follow_up', 40);
    const result = await timer.runForTenant(tenantA.id);
    expect(result.remindersCreated).toBe(0);
    expect(await remindersOf(id)).toHaveLength(0);
  });

  it('nasce uma vez aos N dias desde a criacao, vencido, e avisa a responsavel uma vez', async () => {
    await setRules({ automation: { staleProposalReminder: { enabled: true, days: 15 } } });
    const old = await proposal('follow_up', 16);
    const young = await proposal('orcamento_enviado', 10);

    const first = await timer.runForTenant(tenantA.id);
    expect(first.remindersCreated).toBe(1);
    expect(first.reminded).toBe(1);
    const rows = await remindersOf(old);
    expect(rows).toEqual([
      expect.objectContaining({ origin: 'auto', due_date: saoPauloToday(clock), outcome: null }),
    ]);
    expect(await remindersOf(young)).toHaveLength(0);
    expect(ws.eventsFor(tenantA.id, 'proposal.reminder_due')).toEqual([
      expect.objectContaining({
        userId: attendantA.id,
        data: { proposalId: old, reminderId: rows[0]?.id, dueDate: saoPauloToday(clock) },
      }),
    ]);
    expect(await auditActionsFor(db, old)).toContain('create_proposal_reminder');

    // Segundo tique: nem lembrete novo, nem aviso de novo.
    const second = await timer.runForTenant(tenantA.id);
    expect(second).toMatchObject({ remindersCreated: 0, reminded: 0 });
    expect(ws.eventsFor(tenantA.id, 'proposal.reminder_due')).toHaveLength(1);
  });

  it('nao nasce para proposta fechada nem quando ja ha lembrete manual aberto', async () => {
    await setRules({ automation: { staleProposalReminder: { enabled: true, days: 15 } } });
    const won = await proposal('ganho', 30);
    const lost = await proposal('perdido', 30);
    const withManual = await proposal('follow_up', 30);
    await h.reminders.schedule(ctx(attendantA), withManual, {
      dueDate: addDaysToIsoDate(today(), 3),
    });

    const result = await timer.runForTenant(tenantA.id);
    expect(result.remindersCreated).toBe(0);
    expect(await remindersOf(won)).toHaveLength(0);
    expect(await remindersOf(lost)).toHaveLength(0);
    expect(await remindersOf(withManual)).toEqual([expect.objectContaining({ origin: 'manual' })]);
  });

  it('uma vez por proposta: fechada e reaberta, o automatico nao volta', async () => {
    await setRules({ automation: { staleProposalReminder: { enabled: true, days: 15 } } });
    const id = await proposal('orcamento_enviado', 20);
    await timer.runForTenant(tenantA.id);
    await h.proposals.updateStatus(ctx(attendantA), id, 'ganho');
    await db.withoutTenant((tx) =>
      tx.query(`UPDATE proposals SET status = 'follow_up', closed_at = NULL WHERE id = $1`, [id]),
    );
    const again = await timer.runForTenant(tenantA.id);
    expect(again.remindersCreated).toBe(0);
    expect((await remindersOf(id)).map((r) => r.outcome)).toEqual(['auto_closed']);
  });

  it('respeita dias uteis da contagem das Regras', async () => {
    // Sexta 09/10/2026 10:00 (Brasilia) + 1 dia util = segunda 12/10 10:00.
    clock = new Date('2026-10-11T13:00:00.000Z'); // domingo
    await setRules({
      automation: { staleProposalReminder: { enabled: true, days: 1 }, dayCounting: 'business' },
    });
    const id = await proposal('follow_up', 0);
    await db.withoutTenant((tx) =>
      tx.query(`UPDATE proposals SET created_at = '2026-10-09T13:00:00.000Z' WHERE id = $1`, [id]),
    );
    expect((await timer.runForTenant(tenantA.id)).remindersCreated).toBe(0);
    clock = new Date('2026-10-12T13:00:00.000Z');
    expect((await timer.runForTenant(tenantA.id)).remindersCreated).toBe(1);
  });

  it('lembrete manual vence e avisa mesmo com a regra desligada; futuro nao avisa', async () => {
    const due = await proposal('follow_up');
    const future = await proposal('follow_up');
    await h.reminders.schedule(ctx(attendantA), due, { dueDate: today() });
    await h.reminders.schedule(ctx(attendantA), future, { dueDate: addDaysToIsoDate(today(), 2) });
    const result = await timer.runForTenant(tenantA.id);
    expect(result.reminded).toBe(1);
    expect(ws.eventsFor(tenantA.id, 'proposal.reminder_due')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ proposalId: due }) }),
    ]);
  });

  it('cartao sem responsavel ativo avisa gestores e admins ativos', async () => {
    const id = await proposal('follow_up', 0, otherAttendantA.id);
    await h.reminders.schedule(ctx(managerA), id, { dueDate: today() });
    await db.withoutTenant((tx) =>
      tx.query('UPDATE users SET is_active = FALSE WHERE id = $1', [otherAttendantA.id]),
    );
    await timer.runForTenant(tenantA.id);
    const recipients = ws
      .eventsFor(tenantA.id, 'proposal.reminder_due')
      .map((e) => e.userId)
      .sort();
    expect(recipients).toEqual([adminA.id, managerA.id].sort());
  });
});

describe('agendar lembrete (manual)', () => {
  it('cria e, com um aberto, reagenda o mesmo (um aberto por proposta)', async () => {
    const id = await proposal('follow_up');
    const first = await h.reminders.schedule(ctx(attendantA), id, {
      dueDate: addDaysToIsoDate(today(), 5),
      note: '  ligar dia 25  ',
    });
    expect(first.reminder).toMatchObject({
      origin: 'manual',
      dueDate: addDaysToIsoDate(today(), 5),
      note: 'ligar dia 25',
      createdBy: attendantA.id,
    });
    const second = await h.reminders.schedule(ctx(attendantA), id, { dueDate: today(), note: null });
    expect(second.reminder?.id).toBe(first.reminder?.id);
    expect(second.reminder).toMatchObject({ dueDate: today(), note: null });
    expect(second.reminders).toHaveLength(1);
    expect(await auditActionsFor(db, id)).toEqual([
      'create_proposal_reminder',
      'update_proposal_reminder',
    ]);
    expect(ws.eventsFor(tenantA.id, 'proposal.updated')).toHaveLength(2);
  });

  it('valida o dia e a observacao', async () => {
    const id = await proposal('follow_up');
    await expect(
      h.reminders.schedule(ctx(attendantA), id, { dueDate: addDaysToIsoDate(today(), -1) }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { fields: { dueDate: expect.any(String) } } });
    await expect(
      h.reminders.schedule(ctx(attendantA), id, { dueDate: '2026-02-30' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      h.reminders.schedule(ctx(attendantA), id, { dueDate: addDaysToIsoDate(today(), 400) }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      h.reminders.schedule(ctx(attendantA), id, { dueDate: today(), note: 'x'.repeat(501) }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { fields: { note: expect.any(String) } } });
    expect(await remindersOf(id)).toHaveLength(0);
  });

  it('proposta fechada recusa', async () => {
    const id = await proposal('ganho');
    await expect(
      h.reminders.schedule(ctx(adminA), id, { dueDate: today() }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_ALREADY_CLOSED' });
  });

  it('permissao: outra atendente e outro tenant -> NOT_FOUND; gestor e admin podem', async () => {
    const id = await proposal('follow_up');
    await expect(
      h.reminders.schedule(ctx(otherAttendantA), id, { dueDate: today() }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      h.reminders.schedule(ctx(adminB), id, { dueDate: today() }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      h.reminders.resolve(ctx(adminB), id, { outcome: 'won' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await h.reminders.schedule(ctx(managerA), id, { dueDate: today() });
    const detail = await h.reminders.schedule(ctx(adminA), id, { dueDate: today(), note: 'admin' });
    expect(detail.reminder?.note).toBe('admin');
  });
});

describe('desfecho', () => {
  async function withReminder(status: ProposalStatus): Promise<string> {
    const id = await proposal(status);
    await h.reminders.schedule(ctx(attendantA), id, { dueDate: today() });
    return id;
  }

  it('sem lembrete aberto -> CONFLICT no_open_reminder', async () => {
    const id = await proposal('follow_up');
    await expect(
      h.reminders.resolve(ctx(attendantA), id, { outcome: 'won' }),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'no_open_reminder' } });
  });

  it('Ganho: fluxo normal de estagio, lembrete fecha como won por quem resolveu', async () => {
    const id = await withReminder('negociacao');
    const detail = await h.reminders.resolve(ctx(attendantA), id, { outcome: 'won' });
    expect(detail.status).toBe('ganho');
    expect(detail.reminder).toBeNull();
    expect(detail.reminders).toEqual([
      expect.objectContaining({ outcome: 'won', resolvedBy: attendantA.id }),
    ]);
    const actions = await auditActionsFor(db, id);
    expect(actions).toContain('update_proposal_status');
    expect(actions).toContain('resolve_proposal_reminder');
    expect(ws.eventsFor(tenantA.id, 'proposal.status_changed')).toHaveLength(1);
  });

  it('Ganho respeita a matriz: de novo_contato e recusado e o lembrete fica aberto', async () => {
    const id = await withReminder('novo_contato');
    await expect(
      h.reminders.resolve(ctx(attendantA), id, { outcome: 'won' }),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });
    expect(await statusOf(id)).toBe('novo_contato');
    expect((await remindersOf(id))[0]?.outcome).toBeNull();
  });

  it('Ganho respeita a trava "gestor move card de outra atendente"', async () => {
    await setRules({ manualMoves: { moveOthersCards: false } });
    const id = await withReminder('negociacao');
    await expect(
      h.reminders.resolve(ctx(managerA), id, { outcome: 'won' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await remindersOf(id))[0]?.outcome).toBeNull();
  });

  it('Perdido exige motivo (regra ligada) e grava lost com o motivo', async () => {
    const id = await withReminder('follow_up');
    await expect(
      h.reminders.resolve(ctx(attendantA), id, { outcome: 'lost' }),
    ).rejects.toMatchObject({ code: 'LOSS_REASON_REQUIRED' });
    expect((await remindersOf(id))[0]?.outcome).toBeNull();

    const detail = await h.reminders.resolve(ctx(attendantA), id, {
      outcome: 'lost',
      reasonLost: 'preco',
    });
    expect(detail).toMatchObject({ status: 'perdido', reasonLost: 'preco', reminder: null });
    expect((await remindersOf(id))[0]).toMatchObject({ outcome: 'lost', resolved_by: attendantA.id });
  });

  it('Perdido sem motivo passa com "Exigir motivo" desligado', async () => {
    await setRules({ manualMoves: { requireLossReason: false } });
    const id = await withReminder('follow_up');
    const detail = await h.reminders.resolve(ctx(attendantA), id, { outcome: 'lost' });
    expect(detail.status).toBe('perdido');
  });

  it('Reagendar: so a data futura e obrigatoria; fecha o atual e abre outro', async () => {
    const id = await withReminder('follow_up');
    await expect(
      h.reminders.resolve(ctx(attendantA), id, { outcome: 'rescheduled', dueDate: today(), note: 'x' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { fields: { dueDate: expect.any(String) } } });
    await expect(
      h.reminders.resolve(ctx(attendantA), id, {
        outcome: 'rescheduled',
        dueDate: addDaysToIsoDate(today(), 7),
        note: 'x'.repeat(501),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { fields: { note: expect.any(String) } } });

    const next = addDaysToIsoDate(today(), 7);
    const detail = await h.reminders.resolve(ctx(attendantA), id, {
      outcome: 'rescheduled',
      dueDate: next,
      note: 'pediu retorno semana que vem',
    });
    expect(detail.status).toBe('follow_up');
    expect(detail.reminder).toMatchObject({ dueDate: next, note: 'pediu retorno semana que vem' });
    const rows = await remindersOf(id);
    expect(rows.map((r) => r.outcome)).toEqual(['rescheduled', null]);
    expect(rows[0]).toMatchObject({
      outcome_note: 'pediu retorno semana que vem',
      resolved_by: attendantA.id,
    });
    expect(await auditActionsFor(db, id)).toEqual([
      'create_proposal_reminder',
      'resolve_proposal_reminder',
      'create_proposal_reminder',
    ]);
  });
});

describe('encerramento automatico quando a proposta fecha por outro caminho', () => {
  it('outra pessoa marca Ganho pelo estagio -> auto_closed sem autor', async () => {
    const id = await proposal('negociacao');
    await h.reminders.schedule(ctx(attendantA), id, { dueDate: today() });
    await h.proposals.updateStatus(ctx(managerA), id, 'ganho');
    expect((await remindersOf(id))[0]).toMatchObject({ outcome: 'auto_closed', resolved_by: null });
    expect(await auditActionsFor(db, id)).toContain('resolve_proposal_reminder');
  });

  it('perda automatica do motor (follow-up -> perdido) -> auto_closed', async () => {
    await setRules({ automation: { followUpToLost: { enabled: true, days: 15 } } });
    const id = await proposal('follow_up');
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO proposal_status_history (tenant_id, proposal_id, status, changed_at)
         VALUES ($1, $2, 'follow_up', $3::timestamp)`,
        [tenantA.id, id, new Date(clock.getTime() - 16 * DAY).toISOString()],
      ),
    );
    await h.reminders.schedule(ctx(attendantA), id, { dueDate: addDaysToIsoDate(today(), 3) });
    const result = await timer.runForTenant(tenantA.id);
    expect(result.moved).toBe(1);
    expect(await statusOf(id)).toBe('perdido');
    expect((await remindersOf(id))[0]?.outcome).toBe('auto_closed');
  });
});

describe('listagem', () => {
  it('traz o lembrete aberto e filtra por ?reminder=due|open', async () => {
    const due = await proposal('follow_up');
    const future = await proposal('follow_up');
    const none = await proposal('follow_up');
    await h.reminders.schedule(ctx(attendantA), due, { dueDate: today() });
    await h.reminders.schedule(ctx(attendantA), future, { dueDate: addDaysToIsoDate(today(), 4) });

    const all = await h.proposals.list(ctx(adminA), {});
    const byId = new Map(all.proposals.map((p) => [p.id, p]));
    expect(byId.get(due)?.reminder?.dueDate).toBe(today());
    expect(byId.get(none)?.reminder).toBeNull();

    const dueList = await h.proposals.list(ctx(adminA), { reminder: 'due' });
    expect(dueList.proposals.map((p) => p.id)).toEqual([due]);
    expect(dueList.pagination.total).toBe(1);
    const openList = await h.proposals.list(ctx(adminA), { reminder: 'open' });
    expect(openList.proposals.map((p) => p.id).sort()).toEqual([due, future].sort());
  });
});

describe('Regras: lembrete x perda por silencio', () => {
  const service = () => createFunnelRulesService({ db, audit: createAuditService(db) });

  it('com as duas ligadas, lembrete precisa de menos dias que a perda', async () => {
    await expect(
      service().update(ctx(adminA), {
        automation: {
          staleProposalReminder: { enabled: true, days: 15 },
          followUpToLost: { enabled: true, days: 15 },
        },
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { fields: { 'automation.staleProposalReminder.days': expect.any(String) } },
    });
    const saved = await service().update(ctx(adminA), {
      automation: {
        staleProposalReminder: { enabled: true, days: 10 },
        followUpToLost: { enabled: true, days: 15 },
      },
    });
    expect(saved.automation.staleProposalReminder).toEqual({ enabled: true, days: 10 });
  });

  it('com a perda desligada, qualquer prazo vale; padrao e desligado/15', async () => {
    const before = await service().get(ctx(adminA));
    expect(before.automation.staleProposalReminder).toEqual({ enabled: false, days: 15 });
    const saved = await service().update(ctx(adminA), {
      automation: { staleProposalReminder: { enabled: true, days: 30 } },
    });
    expect(saved.automation.staleProposalReminder.days).toBe(30);
  });
});

describe('reagendar sem observacao', () => {
  it('observacao e opcional: fecha como rescheduled sem nota e abre o novo sem nota', async () => {
    const id = await proposal('follow_up');
    await h.reminders.schedule(ctx(attendantA), id, { dueDate: today(), note: 'antiga' });
    const next = addDaysToIsoDate(today(), 3);
    const detail = await h.reminders.resolve(ctx(attendantA), id, {
      outcome: 'rescheduled',
      dueDate: next,
      note: '   ',
    });
    expect(detail.reminder).toMatchObject({ dueDate: next, note: null });
    const rows = await remindersOf(id);
    expect(rows[0]).toMatchObject({ outcome: 'rescheduled', outcome_note: null });
    const semNota = await h.reminders.resolve(ctx(attendantA), id, {
      outcome: 'rescheduled',
      dueDate: addDaysToIsoDate(today(), 4),
    });
    expect(semNota.reminder?.note).toBeNull();
  });

  it('mensagem da validacao diz o teto de dias', async () => {
    const service = createFunnelRulesService({ db, audit: createAuditService(db) });
    await expect(
      service.update(ctx(adminA), {
        automation: {
          staleProposalReminder: { enabled: true, days: 20 },
          followUpToLost: { enabled: true, days: 15 },
        },
      }),
    ).rejects.toMatchObject({
      details: {
        fields: {
          'automation.staleProposalReminder.days': 'Use até 14 dias: a perda automática está em 15',
        },
      },
    });
  });
});
