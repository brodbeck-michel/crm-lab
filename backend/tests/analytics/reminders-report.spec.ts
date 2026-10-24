/**
 * `GET /analytics/reminders` — lembretes por atendente (CRMLAB-103, D-279),
 * API_CONTRACTS.md §5.
 *
 * Expediente em America/Sao_Paulo (UTC−3). Os horários abaixo estão em UTC no
 * banco; no comentário vem a hora LOCAL. O relógio do service é fixado em
 * 2026-09-21 02:00 UTC = 20/09 23:00 em Brasília: o "hoje" dos vencidos é
 * 2026-09-20, embora o dia UTC já seja 21.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProposalReminderOutcome, ProposalReminderReport } from '@crm-lab/shared';
import { analyticsModule } from '../../src/controllers/analytics.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { createProposalReminderReportService } from '../../src/services/proposal-reminder-report.service.js';
import { createProposal, createTenant, createUser, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { ctxOf } from './helpers.js';

const URL = '/api/v1/analytics/reminders';
const NOW = new Date('2026-09-21T02:00:00Z');
const PERIOD = { startDate: '2026-09-01', endDate: '2026-09-30' };

let db: DbClient;
let app: TestApp;
let tenantId: string;
let manager: UserRecord;
let ana: UserRecord;
let bruno: UserRecord;

async function businessHoursSaoPaulo(id: string): Promise<void> {
  const hours = { timezone: 'America/Sao_Paulo', days: { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null } };
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO tenant_settings (tenant_id, business_hours) VALUES ($1, $2::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE SET business_hours = $2::jsonb`,
      [id, JSON.stringify(hours)],
    ),
  );
}

/** Proposta da `owner`; `null` = cartão do Bitlab sem responsável (fila comum, D-195). */
async function proposalOf(owner: UserRecord | null, tid = tenantId): Promise<string> {
  const creator = owner ?? (await createUser({ tenantId: tid, db }));
  const p = await createProposal({ tenantId: tid, createdBy: creator.id, db });
  if (owner === null) {
    await db.withoutTenant((tx) => tx.query(`UPDATE proposals SET origin = 'bitlab', created_by = NULL WHERE id = $1`, [p.id]));
    await db.withoutTenant((tx) => tx.query(`DELETE FROM users WHERE id = $1`, [creator.id]));
  }
  return p.id;
}

interface ReminderInput {
  proposalId: string;
  due?: string;
  /** Ausente = aberto. */
  outcome?: ProposalReminderOutcome;
  /** UTC `YYYY-MM-DD HH:MM:SS`. */
  resolvedAt?: string;
  resolvedBy?: UserRecord;
  tid?: string;
}

async function reminder(input: ReminderInput): Promise<void> {
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO proposal_reminders (tenant_id, proposal_id, origin, due_date, resolved_at, resolved_by, outcome)
       VALUES ($1, $2, 'manual', $3::date, $4::timestamp, $5, $6)`,
      [
        input.tid ?? tenantId,
        input.proposalId,
        input.due ?? '2026-09-10',
        input.outcome ? (input.resolvedAt ?? '2026-09-15 15:00:00') : null,
        input.resolvedBy?.id ?? null,
        input.outcome ?? null,
      ],
    ),
  );
}

async function report(user: UserRecord = manager, query = PERIOD): Promise<ProposalReminderReport> {
  const service = createProposalReminderReportService({ db, now: () => NOW });
  return service.getReport(ctxOf(user), query);
}

function rowOf(r: ProposalReminderReport, name: string) {
  const row = r.rows.find((x) => x.name === name);
  if (!row) throw new Error(`linha ${name} ausente: ${r.rows.map((x) => x.name).join(', ')}`);
  return row;
}

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [analyticsModule] });
  tenantId = (await createTenant({ db })).id;
  manager = await createUser({ tenantId, role: 'manager', name: 'Gestora', db });
  ana = await createUser({ tenantId, role: 'attendant', name: 'Ana', db });
  bruno = await createUser({ tenantId, role: 'attendant', name: 'Bruno', db });
  await businessHoursSaoPaulo(tenantId);
});

describe('GET /analytics/reminders — contagens', () => {
  it('conta cada desfecho do período e o total, na linha da responsável', async () => {
    const p1 = await proposalOf(ana);
    const p2 = await proposalOf(ana);
    await reminder({ proposalId: p1, outcome: 'won' });
    await reminder({ proposalId: p1, outcome: 'rescheduled' });
    await reminder({ proposalId: p2, outcome: 'lost' });
    await reminder({ proposalId: p2, outcome: 'auto_closed' });
    await reminder({ proposalId: p2, outcome: 'rescheduled' });

    const r = await report();
    expect(rowOf(r, 'Ana')).toEqual({
      userId: ana.id,
      name: 'Ana',
      overdueOpen: 0,
      won: 1,
      lost: 1,
      rescheduled: 2,
      autoClosed: 1,
      resolved: 5,
    });
    expect(r.total.resolved).toBe(5);
    expect(r.today).toBe('2026-09-20');
    expect(r.period).toEqual(PERIOD);
  });

  it('atribui à responsável pela proposta, não a quem resolveu', async () => {
    const p = await proposalOf(ana);
    await reminder({ proposalId: p, outcome: 'won', resolvedBy: bruno });

    const r = await report();
    expect(rowOf(r, 'Ana').won).toBe(1);
    expect(rowOf(r, 'Bruno').won).toBe(0);
  });

  it('vencido = aberto com dia ≤ hoje em Brasília; independe do período', async () => {
    await reminder({ proposalId: await proposalOf(ana), due: '2026-09-20' }); // hoje em Brasília
    await reminder({ proposalId: await proposalOf(ana), due: '2026-08-01' }); // fora do período, ainda vencido
    await reminder({ proposalId: await proposalOf(ana), due: '2026-09-21' }); // amanhã em Brasília (hoje em UTC)
    await reminder({ proposalId: await proposalOf(bruno), due: '2026-09-25' });

    const r = await report();
    expect(rowOf(r, 'Ana').overdueOpen).toBe(2);
    expect(rowOf(r, 'Bruno').overdueOpen).toBe(0);
    expect(r.total.overdueOpen).toBe(2);
    // Um período antigo não muda a foto de agora.
    const antigo = await report(manager, { startDate: '2026-01-01', endDate: '2026-01-31' });
    expect(rowOf(antigo, 'Ana').overdueOpen).toBe(2);
  });

  it('período: bordas nas meias-noites locais do fuso do expediente', async () => {
    const p = await proposalOf(ana);
    await reminder({ proposalId: p, outcome: 'won', resolvedAt: '2026-09-01 02:00:00' }); // 31/08 23:00 → fora
    await reminder({ proposalId: p, outcome: 'won', resolvedAt: '2026-09-01 03:00:00' }); // 01/09 00:00 → dentro
    await reminder({ proposalId: p, outcome: 'lost', resolvedAt: '2026-10-01 02:30:00' }); // 30/09 23:30 → dentro
    await reminder({ proposalId: p, outcome: 'lost', resolvedAt: '2026-10-01 03:00:00' }); // 01/10 00:00 → fora

    const r = await report();
    expect(rowOf(r, 'Ana')).toMatchObject({ won: 1, lost: 1, resolved: 2 });
  });

  it('proposta sem responsável vira a linha "Sem responsável"', async () => {
    const p = await proposalOf(null);
    await reminder({ proposalId: p, due: '2026-09-01' });
    await reminder({ proposalId: p, outcome: 'auto_closed' });

    const r = await report();
    expect(rowOf(r, 'Sem responsável')).toMatchObject({ userId: null, overdueOpen: 1, autoClosed: 1, resolved: 1 });
  });

  it('ativa sem números aparece zerada; inativa só com números; ordem: mais vencidos primeiro', async () => {
    const carla = await createUser({ tenantId, role: 'attendant', name: 'Carla', isActive: false, db });
    const dora = await createUser({ tenantId, role: 'attendant', name: 'Dora', isActive: false, db });
    await reminder({ proposalId: await proposalOf(carla), due: '2026-09-01' });
    await reminder({ proposalId: await proposalOf(carla), due: '2026-09-02' });
    await reminder({ proposalId: await proposalOf(bruno), due: '2026-09-03' });
    // Dora (inativa) só tem lembrete fora do período e não vencido: some.
    await reminder({ proposalId: await proposalOf(dora), outcome: 'won', resolvedAt: '2026-07-01 12:00:00' });

    const r = await report();
    const names = r.rows.map((x) => x.name);
    expect(names.slice(0, 2)).toEqual(['Carla', 'Bruno']);
    expect(names).toContain('Ana');
    expect(names).toContain('Gestora');
    expect(names).not.toContain('Dora');
    expect(rowOf(r, 'Ana').overdueOpen).toBe(0);
  });

  it('isolamento: lembretes e atendentes de outro laboratório não aparecem', async () => {
    const tenantB = (await createTenant({ db })).id;
    const carla = await createUser({ tenantId: tenantB, role: 'attendant', name: 'Carla', db });
    const pb = await proposalOf(carla, tenantB);
    await reminder({ proposalId: pb, tid: tenantB, due: '2026-09-01' });
    await reminder({ proposalId: pb, tid: tenantB, outcome: 'won' });

    const r = await report();
    expect(r.rows.map((x) => x.name)).not.toContain('Carla');
    expect(r.total).toEqual({ overdueOpen: 0, won: 0, lost: 0, rescheduled: 0, autoClosed: 0, resolved: 0 });

    // Controle positivo: no próprio B aparece.
    const managerB = await createUser({ tenantId: tenantB, role: 'manager', db });
    const b = await report(managerB);
    expect(rowOf(b, 'Carla')).toMatchObject({ overdueOpen: 1, won: 1 });
  });
});

describe('GET /analytics/reminders — rota', () => {
  it('gestor e admin leem; atendente e operador da plataforma recebem FORBIDDEN', async () => {
    const admin = await createUser({ tenantId, role: 'admin', db });
    const ok = await app.agent.get(`${URL}?startDate=2026-09-01&endDate=2026-09-30`).set(app.auth(manager)).expect(200);
    expect((ok.body as ProposalReminderReport).period).toEqual(PERIOD);
    await app.agent.get(URL).set(app.auth(admin)).expect(200);

    const res = await app.agent.get(URL).set(app.auth(ana)).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    const operador = { ...manager, role: 'platform_operator' as const };
    await app.agent.get(URL).set(app.auth(operador)).expect(403);
  });

  it('período invertido é VALIDATION_ERROR', async () => {
    const res = await app.agent
      .get(`${URL}?startDate=2026-09-30&endDate=2026-09-01`)
      .set(app.auth(manager))
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
