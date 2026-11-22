/**
 * Curva ABC automatica dos medicos — CRMLAB-188, D-328 item 9.
 *
 *  - `classifyAbc` (Pareto puro): casos de borda — empate, concentracao,
 *    sem venda, total zero;
 *  - `DoctorAbcService`: base = propostas `ganho` dos ultimos 12 meses por
 *    `doctor_id`; outros estagios, venda velha e proposta sem medico nao
 *    contam; isolamento de tenant; agendador (`runScheduledTick`);
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

async function doctor(tenantId: string, name: string): Promise<string> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>('INSERT INTO doctors (tenant_id, name) VALUES ($1, $2) RETURNING id', [tenantId, name]),
  );
  return result.rows[0]?.id as string;
}

/** Proposta com medico, estagio, total e data de fechamento. */
async function sale(
  tenantId: string,
  doctorId: string | null,
  totalPrice: number,
  options: { status?: string; closedAt?: string } = {},
): Promise<void> {
  const status = options.status ?? 'ganho';
  const proposal = await createProposal({
    tenantId,
    status: status as 'ganho',
    totalPrice,
    db,
  });
  await db.withoutTenant((tx) =>
    tx.query('UPDATE proposals SET doctor_id = $2, closed_at = $3::timestamp WHERE id = $1', [
      proposal.id,
      doctorId,
      options.closedAt ?? '2026-10-01T10:00:00Z',
    ]),
  );
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
  it('base = propostas ganho dos últimos 12 meses; resto não conta', async () => {
    const top = await doctor(tenantA.id, 'Dr. Top');
    const mid = await doctor(tenantA.id, 'Dr. Mid');
    const none = await doctor(tenantA.id, 'Dr. Sem venda');
    await sale(tenantA.id, top, 800);
    await sale(tenantA.id, top, 100.5);
    await sale(tenantA.id, mid, 99.5);
    // não contam: perdida, aberta, fora da janela, sem médico
    await sale(tenantA.id, mid, 5000, { status: 'perdido' });
    await sale(tenantA.id, mid, 5000, { status: 'negociacao' });
    await sale(tenantA.id, mid, 5000, { closedAt: '2025-11-01T00:00:00Z' });
    await sale(tenantA.id, null, 5000);

    const result = await service().recalculateTenant(tenantA.id, NOW);
    expect(result).toEqual({
      calculatedAt: NOW.toISOString(),
      windowStart: '2025-11-21T12:00:00.000Z',
      doctors: 3,
      counts: { A: 1, B: 1, C: 1 },
    });
    expect(await abcOf(top)).toEqual({ cls: 'A', base: 900.5 });
    // antes dele: 900.5 / 1000 = 90% -> B
    expect(await abcOf(mid)).toEqual({ cls: 'B', base: 99.5 });
    expect(await abcOf(none)).toEqual({ cls: 'C', base: 0 });
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
