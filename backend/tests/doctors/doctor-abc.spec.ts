/**
 * Curva ABC automatica dos medicos — CRMLAB-188, D-328 item 9.
 *
 *  - `classifyAbc` (Pareto puro): casos de borda — empate, concentracao,
 *    sem venda, total zero;
 *  - `DoctorAbcService`: base = RECEBIDO no LIS dos ultimos 12 meses, das
 *    requisicoes casadas ao medico por CRM + UF (D-336 item 7); requisicao
 *    nao paga, paga fora da janela, sem medico, de outro conselho ou com CRM
 *    curto nao contam; proposta ganha nao conta mais; isolamento de tenant;
 *    agendador (`runScheduledTick`);
 *  - `POST /doctors/abc/recalculate`: gestor/admin, audit.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { classifyAbc, type ApiErrorBody, type Doctor, type DoctorAbcRecalculation } from '@crm-lab/shared';
import { doctorModule } from '../../src/controllers/doctor.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { createAuditService } from '../../src/services/audit.service.js';
import { abcWindowStart, createDoctorAbcService } from '../../src/services/doctor-abc.service.js';
import { createProposal, createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const NOW = new Date('2026-11-21T12:00:00.000Z');

function classes(values: Record<string, number>): Record<string, string> {
  return Object.fromEntries(classifyAbc(new Map(Object.entries(values))));
}

describe('classifyAbc (Pareto)', () => {
  it('A até 80% do acumulado, B até 95%, C o resto', () => {
    // total 100: a=50 (antes 0) A, b=25 (antes 50) A, c=10 (antes 75) A,
    // d=8 (antes 85) B, e=4 (antes 93) B, f=3 (antes 97) C
    expect(classes({ a: 50, b: 25, c: 10, d: 8, e: 4, f: 3 })).toEqual({
      a: 'A',
      b: 'A',
      c: 'A',
      d: 'B',
      e: 'B',
      f: 'C',
    });
  });

  it('o maior vendedor é A mesmo concentrando 90%', () => {
    expect(classes({ a: 90, b: 6, c: 4 })).toEqual({ a: 'A', b: 'B', c: 'C' });
  });

  it('empate: todos com a mesma base ficam com a mesma classe', () => {
    // 4 x 25: o primeiro do grupo tem acumulado 0 antes -> todos A.
    expect(classes({ a: 25, b: 25, c: 25, d: 25 })).toEqual({ a: 'A', b: 'A', c: 'A', d: 'A' });
    // empate na fronteira: x=80 (A); y e z = 10 cada, antes 80% -> B os dois.
    expect(classes({ x: 80, y: 10, z: 10 })).toEqual({ x: 'A', y: 'B', z: 'B' });
  });

  it('sem venda é C; laboratório sem venda nenhuma -> todos C; vazio -> vazio', () => {
    expect(classes({ a: 100, b: 0 })).toEqual({ a: 'A', b: 'C' });
    expect(classes({ a: 0, b: 0 })).toEqual({ a: 'C', b: 'C' });
    expect(classes({})).toEqual({});
  });
});

describe('janela', () => {
  it('12 meses para trás, mesmo instante', () => {
    expect(abcWindowStart(NOW).toISOString()).toBe('2025-11-21T12:00:00.000Z');
  });
});

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let managerA: UserRecord;
let adminA: UserRecord;
let attendantA: UserRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [doctorModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', db });
  adminA = await createUser({ tenantId: tenantA.id, role: 'admin', db });
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
});

let crmSeq = 1000;

/** Medico com CRM/UF unicos (o vinculo com o LIS e por CRM + UF, D-335/D-336). */
async function doctor(tenantId: string, name: string, crm: string | null = String((crmSeq += 1))): Promise<string> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      'INSERT INTO doctors (tenant_id, name, crm, crm_uf) VALUES ($1, $2, $3, $4) RETURNING id',
      [tenantId, name, crm, crm === null ? null : 'SC'],
    ),
  );
  return result.rows[0]?.id as string;
}

let reqSeq = 0;

/**
 * Requisicao do LIS paga (D-336 item 7: a base da curva e o RECEBIDO no LIS). O medico vem do
 * cadastro `doctorId` (CRM + UF dele); `null` = requisicao sem medico. `paidOn: null` = nao paga.
 */
async function sale(
  tenantId: string,
  doctorId: string | null,
  paidValue: number,
  options: { paidOn?: string | null; council?: string; crm?: string } = {},
): Promise<void> {
  reqSeq += 1;
  await db.withoutTenant(async (tx) => {
    const imp = await tx.query<{ id: string }>(
      `INSERT INTO lis_imports (tenant_id, kind, file_name, status) VALUES ($1, 'sync', NULL, 'completed') RETURNING id`,
      [tenantId],
    );
    const doc = doctorId
      ? (await tx.query<{ name: string; crm: string; crm_uf: string }>('SELECT name, crm, crm_uf FROM doctors WHERE id = $1', [doctorId])).rows[0]
      : undefined;
    const paidOn = options.paidOn === undefined ? '2026-10-01' : options.paidOn;
    await tx.query(
      `INSERT INTO lis_budgets (tenant_id, number, issued_on, insurance_1, value_1, requisition_number,
         requisition_value, paid_value, paid_on, import_id, requesting_doctor_name, requesting_doctor_council,
         requesting_doctor_crm, requesting_doctor_uf)
       VALUES ($1, $2, '2026-09-01', 'PARTICULAR', $3, $4, $3, $5, $6, $7, $8, $9, $10, $11)`,
      [
        tenantId,
        `ORC-${reqSeq}`,
        paidValue,
        `01-${reqSeq}`,
        paidOn === null ? null : paidValue,
        paidOn,
        imp.rows[0]?.id,
        doc?.name ?? null,
        doc ? (options.council ?? 'CRM') : null,
        doc ? (options.crm ?? doc.crm) : null,
        doc?.crm_uf ?? null,
      ],
    );
  });
}

async function abcOf(id: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ abc_class: string | null; abc_base_value: string | null; abc_calculated_at: Date | null }>(
      'SELECT abc_class, abc_base_value, abc_calculated_at FROM doctors WHERE id = $1',
      [id],
    ),
  );
  const row = result.rows[0];
  return { cls: row?.abc_class ?? null, base: row?.abc_base_value === null ? null : Number(row?.abc_base_value) };
}

function service() {
  return createDoctorAbcService({ db, audit: createAuditService(db) });
}

describe('DoctorAbcService.recalculateTenant', () => {
  it('base = recebido no LIS dos últimos 12 meses (D-336); resto não conta', async () => {
    const top = await doctor(tenantA.id, 'Dr. Top');
    const mid = await doctor(tenantA.id, 'Dr. Mid');
    const none = await doctor(tenantA.id, 'Dr. Sem venda');
    const noCrm = await doctor(tenantA.id, 'Dr. Sem CRM', null);
    await sale(tenantA.id, top, 800);
    await sale(tenantA.id, top, 100.5);
    await sale(tenantA.id, mid, 99.5);
    // não contam: não paga, paga fora da janela, sem médico, outro conselho, proposta ganha
    await sale(tenantA.id, mid, 5000, { paidOn: null });
    await sale(tenantA.id, mid, 5000, { paidOn: '2025-11-01' });
    await sale(tenantA.id, null, 5000);
    await sale(tenantA.id, mid, 5000, { council: 'CRO' });
    const proposal = await createProposal({ tenantId: tenantA.id, status: 'ganho', totalPrice: 9000, db });
    await db.withoutTenant((tx) =>
      tx.query('UPDATE proposals SET doctor_id = $2, closed_at = now() WHERE id = $1', [proposal.id, none]),
    );

    const result = await service().recalculateTenant(tenantA.id, NOW);
    expect(result).toEqual({
      calculatedAt: NOW.toISOString(),
      windowStart: '2025-11-21T12:00:00.000Z',
      doctors: 4,
      counts: { A: 1, B: 1, C: 2 },
    });
    expect(await abcOf(top)).toEqual({ cls: 'A', base: 900.5 });
    // antes dele: 900.5 / 1000 = 90% -> B
    expect(await abcOf(mid)).toEqual({ cls: 'B', base: 99.5 });
    expect(await abcOf(none)).toEqual({ cls: 'C', base: 0 });
    expect(await abcOf(noCrm)).toEqual({ cls: 'C', base: 0 });
  });

  it('CRM curto (provisório, CRM "1" do Bitlab) não casa com o cadastro', async () => {
    const one = await doctor(tenantA.id, 'Dr. Um', '1');
    await sale(tenantA.id, one, 300);
    await service().recalculateTenant(tenantA.id, NOW);
    expect(await abcOf(one)).toEqual({ cls: 'C', base: 0 });
  });

  it('empate na base dá a mesma classe', async () => {
    const a = await doctor(tenantA.id, 'Dr. A');
    const b = await doctor(tenantA.id, 'Dr. B');
    await sale(tenantA.id, a, 500);
    await sale(tenantA.id, b, 500);
    await service().recalculateTenant(tenantA.id, NOW);
    expect((await abcOf(a)).cls).toBe('A');
    expect((await abcOf(b)).cls).toBe('A');
  });

  it('laboratório sem vendas: todos C com base 0', async () => {
    const a = await doctor(tenantA.id, 'Dr. A');
    const result = await service().recalculateTenant(tenantA.id, NOW);
    expect(result.counts).toEqual({ A: 0, B: 0, C: 1 });
    expect(await abcOf(a)).toEqual({ cls: 'C', base: 0 });
  });

  it('isolamento: o cálculo de A não olha nem grava B', async () => {
    const a = await doctor(tenantA.id, 'Dr. A');
    const b = await doctor(tenantB.id, 'Dr. B');
    await sale(tenantA.id, a, 100);
    await sale(tenantB.id, b, 1_000_000);
    const result = await service().recalculateTenant(tenantA.id, NOW);
    expect(result.doctors).toBe(1);
    expect(await abcOf(a)).toEqual({ cls: 'A', base: 100 });
    expect(await abcOf(b)).toEqual({ cls: null, base: null });
  });

  it('agendador calcula todo laboratório com médico', async () => {
    const a = await doctor(tenantA.id, 'Dr. A');
    const b = await doctor(tenantB.id, 'Dr. B');
    await sale(tenantB.id, b, 10);
    await service().runScheduledTick(NOW);
    expect(await abcOf(a)).toEqual({ cls: 'C', base: 0 });
    expect(await abcOf(b)).toEqual({ cls: 'A', base: 10 });
  });
});

describe('POST /doctors/abc/recalculate', () => {
  it('gestor e admin recalculam (com audit); atendente -> 403', async () => {
    const a = await doctor(tenantA.id, 'Dr. A');
    await sale(tenantA.id, a, 250);

    const res = await app.agent.post('/api/v1/doctors/abc/recalculate').set(app.auth(managerA)).expect(200);
    expect(res.body as DoctorAbcRecalculation).toMatchObject({ doctors: 1, counts: { A: 1, B: 0, C: 0 } });
    await app.agent.post('/api/v1/doctors/abc/recalculate').set(app.auth(adminA)).expect(200);

    const denied = await app.agent.post('/api/v1/doctors/abc/recalculate').set(app.auth(attendantA));
    expect(denied.status).toBe(403);
    expect((denied.body as ApiErrorBody).error.code).toBe('FORBIDDEN');

    // Atendente nao ve a ficha (D-329): quem le e o gestor.
    const doc = await app.agent.get(`/api/v1/doctors/${a}`).set(app.auth(managerA)).expect(200);
    expect(doc.body as Doctor).toMatchObject({ abcClass: 'A', abcBaseValue: 250 });
    expect((doc.body as Doctor).abcCalculatedAt).toEqual(expect.any(String));

    const audit = await db.withoutTenant((tx) =>
      tx.query<{ action: string; entity_id: string }>(
        `SELECT action, entity_id FROM audit_logs WHERE action = 'recalculate_doctor_abc'`,
      ),
    );
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows[0]?.entity_id).toBe(tenantA.id);
  });
});
