/**
 * Faturamento por médico solicitante — CRMLAB-198 (D-336), fonte trocada na CRMLAB-200 (D-338).
 *
 *  - `GET /lis-budgets/by-doctor`: lê `lis_requisitions` (todas as requisições, com ou sem
 *    orçamento). Requisição pela data da requisição (valor = paciente + convênio), recebido pelos
 *    pagamentos ativos do paciente; chave do médico (identificado / coringa / sem médico); vínculo
 *    por CRM + UF só no conselho CRM; filtro de representante e de convênio; papéis e isolamento;
 *  - `GET /doctors/:id/revenue`: 12 meses, `matched: false` sem CRM, escopo da carteira.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiErrorBody,
  DoctorRevenue,
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
  requestedOn: string;
  patientValue?: number;
  insuranceValue?: number;
  budgetNumber?: string | null;
  payments?: Array<{ on: string; value: number; status?: 'ativo' | 'estornado' }>;
  doctor?: { name: string; council?: string | null; crm?: string | null; uf?: string | null } | null;
  insuranceId?: string | null;
}

async function requisition(tenantId: string, seed: Seed): Promise<void> {
  await db.withoutTenant(async (tx) => {
    const d = seed.doctor ?? null;
    const r = await tx.query<{ id: string }>(
      `INSERT INTO lis_requisitions (tenant_id, number, requested_at, requested_on, budget_number,
         insurance_id, patient_value, insurance_value, requesting_doctor_name,
         requesting_doctor_council, requesting_doctor_crm, requesting_doctor_uf)
       VALUES ($1, $2, ($3::date)::timestamp, $3::date, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        tenantId,
        seed.number,
        seed.requestedOn,
        seed.budgetNumber ?? null,
        seed.insuranceId ?? null,
        seed.patientValue ?? 0,
        seed.insuranceValue ?? 0,
        d?.name ?? null,
        d ? (d.council === undefined ? 'CRM' : d.council) : null,
        d ? (d.crm === undefined ? '12345' : d.crm) : null,
        d ? (d.uf === undefined ? 'SC' : d.uf) : null,
      ],
    );
    for (const [i, p] of (seed.payments ?? []).entries()) {
      await tx.query(
        `INSERT INTO lis_requisition_payments (tenant_id, requisition_id, payment_key, paid_on, paid_value, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, r.rows[0]?.id, String(i + 1), p.on, p.value, p.status ?? 'ativo'],
      );
    }
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
  it('duas janelas, valor = paciente + convênio, chaves do médico e vínculo pelo CRM', async () => {
    const anaId = await doctor(tenantA.id, 'Ana Souza (cadastro)', '12345', repA.id);
    // Ana: particular pago no período; convênio puro (sem orçamento, sem pagamento); pago no
    // período mas requisitada antes; um estorno que não conta.
    await requisition(tenantA.id, { number: '01-1', requestedOn: '2026-11-03', patientValue: 100, budgetNumber: '1', payments: [{ on: '2026-11-05', value: 100 }], doctor: ANA });
    await requisition(tenantA.id, { number: '01-2', requestedOn: '2026-11-10', insuranceValue: 250, doctor: ANA });
    await requisition(tenantA.id, { number: '01-3', requestedOn: '2026-10-20', patientValue: 50, payments: [{ on: '2026-11-02', value: 50 }], doctor: ANA });
    await requisition(tenantA.id, { number: '01-4', requestedOn: '2026-11-11', patientValue: 30, insuranceValue: 40, payments: [{ on: '2026-11-11', value: 30, status: 'estornado' }], doctor: ANA });
    // CRN com o mesmo número: outro conselho, outra linha, sem vínculo.
    await requisition(tenantA.id, { number: '01-5', requestedOn: '2026-11-11', patientValue: 40, payments: [{ on: '2026-11-12', value: 40 }], doctor: { name: 'Nutri Bia', council: 'CRN' } });
    // CRM "1": coringa do Bitlab, uma linha só, nomes diferentes.
    await requisition(tenantA.id, { number: '01-6', requestedOn: '2026-11-12', patientValue: 30, payments: [{ on: '2026-11-13', value: 30 }], doctor: { name: 'Coringa X', crm: '1' } });
    await requisition(tenantA.id, { number: '01-7', requestedOn: '2026-11-13', patientValue: 20, payments: [{ on: '2026-11-14', value: 20 }], doctor: { name: 'Enf. Carla', crm: '1' } });
    // Sem médico.
    await requisition(tenantA.id, { number: '01-8', requestedOn: '2026-11-14', patientValue: 10, payments: [{ on: '2026-11-15', value: 10 }] });
    // Fora do período.
    await requisition(tenantA.id, { number: '01-9', requestedOn: '2026-12-01', patientValue: 999, doctor: ANA });

    const body = await byDoctor(managerA);
    expect(body.period).toEqual({ startDate: '2026-11-01', endDate: '2026-11-30' });
    expect(body.rows).toEqual([
      {
        doctorKey: 'crm:CRM:12345:SC', doctorName: 'Dra. Ana Souza', council: 'CRM', crm: '12345', uf: 'SC',
        identified: true, doctorId: anaId, responsibleName: 'Fátima',
        requisitionCount: 3, requisitionValue: 420, paidCount: 2, paidValue: 150,
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
    expect(body.totals).toEqual({ requisitionCount: 7, requisitionValue: 520, paidCount: 6, paidValue: 250 });
  });

  it('ordem: valor em requisição antes do recebido (D-338 item 4)', async () => {
    await requisition(tenantA.id, { number: '01-1', requestedOn: '2026-11-03', patientValue: 100, payments: [{ on: '2026-11-03', value: 100 }], doctor: ANA });
    await requisition(tenantA.id, { number: '01-2', requestedOn: '2026-11-03', insuranceValue: 500, doctor: { name: 'Caio', crm: '22222' } });
    const body = await byDoctor(managerA);
    expect(body.rows.map((r) => r.doctorName)).toEqual(['Caio', 'Dra. Ana Souza']);
  });

  it('responsibleId deixa só os médicos cadastrados daquela carteira', async () => {
    await doctor(tenantA.id, 'Ana', '12345', repA.id);
    await doctor(tenantA.id, 'Caio', '22222', repA2.id);
    await requisition(tenantA.id, { number: '01-1', requestedOn: '2026-11-03', patientValue: 100, doctor: ANA });
    await requisition(tenantA.id, { number: '01-2', requestedOn: '2026-11-03', patientValue: 80, doctor: { name: 'Caio', crm: '22222' } });
    await requisition(tenantA.id, { number: '01-3', requestedOn: '2026-11-03', patientValue: 60 });

    const mine = await byDoctor(managerA, `${PERIOD}&responsibleId=${repA.id}`);
    expect(mine.rows.map((r) => r.doctorName)).toEqual(['Dra. Ana Souza']);
    expect(mine.totals.requisitionValue).toBe(100);
  });

  it('filtro de convênio vale sobre o convênio da requisição', async () => {
    const insurance = await db.withoutTenant((tx) =>
      tx.query<{ id: string }>(`INSERT INTO insurances (tenant_id, name, type) VALUES ($1, 'UNIMED', 'outro') RETURNING id`, [tenantA.id]),
    );
    const insuranceId = insurance.rows[0]?.id as string;
    await requisition(tenantA.id, { number: '01-1', requestedOn: '2026-11-03', insuranceValue: 100, doctor: ANA, insuranceId });
    await requisition(tenantA.id, { number: '01-2', requestedOn: '2026-11-03', patientValue: 80, doctor: ANA });
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
    await requisition(tenantB.id, { number: '01-1', requestedOn: '2026-11-03', patientValue: 999, payments: [{ on: '2026-11-04', value: 999 }], doctor: ANA });
    await requisition(tenantA.id, { number: '01-1', requestedOn: '2026-11-03', patientValue: 100, doctor: ANA });

    const body = await byDoctor(managerA);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ requisitionValue: 100, doctorId: null });
    expect((await byDoctor(managerB)).totals.paidValue).toBe(999);
  });
});

describe('GET /doctors/:id/revenue', () => {
  const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  it('12 meses: requisição pela data dela, recebido pelo pagamento, última requisição', async () => {
    const anaId = await doctor(tenantA.id, 'Ana', '12345', repA.id);
    await requisition(tenantA.id, { number: '01-1', requestedOn: daysAgo(10), patientValue: 100, payments: [{ on: daysAgo(8), value: 100 }], doctor: ANA });
    await requisition(tenantA.id, { number: '01-2', requestedOn: daysAgo(5), insuranceValue: 70, doctor: ANA });
    await requisition(tenantA.id, { number: '01-3', requestedOn: daysAgo(500), patientValue: 900, payments: [{ on: daysAgo(480), value: 900 }], doctor: ANA });
    await requisition(tenantA.id, { number: '01-4', requestedOn: daysAgo(5), patientValue: 55, doctor: { name: 'Ana CRO', council: 'CRO' } });

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
