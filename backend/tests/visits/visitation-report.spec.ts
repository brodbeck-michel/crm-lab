/**
 * Relatório de Visitação — CRMLAB-193, D-333 (API_CONTRACTS §14b,
 * BUSINESS_RULES §15b) + corte A/B/C em `GET /doctors/portfolios`.
 *
 * Foco: fórmulas (taxa sem as abertas no denominador, duração só com check-in
 * e check-out, cobertura sem inativo, reagendamentos por evento), bordas do
 * período em São Paulo, período vazio, escopo por perfil (atendente 403,
 * representante só os dele com `responsibleId` ignorado, gestor tudo),
 * esquecidos (nunca visitado, ordem ABC, limite de X dias) e isolamento.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  saoPauloToday,
  type ApiErrorBody,
  type DoctorAbcClass,
  type ListDoctorPortfoliosResponse,
  type VisitationReport,
  type VisitationReportStaleResponse,
  type VisitStatus,
} from '@crm-lab/shared';
import { doctorModule } from '../../src/controllers/doctor.routes.js';
import { visitationReportModule } from '../../src/controllers/visitation-report.routes.js';
import { bucketOf, buildEvolution, percent } from '../../src/services/visitation-report.service.js';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, visitPurposeId, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const SUMMARY = '/api/v1/visitation-reports/summary';
const STALE = '/api/v1/visitation-reports/stale-doctors';
const JANUARY = '?from=2026-01-01&to=2026-01-31';

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let admin: UserRecord;
let manager: UserRecord;
let attendant: UserRecord;
let carla: UserRecord;
let diego: UserRecord;
let eva: UserRecord; // representante sem carteira
let managerB: UserRecord;
let repB: UserRecord;
let materialPurpose: string;

// Médicos de A
let dA1: string; // Carla, A
let dB1: string; // Carla, B
let dC1: string; // Carla, C
let dInactive: string; // Carla, A, inativo
let dNull: string; // Carla, sem classe
let dDiego: string; // Diego, A
let dNever: string; // Diego, A, nunca visitado
let dOrphan: string; // sem responsável, C, nunca visitado
let v6: string;
let v7: string;

async function insertDoctor(
  tenantId: string,
  name: string,
  responsibleId: string | null,
  abcClass: DoctorAbcClass | null,
  isActive = true,
): Promise<string> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO doctors (tenant_id, name, responsible_user_id, abc_class, is_active)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenantId, name, responsibleId, abcClass, isActive],
    ),
  );
  return result.rows[0]?.id as string;
}

interface VisitInput {
  tenantId: string;
  doctorId: string;
  responsibleId: string;
  scheduledAt: string;
  status?: VisitStatus;
  checkInAt?: string | null;
  checkOutAt?: string | null;
  purposeId?: string;
}

async function insertVisit(input: VisitInput): Promise<string> {
  const status = input.status ?? 'agendada';
  const reason = status === 'cancelada' || status === 'nao_recebeu' ? 'motivo de teste' : null;
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO doctor_visits (tenant_id, doctor_id, responsible_user_id, scheduled_at, type, status,
                                  status_reason, check_in_at, check_out_at, purpose_id)
       VALUES ($1, $2, $3, $4::timestamptz, 'presencial', $5, $6, $7::timestamptz, $8::timestamptz,
               COALESCE($9::uuid, (SELECT id FROM visit_purposes WHERE tenant_id = $1 AND name = 'Visita')))
       RETURNING id`,
      [
        input.tenantId,
        input.doctorId,
        input.responsibleId,
        input.scheduledAt,
        status,
        reason,
        input.checkInAt ?? null,
        input.checkOutAt ?? null,
        input.purposeId ?? null,
      ],
    ),
  );
  return result.rows[0]?.id as string;
}

async function insertReschedule(tenantId: string, visitId: string, changedAt: string): Promise<void> {
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO doctor_visit_reschedules (tenant_id, visit_id, previous_scheduled_at, new_scheduled_at, changed_at)
       VALUES ($1, $2, $3::timestamptz, $3::timestamptz, $3::timestamptz)`,
      [tenantId, visitId, changedAt],
    ),
  );
}

async function summaryAs(user: UserRecord, query = JANUARY): Promise<VisitationReport> {
  const response = await app.agent.get(`${SUMMARY}${query}`).set(app.auth(user)).expect(200);
  return response.body as VisitationReport;
}

async function staleAs(user: UserRecord, query = ''): Promise<VisitationReportStaleResponse> {
  const response = await app.agent.get(`${STALE}${query}`).set(app.auth(user)).expect(200);
  return response.body as VisitationReportStaleResponse;
}

function errorOf(response: { body: unknown }) {
  return (response.body as ApiErrorBody).error;
}

/** `YYYY-MM-DD` local de hoje − n dias, ao meio-dia de São Paulo (15:00Z). */
function localNoonDaysAgo(days: number): string {
  const today = saoPauloToday(new Date());
  const date = new Date(`${today}T15:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [doctorModule, visitationReportModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  materialPurpose = await visitPurposeId(tenantA.id, 'Solicitação de material', db);
  admin = await createUser({ tenantId: tenantA.id, role: 'admin', name: 'Admin A', db });
  manager = await createUser({ tenantId: tenantA.id, role: 'manager', name: 'Gestora A', db });
  attendant = await createUser({ tenantId: tenantA.id, role: 'attendant', name: 'Atendente A', db });
  carla = await createUser({ tenantId: tenantA.id, role: 'representative', name: 'Carla Rep', db });
  diego = await createUser({ tenantId: tenantA.id, role: 'representative', name: 'Diego Rep', db });
  eva = await createUser({ tenantId: tenantA.id, role: 'representative', name: 'Eva Rep', db });
  managerB = await createUser({ tenantId: tenantB.id, role: 'manager', name: 'Gestor B', db });
  repB = await createUser({ tenantId: tenantB.id, role: 'representative', name: 'Rep B', db });

  dA1 = await insertDoctor(tenantA.id, 'Dra. Ana A', carla.id, 'A');
  dB1 = await insertDoctor(tenantA.id, 'Dr. Bruno B', carla.id, 'B');
  dC1 = await insertDoctor(tenantA.id, 'Dr. Caio C', carla.id, 'C');
  dInactive = await insertDoctor(tenantA.id, 'Dr. Inativo', carla.id, 'A', false);
  dNull = await insertDoctor(tenantA.id, 'Dra. Nova Sem Classe', carla.id, null);
  dDiego = await insertDoctor(tenantA.id, 'Dr. Davi Diego', diego.id, 'A');
  dNever = await insertDoctor(tenantA.id, 'Dra. Nunca Visitada', diego.id, 'A');
  dOrphan = await insertDoctor(tenantA.id, 'Dr. Órfão', null, 'C');
  const dB = await insertDoctor(tenantB.id, 'Dr. Segredo Lab B', repB.id, 'A');

  const a = tenantA.id;
  // v1: realizada, 30 min
  await insertVisit({ tenantId: a, doctorId: dA1, responsibleId: carla.id, scheduledAt: '2026-01-05T13:00:00.000Z',
    status: 'realizada', checkInAt: '2026-01-05T13:00:00.000Z', checkOutAt: '2026-01-05T13:30:00.000Z' });
  // v2: realizada, 60 min
  await insertVisit({ tenantId: a, doctorId: dB1, responsibleId: carla.id, scheduledAt: '2026-01-12T14:00:00.000Z',
    status: 'realizada', checkInAt: '2026-01-12T14:00:00.000Z', checkOutAt: '2026-01-12T15:00:00.000Z' });
  // v3: check-in SEM check-out — segue `agendada` (o banco só aceita realizada com check-out):
  // fora da média e da cobertura
  await insertVisit({ tenantId: a, doctorId: dC1, responsibleId: carla.id, scheduledAt: '2026-01-20T13:00:00.000Z',
    checkInAt: '2026-01-20T13:00:00.000Z' });
  // v4: cancelada, finalidade "Solicitação de material"
  await insertVisit({ tenantId: a, doctorId: dC1, responsibleId: carla.id, scheduledAt: '2026-01-21T13:00:00.000Z',
    status: 'cancelada', purposeId: materialPurpose });
  // v5: não recebeu — médico do Diego, cobertura da Carla
  await insertVisit({ tenantId: a, doctorId: dDiego, responsibleId: carla.id, scheduledAt: '2026-01-22T13:00:00.000Z',
    status: 'nao_recebeu' });
  // v6: realizada pelo Diego, 10 min
  v6 = await insertVisit({ tenantId: a, doctorId: dDiego, responsibleId: diego.id, scheduledAt: '2026-01-15T13:00:00.000Z',
    status: 'realizada', checkInAt: '2026-01-15T13:00:00.000Z', checkOutAt: '2026-01-15T13:10:00.000Z' });
  // v7: ainda agendada
  v7 = await insertVisit({ tenantId: a, doctorId: dA1, responsibleId: carla.id, scheduledAt: '2026-01-28T13:00:00.000Z' });
  // v8: realizada em médico inativo, 120 min (conta nos status e na média; fora da cobertura)
  await insertVisit({ tenantId: a, doctorId: dInactive, responsibleId: carla.id, scheduledAt: '2026-01-10T13:00:00.000Z',
    status: 'realizada', checkInAt: '2026-01-10T13:00:00.000Z', checkOutAt: '2026-01-10T15:00:00.000Z' });
  // v9: 31/01 23:30 em São Paulo (= 01/02 02:30Z) — DENTRO do período; médico da Carla, responsável Diego
  await insertVisit({ tenantId: a, doctorId: dNull, responsibleId: diego.id, scheduledAt: '2026-02-01T02:30:00.000Z' });
  // Fora do período: 31/12 23:00 em São Paulo e 05/02
  await insertVisit({ tenantId: a, doctorId: dA1, responsibleId: carla.id, scheduledAt: '2026-01-01T02:00:00.000Z',
    status: 'realizada', checkInAt: '2026-01-01T02:00:00.000Z', checkOutAt: '2026-01-01T05:00:00.000Z' });
  await insertVisit({ tenantId: a, doctorId: dNull, responsibleId: carla.id, scheduledAt: '2026-02-05T13:00:00.000Z',
    status: 'realizada', checkInAt: '2026-02-05T13:00:00.000Z', checkOutAt: '2026-02-05T14:00:00.000Z' });

  // Reagendamentos: dois do v7 e um do v6 em janeiro; um do v7 em fevereiro (fora).
  await insertReschedule(a, v7, '2026-01-10T12:00:00.000Z');
  await insertReschedule(a, v7, '2026-01-11T12:00:00.000Z');
  await insertReschedule(a, v6, '2026-01-14T12:00:00.000Z');
  await insertReschedule(a, v7, '2026-02-02T12:00:00.000Z');

  // Tenant B: nada disto pode aparecer em A.
  await insertVisit({ tenantId: tenantB.id, doctorId: dB, responsibleId: repB.id, scheduledAt: '2026-01-07T13:00:00.000Z',
    status: 'realizada', checkInAt: '2026-01-07T13:00:00.000Z', checkOutAt: '2026-01-07T16:00:00.000Z' });
});

describe('helpers da evolução', () => {
  it('semana começa na segunda; mês no dia 1', () => {
    expect(bucketOf('2026-01-01', 'week')).toBe('2025-12-29'); // quinta → segunda anterior
    expect(bucketOf('2026-01-04', 'week')).toBe('2025-12-29'); // domingo fica na semana que começou na segunda
    expect(bucketOf('2026-01-05', 'week')).toBe('2026-01-05');
    expect(bucketOf('2026-03-17', 'month')).toBe('2026-03-01');
  });

  it('todos os baldes do período aparecem, zerados quando vazios', () => {
    const points = buildEvolution('2026-01-01', '2026-03-31', 'month', [
      { date: '2026-02-10', status: 'realizada', count: 2 },
    ]);
    expect(points.map((p) => p.bucket)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    expect(points[0]).toMatchObject({ total: 0, completed: 0 });
    expect(points[1]).toMatchObject({ total: 2, completed: 2 });
  });

  it('percentual com uma casa, null sem base', () => {
    expect(percent(5, 7)).toBe(71.4);
    expect(percent(0, 0)).toBeNull();
  });
});

describe('GET /visitation-reports/summary — gestor (laboratório inteiro)', () => {
  it('cards: status, taxa sem as abertas, duração só com check-in e check-out, cobertura sem inativo', async () => {
    const report = await summaryAs(manager);
    expect(report.scope).toBe('all');
    expect(report.granularity).toBe('week');
    expect(report.period).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    expect(report.summary).toMatchObject({
      scheduled: 3, // v3 (check-in sem check-out), v7 e v9 (31/01 23:30 local entra)
      completed: 4, // v1, v2, v6, v8
      cancelled: 1,
      notReceived: 1,
      total: 9,
      reschedules: 3, // o de fevereiro fica fora
      completionRate: 66.7, // 4 ÷ (4 + 1 + 1) — as abertas fora do denominador
      averageDurationMinutes: 55, // (30 + 60 + 10 + 120) ÷ 4 — v3 (sem check-out) fora
      durationSampleSize: 4,
    });
    // Ativos: A1, B1, C1, Nova, Davi, Nunca, Órfão = 7 (o inativo sai); visitados: A1, B1, Davi.
    expect(report.summary.coverage).toEqual({ portfolioDoctors: 7, visitedDoctors: 3, rate: 42.9 });
  });

  it('por representante: carteira e cobertura pela carteira; status e reagendamentos pelo responsável da visita', async () => {
    const report = await summaryAs(manager);
    // Admin e Gestora não têm carteira nem visita; Eva é representante (aparece zerada).
    expect(report.byRepresentative.map((row) => row.responsible.name)).toEqual(['Carla Rep', 'Diego Rep', 'Eva Rep']);
    const [carlaRow, diegoRow, evaRow] = report.byRepresentative;
    expect(carlaRow).toMatchObject({
      portfolioDoctors: 4,
      visitedDoctors: 2,
      coverage: { portfolioDoctors: 4, visitedDoctors: 2, rate: 50 },
      completed: 3, // v1, v2, v8
      cancelled: 1,
      notReceived: 1, // v5, cobertura no médico do Diego
      reschedules: 2,
    });
    expect(carlaRow?.coverageByClass).toEqual({
      A: { portfolioDoctors: 1, visitedDoctors: 1, rate: 100 },
      B: { portfolioDoctors: 1, visitedDoctors: 1, rate: 100 },
      C: { portfolioDoctors: 1, visitedDoctors: 0, rate: 0 },
      unclassified: { portfolioDoctors: 1, visitedDoctors: 0, rate: 0 },
    });
    expect(diegoRow).toMatchObject({ portfolioDoctors: 2, visitedDoctors: 1, completed: 1, reschedules: 1 });
    expect(diegoRow?.coverage.rate).toBe(50);
    expect(evaRow).toMatchObject({ portfolioDoctors: 0, visitedDoctors: 0, completed: 0 });
    expect(evaRow?.coverage.rate).toBeNull();
  });

  it('por finalidade e evolução semanal', async () => {
    const report = await summaryAs(manager);
    expect(report.byPurpose).toEqual([
      { purpose: expect.objectContaining({ name: 'Visita', color: 'azul' }), total: 8, completed: 4 },
      { purpose: expect.objectContaining({ name: 'Solicitação de material', color: 'agua' }), total: 1, completed: 0 },
    ]);
    expect(report.evolution.map((p) => p.bucket)).toEqual([
      '2025-12-29',
      '2026-01-05',
      '2026-01-12',
      '2026-01-19',
      '2026-01-26',
    ]);
    expect(report.evolution.reduce((sum, p) => sum + p.total, 0)).toBe(9);
    expect(report.evolution[4]).toMatchObject({ total: 2, completed: 0 }); // v7 + v9
    expect(report.evolution[3]).toMatchObject({ total: 3, completed: 0, cancelled: 1, notReceived: 1 });
  });

  it('granularidade mensal sob pedido (e automática acima de 92 dias)', async () => {
    const monthly = await summaryAs(manager, `${JANUARY}&granularity=month`);
    expect(monthly.evolution).toEqual([
      { bucket: '2026-01-01', total: 9, completed: 4, cancelled: 1, notReceived: 1 },
    ]);
    const long = await summaryAs(manager, '?from=2026-01-01&to=2026-06-30');
    expect(long.granularity).toBe('month');
    expect(long.evolution).toHaveLength(6);
  });

  it('filtro de classe ABC: visitas e carteira só daquela classe (sem classe nunca entra)', async () => {
    const report = await summaryAs(manager, `${JANUARY}&abcClass=A`);
    // A1 (v1, v7), Inativo-A (v8), Davi (v5, v6)
    expect(report.summary).toMatchObject({ scheduled: 1, completed: 3, cancelled: 0, notReceived: 1, total: 5 });
    expect(report.summary.coverage).toEqual({ portfolioDoctors: 3, visitedDoctors: 2, rate: 66.7 });
  });

  it('filtro de finalidade vale para visitas e para a cobertura', async () => {
    const report = await summaryAs(manager, `${JANUARY}&purposeId=${materialPurpose}`);
    expect(report.summary).toMatchObject({ total: 1, cancelled: 1, completed: 0, completionRate: 0 });
    expect(report.summary.coverage).toEqual({ portfolioDoctors: 7, visitedDoctors: 0, rate: 0 });
    expect(report.byPurpose).toHaveLength(1);
  });

  it('período vazio: tudo zerado, taxa e duração nulas', async () => {
    const report = await summaryAs(manager, '?from=2025-06-01&to=2025-06-30');
    expect(report.summary).toMatchObject({
      scheduled: 0,
      completed: 0,
      cancelled: 0,
      notReceived: 0,
      total: 0,
      reschedules: 0,
      completionRate: null,
      averageDurationMinutes: null,
      durationSampleSize: 0,
    });
    expect(report.summary.coverage).toEqual({ portfolioDoctors: 7, visitedDoctors: 0, rate: 0 });
    expect(report.byPurpose).toEqual([]);
    expect(report.evolution.every((p) => p.total === 0)).toBe(true);
  });

  it('com responsibleId, o gestor vê exatamente o que aquele representante vê', async () => {
    const asCarla = await summaryAs(carla);
    const filtered = await summaryAs(manager, `${JANUARY}&responsibleId=${carla.id}`);
    expect(filtered.scope).toBe('all');
    expect(filtered.summary).toEqual(asCarla.summary);
    expect(filtered.byRepresentative).toEqual(asCarla.byRepresentative);
  });

  it('admin vê o mesmo que o gestor', async () => {
    expect((await summaryAs(admin)).summary).toEqual((await summaryAs(manager)).summary);
  });
});

describe('GET /visitation-reports/summary — representante (só os dele)', () => {
  it('escopo: médicos da carteira + visitas em que é o responsável; carteira só a dele', async () => {
    const report = await summaryAs(carla);
    expect(report.scope).toBe('own');
    // v1, v2, v3, v4, v5 (cobertura), v7, v8, v9 (médico dela) — v6 (Diego no médico do Diego) fica fora
    expect(report.summary).toMatchObject({
      scheduled: 3,
      completed: 3,
      cancelled: 1,
      notReceived: 1,
      total: 8,
      reschedules: 2,
    });
    expect(report.summary.coverage).toEqual({ portfolioDoctors: 4, visitedDoctors: 2, rate: 50 });
    expect(report.byRepresentative.map((row) => row.responsible.id)).toEqual([carla.id]);
  });

  it('responsibleId de outro representante é ignorado (nunca amplia o recorte)', async () => {
    const own = await summaryAs(carla);
    const tried = await summaryAs(carla, `${JANUARY}&responsibleId=${diego.id}`);
    expect(tried).toEqual(own);
  });

  it('representante sem carteira: cobertura nula', async () => {
    const report = await summaryAs(eva);
    expect(report.summary.total).toBe(0);
    expect(report.summary.coverage).toEqual({ portfolioDoctors: 0, visitedDoctors: 0, rate: null });
  });
});

describe('perfil, validação e isolamento', () => {
  it('atendente → 403 nas duas rotas', async () => {
    for (const path of [`${SUMMARY}${JANUARY}`, STALE]) {
      const response = await app.agent.get(path).set(app.auth(attendant)).expect(403);
      expect(errorOf(response).code).toBe('FORBIDDEN');
      expect(errorOf(response).details).toMatchObject({ requiredRoles: ['representative', 'manager', 'admin'] });
    }
  });

  it('período inválido → 400', async () => {
    const cases = [
      '?from=2026-01-31&to=2026-01-01', // final antes da inicial
      '?from=2025-01-01&to=2026-01-02', // mais de 366 dias
      '?from=2026-02-30&to=2026-03-01', // data que não existe
      '?from=2026-01-01', // sem final
      `${JANUARY}&abcClass=D`,
      `${JANUARY}&granularity=day`,
      `${JANUARY}&responsibleId=nao-uuid`,
    ];
    for (const query of cases) {
      const response = await app.agent.get(`${SUMMARY}${query}`).set(app.auth(manager));
      expect(response.status, query).toBe(400);
      expect(errorOf(response).code).toBe('VALIDATION_ERROR');
    }
  });

  it('nada cruza tenant: gestor de B vê só B; responsibleId de B em A devolve zeros', async () => {
    const reportB = await summaryAs(managerB);
    expect(reportB.summary).toMatchObject({ completed: 1, total: 1, averageDurationMinutes: 180 });
    expect(reportB.summary.coverage).toEqual({ portfolioDoctors: 1, visitedDoctors: 1, rate: 100 });
    expect(reportB.byRepresentative.map((row) => row.responsible.name)).toEqual(['Rep B']);

    const crossed = await summaryAs(manager, `${JANUARY}&responsibleId=${repB.id}`);
    expect(crossed.summary.total).toBe(0);
    expect(crossed.summary.coverage.portfolioDoctors).toBe(0);
    expect(crossed.byRepresentative).toEqual([]);

    const staleCrossed = await staleAs(manager, `?responsibleId=${repB.id}`);
    expect(staleCrossed.doctors).toEqual([]);
    expect(JSON.stringify(await staleAs(manager))).not.toContain('Segredo Lab B');
  });
});

describe('GET /visitation-reports/stale-doctors', () => {
  it('gestor: ativos sem visita realizada há mais de 60 dias ou nunca; ordem A, B, C, sem classe', async () => {
    // A1 teve visita realizada há 10 dias: sai da lista.
    await insertVisit({ tenantId: tenantA.id, doctorId: dA1, responsibleId: carla.id, scheduledAt: localNoonDaysAgo(10),
      status: 'realizada', checkInAt: localNoonDaysAgo(10), checkOutAt: localNoonDaysAgo(10) });
    // Visita só agendada não conta como visitado.
    await insertVisit({ tenantId: tenantA.id, doctorId: dNever, responsibleId: diego.id, scheduledAt: localNoonDaysAgo(1) });

    const result = await staleAs(manager);
    expect(result.days).toBe(60);
    expect(result.referenceDate).toBe(saoPauloToday(new Date()));
    expect(result.truncated).toBe(false);
    // Dentro da classe: nunca visitado primeiro. Inativo nunca aparece.
    // C1 só tem visita com check-in sem check-out (não realizada): nunca visitado, empate por nome.
    expect(result.doctors.map((d) => d.id)).toEqual([dNever, dDiego, dB1, dC1, dOrphan, dNull]);
    expect(result.total).toBe(6);

    const never = result.doctors[0];
    expect(never).toMatchObject({ abcClass: 'A', lastVisitAt: null, daysSinceLastVisit: null });
    expect(never?.responsible).toEqual({ id: diego.id, name: 'Diego Rep' });
    const bruno = result.doctors.find((d) => d.id === dB1);
    expect(bruno?.lastVisitAt).toBe('2026-01-12T15:00:00.000Z'); // check-out da v2
    expect(bruno?.daysSinceLastVisit).toBeGreaterThan(60);
    expect(result.doctors.find((d) => d.id === dC1)?.lastVisitAt).toBeNull();
    expect(result.doctors.find((d) => d.id === dOrphan)?.responsible).toBeNull();
  });

  it('representante: só a carteira dele; responsibleId ignorado', async () => {
    const own = await staleAs(carla);
    expect(own.doctors.map((d) => d.id)).toEqual([dA1, dB1, dC1, dNull]);
    const tried = await staleAs(carla, `?responsibleId=${diego.id}`);
    expect(tried.doctors.map((d) => d.id)).toEqual(own.doctors.map((d) => d.id));
  });

  it('filtros do gestor: representante e classe', async () => {
    const diegoOnly = await staleAs(manager, `?responsibleId=${diego.id}`);
    expect(diegoOnly.doctors.map((d) => d.id)).toEqual([dNever, dDiego]);
    const classC = await staleAs(manager, '?abcClass=C');
    expect(classC.doctors.map((d) => d.id)).toEqual([dC1, dOrphan]);
  });

  it('"mais de X dias": exatamente X fica fora, X + 1 entra', async () => {
    const edge5 = await insertDoctor(tenantA.id, 'Dr. Cinco Dias', eva.id, 'B');
    const edge6 = await insertDoctor(tenantA.id, 'Dr. Seis Dias', eva.id, 'B');
    await insertVisit({ tenantId: tenantA.id, doctorId: edge5, responsibleId: eva.id, scheduledAt: localNoonDaysAgo(5),
      status: 'realizada', checkInAt: localNoonDaysAgo(5), checkOutAt: localNoonDaysAgo(5) });
    await insertVisit({ tenantId: tenantA.id, doctorId: edge6, responsibleId: eva.id, scheduledAt: localNoonDaysAgo(6),
      status: 'realizada', checkInAt: localNoonDaysAgo(6), checkOutAt: localNoonDaysAgo(6) });

    const result = await staleAs(eva, '?days=5');
    expect(result.doctors.map((d) => d.id)).toEqual([edge6]);
    expect(result.doctors[0]?.daysSinceLastVisit).toBe(6);
  });

  it('X fora de 1–730 → 400', async () => {
    for (const days of ['0', '731', 'abc']) {
      const response = await app.agent.get(`${STALE}?days=${days}`).set(app.auth(manager));
      expect(response.status, days).toBe(400);
    }
  });
});

describe('GET /doctors/portfolios — corte A/B/C (D-333 item 7)', () => {
  it('cada carteira e o balde sem responsável trazem o ABC dos ativos', async () => {
    const response = await app.agent.get('/api/v1/doctors/portfolios').set(app.auth(manager)).expect(200);
    const body = response.body as ListDoctorPortfoliosResponse;
    const byName = new Map(body.portfolios.map((p) => [p.responsible.name, p]));

    const carlaPortfolio = byName.get('Carla Rep');
    expect(carlaPortfolio).toMatchObject({ doctorCount: 5, activeDoctorCount: 4 });
    // O inativo (classe A) não entra no corte: a soma bate com os ativos.
    expect(carlaPortfolio?.abc).toEqual({ A: 1, B: 1, C: 1, unclassified: 1 });
    expect(byName.get('Diego Rep')?.abc).toEqual({ A: 2, B: 0, C: 0, unclassified: 0 });
    expect(byName.get('Eva Rep')?.abc).toEqual({ A: 0, B: 0, C: 0, unclassified: 0 });
    expect(body.unassigned).toEqual({ doctorCount: 1, activeDoctorCount: 1, abc: { A: 0, B: 0, C: 1, unclassified: 0 } });
  });
});
