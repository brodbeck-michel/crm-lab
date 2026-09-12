/**
 * `/api/v1/sales` — API_CONTRACTS.md §11 (Onda 9, D-112).
 *
 * Foco: escopo por ATENDENTE (nao por papel), `SALE_ATTENDANT_NOT_LINKED`,
 * `attendantId` obrigatorio/ignorado conforme o papel, DELETE escopado e o
 * calculo de comissao de `GET /sales/summary`.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, ListSalesResponse, Sale, SalesSummary } from '@crm-lab/shared';
import { salesModule } from '../../src/controllers/sales.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const BASE = '/api/v1/sales';

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let managerA: UserRecord;
let attendantUserA: UserRecord;

async function insertAttendant(tenantId: string, name: string, userId: string | null = null) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO attendants (tenant_id, name, user_id) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, name, userId],
    ),
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('falha ao inserir atendente de teste');
  return id;
}

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [salesModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', db });
  attendantUserA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
});

describe('POST /sales — escopo por atendente (D-112)', () => {
  it('attendant sem vinculo -> SALE_ATTENDANT_NOT_LINKED', async () => {
    const res = await app.agent
      .post(BASE)
      .set(app.auth(attendantUserA))
      .send({ soldOn: '2026-08-20', value: 100, kind: 'exams' });
    expect(res.status).toBe(403);
    expect((res.body as ApiErrorBody).error.code).toBe('SALE_ATTENDANT_NOT_LINKED');
  });

  it('attendant com vinculo: attendantId resolvido pelo proprio login, mesmo se enviado outro', async () => {
    const own = await insertAttendant(tenantA.id, 'Maria', attendantUserA.id);
    const other = await insertAttendant(tenantA.id, 'Joana');

    const res = await app.agent
      .post(BASE)
      .set(app.auth(attendantUserA))
      .send({ attendantId: other, soldOn: '2026-08-20', value: 100, kind: 'exams' });
    expect(res.status).toBe(400);
    expect((res.body as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');

    const ok = await app.agent
      .post(BASE)
      .set(app.auth(attendantUserA))
      .send({ soldOn: '2026-08-20', value: 100, kind: 'exams' });
    expect(ok.status).toBe(201);
    expect((ok.body as Sale).attendantId).toBe(own);
  });

  it('manager: attendantId obrigatorio', async () => {
    const res = await app.agent
      .post(BASE)
      .set(app.auth(managerA))
      .send({ soldOn: '2026-08-20', value: 100, kind: 'exams' });
    expect(res.status).toBe(400);
    expect((res.body as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
  });

  it('manager: attendantId de outro tenant -> NOT_FOUND', async () => {
    const otherTenantAttendant = await insertAttendant(tenantB.id, 'Da B');
    const res = await app.agent
      .post(BASE)
      .set(app.auth(managerA))
      .send({ attendantId: otherTenantAttendant, soldOn: '2026-08-20', value: 100, kind: 'exams' });
    expect(res.status).toBe(404);
    expect((res.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
  });

  it('manager: cria venda para o atendente informado', async () => {
    const attendantId = await insertAttendant(tenantA.id, 'Maria');
    const res = await app.agent
      .post(BASE)
      .set(app.auth(managerA))
      .send({ attendantId, soldOn: '2026-08-20', value: 340, exams: 'Hemograma', kind: 'exams' });
    expect(res.status).toBe(201);
    const body = res.body as Sale;
    expect(body.attendantId).toBe(attendantId);
    expect(body.value).toBe(340);
    expect(body.kind).toBe('exams');
  });

  it('value <= 0 -> VALIDATION_ERROR', async () => {
    const attendantId = await insertAttendant(tenantA.id, 'Maria');
    const res = await app.agent
      .post(BASE)
      .set(app.auth(managerA))
      .send({ attendantId, soldOn: '2026-08-20', value: 0, kind: 'exams' });
    expect(res.status).toBe(400);
  });

  it('soldOn futura -> VALIDATION_ERROR', async () => {
    const attendantId = await insertAttendant(tenantA.id, 'Maria');
    const future = new Date(Date.now() + 86_400_000 * 30).toISOString().slice(0, 10);
    const res = await app.agent
      .post(BASE)
      .set(app.auth(managerA))
      .send({ attendantId, soldOn: future, value: 100, kind: 'exams' });
    expect(res.status).toBe(400);
  });
});

describe('GET /sales — escopo', () => {
  it('attendant so ve as proprias vendas; manager ve todas', async () => {
    const ownId = await insertAttendant(tenantA.id, 'Propria', attendantUserA.id);
    const otherId = await insertAttendant(tenantA.id, 'Outra');
    await app.agent
      .post(BASE)
      .set(app.auth(attendantUserA))
      .send({ soldOn: '2026-08-20', value: 100, kind: 'exams' })
      .expect(201);
    await app.agent
      .post(BASE)
      .set(app.auth(managerA))
      .send({ attendantId: otherId, soldOn: '2026-08-20', value: 200, kind: 'checkup' })
      .expect(201);

    const asAttendant = await app.agent.get(BASE).set(app.auth(attendantUserA));
    const attendantBody = asAttendant.body as ListSalesResponse;
    expect(attendantBody.sales).toHaveLength(1);
    expect(attendantBody.sales[0]?.attendantId).toBe(ownId);

    const asManager = await app.agent.get(BASE).set(app.auth(managerA));
    expect((asManager.body as ListSalesResponse).sales).toHaveLength(2);
  });

  it('attendant sem vinculo recebe lista vazia (nunca erro)', async () => {
    const res = await app.agent.get(BASE).set(app.auth(attendantUserA));
    expect(res.status).toBe(200);
    expect((res.body as ListSalesResponse).sales).toEqual([]);
  });
});

describe('DELETE /sales/:id — escopo', () => {
  it('manager nao apaga venda de OUTRO TENANT (NOT_FOUND, isolamento multitenant)', async () => {
    const attendantB = await insertAttendant(tenantB.id, 'Da B');
    const adminB = await createUser({ tenantId: tenantB.id, role: 'admin', db });
    const created = await app.agent
      .post(BASE)
      .set(app.auth(adminB))
      .send({ attendantId: attendantB, soldOn: '2026-08-20', value: 250, kind: 'exams' });
    const id = (created.body as Sale).id;

    const res = await app.agent.delete(`${BASE}/${id}`).set(app.auth(managerA));
    expect(res.status).toBe(404);
    expect((res.body as ApiErrorBody).error.code).toBe('NOT_FOUND');

    // a venda do tenant B continua intacta, nunca apagada por engano
    const stillThere = await app.agent.get(BASE).set(app.auth(adminB));
    expect((stillThere.body as ListSalesResponse).sales).toHaveLength(1);
  });

  it('attendant nao apaga venda de outro atendente (NOT_FOUND)', async () => {
    await insertAttendant(tenantA.id, 'Propria', attendantUserA.id);
    const otherId = await insertAttendant(tenantA.id, 'Outra');
    const created = await app.agent
      .post(BASE)
      .set(app.auth(managerA))
      .send({ attendantId: otherId, soldOn: '2026-08-20', value: 100, kind: 'exams' });
    const id = (created.body as Sale).id;

    const res = await app.agent.delete(`${BASE}/${id}`).set(app.auth(attendantUserA));
    expect(res.status).toBe(404);
  });

  it('attendant apaga a propria venda', async () => {
    await insertAttendant(tenantA.id, 'Propria', attendantUserA.id);
    const created = await app.agent
      .post(BASE)
      .set(app.auth(attendantUserA))
      .send({ soldOn: '2026-08-20', value: 100, kind: 'exams' });
    const id = (created.body as Sale).id;

    const res = await app.agent.delete(`${BASE}/${id}`).set(app.auth(attendantUserA));
    expect(res.status).toBe(204);

    const list = await app.agent.get(BASE).set(app.auth(managerA));
    expect((list.body as ListSalesResponse).sales).toHaveLength(0);
  });
});

describe('GET /sales/summary — comissao (defaults 1,50% exames / 1,50% check-up)', () => {
  it('agrupa por kind e soma a comissao', async () => {
    const attendantId = await insertAttendant(tenantA.id, 'Maria');
    await app.agent
      .post(BASE)
      .set(app.auth(managerA))
      .send({ attendantId, soldOn: '2026-08-10', value: 1000, kind: 'exams' })
      .expect(201);
    await app.agent
      .post(BASE)
      .set(app.auth(managerA))
      .send({ attendantId, soldOn: '2026-08-15', value: 500, kind: 'checkup' })
      .expect(201);

    const res = await app.agent
      .get(`${BASE}/summary?startDate=2026-08-01&endDate=2026-08-31`)
      .set(app.auth(managerA));
    expect(res.status).toBe(200);
    const body = res.body as SalesSummary;
    expect(body.byKind.exams).toEqual({ count: 1, value: 1000, commissionValue: 15 });
    expect(body.byKind.checkup).toEqual({ count: 1, value: 500, commissionValue: 7.5 });
    expect(body.totalValue).toBe(1500);
    expect(body.commissionTotal).toBe(22.5);
  });
});

describe('GET /sales/summary — byAttendant (D-122, "Detalhe por atendente" de /results)', () => {
  it('manager sem attendantId na query recebe o detalhe por atendente', async () => {
    const maria = await insertAttendant(tenantA.id, 'Maria');
    const joao = await insertAttendant(tenantA.id, 'Joao');
    await app.agent
      .post(BASE)
      .set(app.auth(managerA))
      .send({ attendantId: maria, soldOn: '2026-08-10', value: 1000, kind: 'exams' })
      .expect(201);
    await app.agent
      .post(BASE)
      .set(app.auth(managerA))
      .send({ attendantId: joao, soldOn: '2026-08-12', value: 200, kind: 'checkup' })
      .expect(201);

    const res = await app.agent
      .get(`${BASE}/summary?startDate=2026-08-01&endDate=2026-08-31`)
      .set(app.auth(managerA));
    const body = res.body as SalesSummary;

    expect(body.byAttendant).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attendantId: maria,
          attendantName: 'Maria',
          totalValue: 1000,
          commissionTotal: 15,
        }),
        expect.objectContaining({
          attendantId: joao,
          attendantName: 'Joao',
          totalValue: 200,
          commissionTotal: 3,
        }),
      ]),
    );
  });

  it('attendant nao recebe byAttendant (so ve a propria comissao)', async () => {
    const maria = await insertAttendant(tenantA.id, 'Maria', attendantUserA.id);
    await app.agent
      .post(BASE)
      .set(app.auth(attendantUserA))
      .send({ attendantId: maria, soldOn: '2026-08-10', value: 1000, kind: 'exams' })
      .expect(201);

    const res = await app.agent
      .get(`${BASE}/summary?startDate=2026-08-01&endDate=2026-08-31`)
      .set(app.auth(attendantUserA));
    const body = res.body as SalesSummary;

    expect(body.byAttendant).toBeUndefined();
  });
});
