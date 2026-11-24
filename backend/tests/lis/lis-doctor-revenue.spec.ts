/**
 * Faturamento por médico solicitante — CRMLAB-198, D-336.
 *
 *  - `GET /lis-budgets/by-doctor`: duas janelas (requisição pela emissão, recebido pelo
 *    pagamento), chave do médico (identificado / nome / sem médico), vínculo com o cadastro
 *    por CRM + UF só no conselho CRM, médico vindo de outra linha da requisição, filtro de
 *    representante, totais iguais aos KPIs do summary, papéis e isolamento;
 *  - `GET /doctors/:id/revenue`: 12 meses, `matched: false` sem CRM, escopo da carteira.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiErrorBody,
  DoctorRevenue,
  LisBudgetsSummary,
  LisDoctorRevenueResponse,
} from '@crm-lab/shared';
import { doctorModule } from '../../src/controllers/doctor.routes.js';
import { lisAnalyticsModule } from '../../src/controllers/lis-analytics.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const PERIOD = 'startDate=2026-11-01&endDate=2026-11-30';

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let managerA: UserRecord;
let attendantA: UserRecord;
let repA: UserRecord;
let repA2: UserRecord;
let managerB: UserRecord;

interface Seed {
  number: string;
  issuedOn: string;
  requisition?: string | null;
  requisitionValue?: number | null;
  paidValue?: number | null;
  paidOn?: string | null;
  doctor?: { name: string; council?: string | null; crm?: string | null; uf?: string | null } | null;
  insurance?: string;
}

async function budget(tenantId: string, seed: Seed): Promise<void> {
  await db.withoutTenant(async (tx) => {
    const imp = await tx.query<{ id: string }>(
      `INSERT INTO lis_imports (tenant_id, kind, file_name, status) VALUES ($1, 'sync', NULL, 'completed') RETURNING id`,
      [tenantId],
    );
    const d = seed.doctor ?? null;
    await tx.query(
      `INSERT INTO lis_budgets (tenant_id, number, issued_on, insurance_1, value_1, requisition_number,
         requisition_value, paid_value, paid_on, import_id, requesting_doctor_name,
         requesting_doctor_council, requesting_doctor_crm, requesting_doctor_uf)
       VALUES ($1, $2, $3, $4, 100, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        tenantId,
        seed.number,
        seed.issuedOn,
        seed.insurance ?? 'PARTICULAR',
        seed.requisition === undefined ? `01-${seed.number}` : seed.requisition,
        seed.requisitionValue ?? null,
        seed.paidValue ?? null,
        seed.paidOn ?? null,
        imp.rows[0]?.id,
        d?.name ?? null,
        d ? (d.council === undefined ? 'CRM' : d.council) : null,
        d ? (d.crm === undefined ? '12345' : d.crm) : null,
        d ? (d.uf === undefined ? 'SC' : d.uf) : null,
      ],
    );
  });
}

async function doctor(
  tenantId: string,
  name: string,
  crm: string | null,
  responsibleId: string | null = null,
): Promise<string> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO doctors (tenant_id, name, crm, crm_uf, responsible_user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenantId, name, crm, crm === null ? null : 'SC', responsibleId],
    ),
  );
  return result.rows[0]?.id as string;
}

async function byDoctor(user: UserRecord, query = PERIOD): Promise<LisDoctorRevenueResponse> {
  const res = await app.agent.get(`/api/v1/lis-budgets/by-doctor?${query}`).set(app.auth(user));
  expect(res.status).toBe(200);
  return res.body as LisDoctorRevenueResponse;
}

const ANA = { name: 'Dra. Ana Souza' };

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [lisAnalyticsModule, doctorModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', db });
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
  repA = await createUser({ tenantId: tenantA.id, role: 'representative', name: 'Fátima', db });
  repA2 = await createUser({ tenantId: tenantA.id, role: 'representative', db });
  managerB = await createUser({ tenantId: tenantB.id, role: 'manager', db });
});

describe('GET /lis-budgets/by-doctor', () => {
  it('duas janelas, chaves do médico, vínculo pelo CRM e totais iguais aos KPIs', async () => {
    const anaId = await doctor(tenantA.id, 'Ana Souza (cadastro)', '12345', repA.id);
    // Ana: requisição emitida e paga no período; paga no período mas emitida antes; emitida e não paga.
    await budget(tenantA.id, { number: '1', issuedOn: '2026-11-03', requisitionValue: 100, paidValue: 100, paidOn: '2026-11-05', doctor: ANA });
    await budget(tenantA.id, { number: '2', issuedOn: '2026-10-20', requisitionValue: 50, paidValue: 50, paidOn: '2026-11-02', doctor: ANA });
    await budget(tenantA.id, { number: '3', issuedOn: '2026-11-10', requisitionValue: 70, doctor: ANA });
    // CRN com o mesmo número: outro conselho, outra linha, sem vínculo.
    await budget(tenantA.id, { number: '4', issuedOn: '2026-11-11', requisitionValue: 40, paidValue: 40, paidOn: '2026-11-12', doctor: { name: 'Nutri Bia', council: 'CRN' } });
    // CRM "1": coringa do Bitlab (sem médico ou enfermagem), uma linha só, nomes diferentes.
    await budget(tenantA.id, { number: '5', issuedOn: '2026-11-12', requisitionValue: 30, paidValue: 30, paidOn: '2026-11-13', doctor: { name: 'Coringa X', crm: '1' } });
    await budget(tenantA.id, { number: '6', issuedOn: '2026-11-13', requisitionValue: 20, paidValue: 20, paidOn: '2026-11-14', doctor: { name: 'Enf. Carla', crm: '1' } });
    // Sem médico.
    await budget(tenantA.id, { number: '7', issuedOn: '2026-11-14', requisitionValue: 10, paidValue: 10, paidOn: '2026-11-15' });
    // Orçamento sem requisição não conta.
    await budget(tenantA.id, { number: '8', issuedOn: '2026-11-15', requisition: null });

    const body = await byDoctor(managerA);
    expect(body.period).toEqual({ startDate: '2026-11-01', endDate: '2026-11-30' });
    expect(body.rows).toEqual([
      {
        doctorKey: 'crm:CRM:12345:SC', doctorName: 'Dra. Ana Souza', council: 'CRM', crm: '12345', uf: 'SC',
        identified: true, doctorId: anaId, responsibleName: 'Fátima',
        requisitionCount: 2, requisitionValue: 170, paidCount: 2, paidValue: 150,
      },
      {
        doctorKey: 'no-doctor', doctorName: null, council: null, crm: null, uf: null, identified: false,
        doctorId: null, responsibleName: null,
        requisitionCount: 2, requisitionValue: 50, paidCount: 2, paidValue: 50,
      },
      expect.objectContaining({
        doctorKey: 'crm:CRN:12345:SC', doctorName: 'Nutri Bia', identified: true, doctorId: null,
        requisitionCount: 1, requisitionValue: 40, paidValue: 40,
      }),
      {
        doctorKey: null, doctorName: null, council: null, crm: null, uf: null, identified: false,
        doctorId: null, responsibleName: null,
        requisitionCount: 1, requisitionValue: 10, paidCount: 1, paidValue: 10,
      },
    ]);
    expect(body.totals).toEqual({ requisitionCount: 6, requisitionValue: 270, paidCount: 6, paidValue: 250 });

    const summary = (await app.agent.get(`/api/v1/lis-budgets/summary?${PERIOD}`).set(app.auth(managerA)).expect(200))
      .body as LisBudgetsSummary;
    expect(summary.requisition).toEqual({ count: 6, totalValue: 270 });
    expect(summary.paid).toMatchObject({ count: 6, totalValue: 250 });
  });

  it('médico vem de outra linha da mesma requisição (a da dedupe não tem médico)', async () => {
    await budget(tenantA.id, { number: '10', issuedOn: '2026-11-03', requisition: '01-77', requisitionValue: 90, paidValue: 90, paidOn: '2026-11-04' });
    // `paidValue: 0` (e não NULL): a dedupe é `paid_value DESC`, com NULL primeiro no PostgreSQL —
    // é a regra dos KPIs (BUSINESS_RULES §11.2), e o relatório a segue para os totais baterem.
    await budget(tenantA.id, { number: '11', issuedOn: '2026-11-03', requisition: '01-77', requisitionValue: 90, paidValue: 0, doctor: ANA });
    const body = await byDoctor(managerA);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ doctorKey: 'crm:CRM:12345:SC', requisitionCount: 1, paidValue: 90 });
  });

  it('responsibleId deixa só os médicos cadastrados daquela carteira', async () => {
    await doctor(tenantA.id, 'Ana', '12345', repA.id);
    await doctor(tenantA.id, 'Caio', '22222', repA2.id);
    await budget(tenantA.id, { number: '1', issuedOn: '2026-11-03', requisitionValue: 100, doctor: ANA });
    await budget(tenantA.id, { number: '2', issuedOn: '2026-11-03', requisitionValue: 80, doctor: { name: 'Caio', crm: '22222' } });
    await budget(tenantA.id, { number: '3', issuedOn: '2026-11-03', requisitionValue: 60 });

    const mine = await byDoctor(managerA, `${PERIOD}&responsibleId=${repA.id}`);
    expect(mine.rows.map((r) => r.doctorName)).toEqual(['Dra. Ana Souza']);
    expect(mine.totals.requisitionValue).toBe(100);
  });

  it('filtro de convênio é o mesmo do summary', async () => {
    await budget(tenantA.id, { number: '1', issuedOn: '2026-11-03', requisitionValue: 100, doctor: ANA, insurance: 'UNIMED' });
    await budget(tenantA.id, { number: '2', issuedOn: '2026-11-03', requisitionValue: 80, doctor: ANA });
    const insurance = await db.withoutTenant((tx) =>
      tx.query<{ id: string }>(`INSERT INTO insurances (tenant_id, name, type) VALUES ($1, 'UNIMED', 'outro') RETURNING id`, [tenantA.id]),
    );
    const insuranceId = insurance.rows[0]?.id as string;
    await db.withoutTenant((tx) =>
      tx.query(`UPDATE lis_budgets SET insurance_id = $1 WHERE number = '1'`, [insuranceId]),
    );
    const body = await byDoctor(managerA, `${PERIOD}&insuranceId=${insuranceId}`);
    expect(body.totals.requisitionValue).toBe(100);
  });

  it('atendente -> 403; representante -> 403 (Resultados é gestor+)', async () => {
    for (const user of [attendantA, repA]) {
      const res = await app.agent.get(`/api/v1/lis-budgets/by-doctor?${PERIOD}`).set(app.auth(user));
      expect(res.status).toBe(403);
      expect((res.body as ApiErrorBody).error.code).toBe('FORBIDDEN');
    }
  });

  it('isolamento: dado e cadastro de B não aparecem para A', async () => {
    await doctor(tenantB.id, 'Ana de B', '12345', null);
    await budget(tenantB.id, { number: '1', issuedOn: '2026-11-03', requisitionValue: 999, paidValue: 999, paidOn: '2026-11-04', doctor: ANA });
    await budget(tenantA.id, { number: '1', issuedOn: '2026-11-03', requisitionValue: 100, doctor: ANA });

    const body = await byDoctor(managerA);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ requisitionValue: 100, doctorId: null });
    expect((await byDoctor(managerB)).totals.paidValue).toBe(999);
  });
});

describe('GET /doctors/:id/revenue', () => {
  const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  it('12 meses: requisição pela emissão, recebido pelo pagamento, última requisição', async () => {
    const anaId = await doctor(tenantA.id, 'Ana', '12345', repA.id);
    await budget(tenantA.id, { number: '1', issuedOn: daysAgo(10), requisitionValue: 100, paidValue: 100, paidOn: daysAgo(8), doctor: ANA });
    await budget(tenantA.id, { number: '2', issuedOn: daysAgo(5), requisitionValue: 70, doctor: ANA });
    await budget(tenantA.id, { number: '3', issuedOn: daysAgo(500), requisitionValue: 900, paidValue: 900, paidOn: daysAgo(480), doctor: ANA });
    await budget(tenantA.id, { number: '4', issuedOn: daysAgo(5), requisitionValue: 55, doctor: { name: 'Ana CRO', council: 'CRO' } });

    const res = await app.agent.get(`/api/v1/doctors/${anaId}/revenue`).set(app.auth(managerA)).expect(200);
    const body = res.body as DoctorRevenue;
    expect(body).toMatchObject({
      matched: true,
      requisitionCount: 2,
      requisitionValue: 170,
      paidCount: 1,
      paidValue: 100,
      lastRequisitionOn: daysAgo(5),
    });
    expect(body.windowEnd > body.windowStart).toBe(true);

    // O representante dono da carteira vê; outro representante -> 404.
    await app.agent.get(`/api/v1/doctors/${anaId}/revenue`).set(app.auth(repA)).expect(200);
    const other = await app.agent.get(`/api/v1/doctors/${anaId}/revenue`).set(app.auth(repA2));
    expect(other.status).toBe(404);
    expect((other.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
  });

  it('médico sem CRM: matched false e zeros; de outro tenant -> 404', async () => {
    const semCrm = await doctor(tenantA.id, 'Sem CRM', null);
    const res = await app.agent.get(`/api/v1/doctors/${semCrm}/revenue`).set(app.auth(managerA)).expect(200);
    expect(res.body as DoctorRevenue).toMatchObject({
      matched: false, requisitionCount: 0, requisitionValue: 0, paidCount: 0, paidValue: 0, lastRequisitionOn: null,
    });
    const deB = await app.agent.get(`/api/v1/doctors/${semCrm}/revenue`).set(app.auth(managerB));
    expect(deB.status).toBe(404);
  });
});
