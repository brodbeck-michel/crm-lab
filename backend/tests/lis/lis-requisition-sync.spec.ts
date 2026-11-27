/**
 * Requisicoes do Bitlab — SERVICES.md §24.2, API_CONTRACTS.md §10.3 (CRMLAB-200, D-338).
 *
 * O Bitlab e um cliente falso com respostas por janela: nenhuma rede. O que se prova aqui:
 *  - carga inicial um dia por vez (`emissao`), gravando o progresso dia a dia e continuando de
 *    onde parou depois de uma falha; a marca vira a hora em que a carga comecou;
 *  - incremental (`alteracao`) em janelas de ate 1 dia, com cursor, marca e substituicao da
 *    requisicao (pagamentos inclusive) e exclusao das `requisicoesExcluidas`;
 *  - 429 espera e tenta de novo; `auth` grava o erro e NAO desliga os orcamentos;
 *  - agendador nos horarios; rota 202, papeis, CONFLICT e isolamento.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, LisIntegrationSettings } from '@crm-lab/shared';
import { createLisRequisitionSyncServiceFromDeps, makeLisSyncModule } from '../../src/controllers/lis-sync.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { BitlabError } from '../../src/lib/bitlab-client.js';
import type {
  BitlabRequisitionsClient,
  BitlabRequisitionsPage,
  BitlabRequisitionsQuery,
  LisRequisitionRow,
} from '../../src/lib/bitlab-requisitions-client.js';
import { encryptSecret } from '../../src/lib/secret-box.js';
import {
  latestDueSlot,
  resetLisRequisitionLocksForTest,
} from '../../src/services/lis-requisition-sync.service.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const BASE = '/api/v1/settings/lis-integration';
const KEY = 'chave-de-teste-requisicoes-1234';
/** 05/01/2026 12:00 em Brasilia (15:00 UTC). */
const NOW = new Date('2026-01-05T15:00:00.000Z');

function req(number: string, overrides: Partial<LisRequisitionRow> = {}): LisRequisitionRow {
  return {
    number,
    requestedAt: '2026-01-02 09:00:00',
    requestedOn: '2026-01-02',
    budgetNumber: null,
    insuranceCode: '1',
    insuranceName: 'PARTICULAR',
    insuranceType: 'Particular',
    attendantName: null,
    requestingDoctorName: 'Dra. Ana',
    requestingDoctorCouncil: 'CRM',
    requestingDoctorCrm: '12345',
    requestingDoctorUf: 'SC',
    patientValue: 100,
    insuranceValue: 0,
    paidValue: 100,
    changedAt: '2026-01-02 09:00:00',
    payments: [
      { paymentKey: '1', paidAt: '2026-01-02 09:05:00', paidOn: '2026-01-02', paidValue: 100, status: 'ativo', paymentMethod: 'PIX' },
    ],
    ...overrides,
  };
}

function page(rows: LisRequisitionRow[], extra: Partial<BitlabRequisitionsPage> = {}): BitlabRequisitionsPage {
  return { rows, excluded: [], hasNext: false, nextCursor: null, watermark: null, ...extra };
}

/** Bitlab falso: resposta por `tipoData|dataInicio|cursor`, ou erro roteirizado. */
class FakeBitlab implements BitlabRequisitionsClient {
  calls: Array<{ apiKey: string; query: BitlabRequisitionsQuery }> = [];
  responses = new Map<string, BitlabRequisitionsPage>();
  errors: BitlabError[] = [];
  failOn: string | null = null;

  key(q: Pick<BitlabRequisitionsQuery, 'tipoData' | 'dataInicio' | 'cursor'>): string {
    return `${q.tipoData}|${q.dataInicio}|${q.cursor ?? ''}`;
  }

  fetchRequisitionsPage(apiKey: string, query: BitlabRequisitionsQuery): Promise<BitlabRequisitionsPage> {
    this.calls.push({ apiKey, query });
    const k = this.key(query);
    if (this.failOn === k) return Promise.reject(new BitlabError('unavailable', 'HTTP 500'));
    const err = this.errors.shift();
    if (err) return Promise.reject(err);
    return Promise.resolve(this.responses.get(k) ?? page([]));
  }
}

let db: DbClient;
let app: TestApp;
let bitlab: FakeBitlab;
let clock: Date;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let managerA: UserRecord;
let attendantA: UserRecord;
let managerB: UserRecord;

const noWait = { sleep: () => Promise.resolve(), callGapMs: 0, retryWaitMs: 0 };

function service() {
  return createLisRequisitionSyncServiceFromDeps({ db }, { bitlabRequisitions: bitlab, now: () => clock, requisitionTiming: noWait });
}

async function enable(tenantId: string, extra: Record<string, unknown> = {}): Promise<void> {
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO lis_sync_settings (tenant_id, enabled, api_key, requisitions_watermark, requisitions_cursor)
       VALUES ($1, true, $2, $3, $4)`,
      [tenantId, encryptSecret(KEY), extra.watermark ?? null, extra.cursor ?? null],
    ),
  );
}

async function state(tenantId: string) {
  const r = await db.withoutTenant((tx) =>
    tx.query<{
      enabled: boolean;
      requisitions_watermark: string | null;
      requisitions_cursor: string | null;
      next_day: string | null;
      requisitions_last_error: string | null;
    }>(
      `SELECT enabled, requisitions_watermark, requisitions_cursor,
              to_char(requisitions_load_next_day, 'YYYY-MM-DD') AS next_day, requisitions_last_error
         FROM lis_sync_settings WHERE tenant_id = $1`,
      [tenantId],
    ),
  );
  return r.rows[0];
}

async function requisitionsOf(tenantId: string) {
  const r = await db.withTenant(tenantId, (tx) =>
    tx.query<{ number: string; total: number; payments: number; insurance_id: string | null }>(
      `SELECT r.number, r.total_value::float8 AS total, r.insurance_id,
              (SELECT COUNT(*)::int FROM lis_requisition_payments p WHERE p.requisition_id = r.id) AS payments
         FROM lis_requisitions r ORDER BY r.number`,
    ),
  );
  return r.rows;
}

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  resetLisRequisitionLocksForTest();
  process.env.CHANNEL_SECRET_KEY = 'chave-de-teste-com-mais-de-32-caracteres-000';
  bitlab = new FakeBitlab();
  clock = NOW;
  app = await createTestApp({
    db,
    modules: [makeLisSyncModule({ bitlabRequisitions: bitlab, now: () => clock, requisitionTiming: noWait })],
  });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', db });
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
  managerB = await createUser({ tenantId: tenantB.id, role: 'manager', db });
});

afterEach(() => {
  delete process.env.CHANNEL_SECRET_KEY;
});

describe('carga inicial (emissao, um dia por vez)', () => {
  it('le de LIS_REQUISITIONS_SINCE ate hoje, grava, e a marca vira o inicio da carga', async () => {
    await enable(tenantA.id);
    bitlab.responses.set('emissao|2026-01-02 00:00:00|', page([req('01-1'), req('01-2', { insuranceName: 'UNIMED', patientValue: 0, insuranceValue: 80, payments: [] })]));
    bitlab.responses.set('emissao|2026-01-04 00:00:00|', page([req('01-3')], { hasNext: true, nextCursor: 'c1' }));
    bitlab.responses.set('emissao|2026-01-04 00:00:00|c1', page([req('01-4')]));

    await service().runForTenant(tenantA.id);

    // 01/01 a 05/01 = 5 dias, mais a 2a pagina do dia 04.
    expect(bitlab.calls.map((c) => `${c.query.tipoData}|${c.query.dataInicio}|${c.query.dataFim}|${c.query.cursor ?? ''}`)).toEqual([
      'emissao|2026-01-01 00:00:00|2026-01-01 23:59:59|',
      'emissao|2026-01-02 00:00:00|2026-01-02 23:59:59|',
      'emissao|2026-01-03 00:00:00|2026-01-03 23:59:59|',
      'emissao|2026-01-04 00:00:00|2026-01-04 23:59:59|',
      'emissao|2026-01-04 00:00:00|2026-01-04 23:59:59|c1',
      'emissao|2026-01-05 00:00:00|2026-01-05 23:59:59|',
    ]);
    expect(bitlab.calls.every((c) => c.apiKey === KEY)).toBe(true);
    const rows = await requisitionsOf(tenantA.id);
    expect(rows.map((r) => [r.number, r.total, r.payments])).toEqual([
      ['01-1', 100, 1],
      ['01-2', 80, 0],
      ['01-3', 100, 1],
      ['01-4', 100, 1],
    ]);
    // UNIMED foi criado e resolvido; PARTICULAR fica null (§11.4).
    expect(rows[0]?.insurance_id).toBeNull();
    expect(rows[1]?.insurance_id).toEqual(expect.any(String));
    expect(await state(tenantA.id)).toMatchObject({
      requisitions_watermark: '2026-01-05 12:00:00',
      next_day: null,
      requisitions_last_error: null,
    });
  });

  it('falha no meio: o que entrou fica e a proxima rodada continua do dia que falhou', async () => {
    await enable(tenantA.id);
    bitlab.responses.set('emissao|2026-01-02 00:00:00|', page([req('01-1')]));
    bitlab.failOn = 'emissao|2026-01-03 00:00:00|';

    await service().runForTenant(tenantA.id);
    expect(await state(tenantA.id)).toMatchObject({ requisitions_watermark: null, next_day: '2026-01-03' });
    expect((await state(tenantA.id))?.requisitions_last_error).toMatch(/não respondeu/);
    expect((await requisitionsOf(tenantA.id)).map((r) => r.number)).toEqual(['01-1']);

    const status = (await app.agent.get(BASE).set(app.auth(managerA)).expect(200)).body as LisIntegrationSettings;
    expect(status.requisitions).toMatchObject({
      initialLoad: { since: '2026-01-01', nextDay: '2026-01-03', done: false },
      total: 1,
    });

    bitlab.failOn = null;
    bitlab.calls = [];
    clock = new Date('2026-01-05T16:00:00.000Z');
    await service().runForTenant(tenantA.id);
    expect(bitlab.calls[0]?.query.dataInicio).toBe('2026-01-03 00:00:00');
    // A marca e o inicio da carga (da 1a rodada), nao o fim.
    expect(await state(tenantA.id)).toMatchObject({ requisitions_watermark: '2026-01-05 12:00:00', next_day: null, requisitions_last_error: null });
  });

  it('429 espera e tenta de novo a mesma chamada', async () => {
    await enable(tenantA.id);
    bitlab.errors = [new BitlabError('unavailable', 'HTTP 429')];
    bitlab.responses.set('emissao|2026-01-01 00:00:00|', page([req('01-1')]));
    await service().runForTenant(tenantA.id);
    expect(bitlab.calls[0]?.query.dataInicio).toBe('2026-01-01 00:00:00');
    expect(bitlab.calls[1]?.query.dataInicio).toBe('2026-01-01 00:00:00');
    expect((await requisitionsOf(tenantA.id)).map((r) => r.number)).toEqual(['01-1']);
  });
});

describe('incremental (alteracao)', () => {
  it('janelas de ate 1 dia com cursor; substitui pagamentos e apaga excluidas', async () => {
    await enable(tenantA.id, { watermark: '2026-01-03 10:00:00', cursor: 'c0' });
    await db.withoutTenant(async (tx) => {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO lis_requisitions (tenant_id, number, patient_value) VALUES ($1, '01-1', 50), ($1, '01-9', 10) RETURNING id`,
        [tenantA.id],
      );
      await tx.query(
        `INSERT INTO lis_requisition_payments (tenant_id, requisition_id, payment_key, paid_value, status)
         VALUES ($1, $2, 'antigo', 50, 'ativo')`,
        [tenantA.id, r.rows[0]?.id],
      );
    });
    bitlab.responses.set(
      'alteracao|2026-01-03 10:00:00|c0',
      page([req('01-1', { patientValue: 120, payments: [] })], { excluded: ['01-9'], nextCursor: 'c1', watermark: '2026-01-04 08:00:00' }),
    );
    bitlab.responses.set(
      'alteracao|2026-01-04 09:59:59|c1',
      page([req('01-2')], { nextCursor: 'c2', watermark: '2026-01-05 11:30:00' }),
    );

    await service().runForTenant(tenantA.id);

    expect(bitlab.calls.map((c) => `${c.query.dataInicio}|${c.query.dataFim}|${c.query.cursor ?? ''}`)).toEqual([
      '2026-01-03 10:00:00|2026-01-04 09:59:59|c0',
      '2026-01-04 09:59:59|2026-01-05 09:59:58|c1',
      '2026-01-05 09:59:58|2026-01-05 12:00:00|c2',
    ]);
    const rows = await requisitionsOf(tenantA.id);
    expect(rows.map((r) => [r.number, r.total, r.payments])).toEqual([
      ['01-1', 120, 0],
      ['01-2', 100, 1],
    ]);
    // Ultima janela veio vazia: marca fica no inicio dela, cursor no ultimo nao vazio.
    expect(await state(tenantA.id)).toMatchObject({ requisitions_watermark: '2026-01-05 09:59:58', requisitions_cursor: 'c2' });
  });

  it('a ultima janela leva a marca para a marcaDagua devolvida', async () => {
    await enable(tenantA.id, { watermark: '2026-01-05 07:00:00' });
    bitlab.responses.set('alteracao|2026-01-05 07:00:00|', page([req('01-5')], { watermark: '2026-01-05 11:58:00', nextCursor: 'cx' }));
    await service().runForTenant(tenantA.id);
    expect(await state(tenantA.id)).toMatchObject({ requisitions_watermark: '2026-01-05 11:58:00', requisitions_cursor: 'cx' });
  });

  it('chave recusada: grava o erro e NAO desliga a sincronizacao de orcamentos', async () => {
    await enable(tenantA.id, { watermark: '2026-01-05 07:00:00' });
    bitlab.errors = [new BitlabError('auth', 'HTTP 401')];
    await service().runForTenant(tenantA.id);
    const s = await state(tenantA.id);
    expect(s?.enabled).toBe(true);
    expect(s?.requisitions_last_error).toMatch(/recusou a chave/);
    expect(s?.requisitions_watermark).toBe('2026-01-05 07:00:00');
  });
});

describe('agendador (07:00 e 13:00 de Brasilia)', () => {
  it('latestDueSlot: horario mais recente que ja passou hoje', () => {
    expect(latestDueSlot(new Date('2026-01-05T09:59:00Z'), ['07:00', '13:00'])).toBeNull(); // 06:59
    expect(latestDueSlot(new Date('2026-01-05T10:00:00Z'), ['07:00', '13:00'])?.toISOString()).toBe('2026-01-05T10:00:00.000Z');
    expect(latestDueSlot(new Date('2026-01-05T17:30:00Z'), ['07:00', '13:00'])?.toISOString()).toBe('2026-01-05T16:00:00.000Z');
  });

  it('roda uma vez por horario e so para quem esta ligado', async () => {
    await enable(tenantA.id, { watermark: '2026-01-05 07:00:00' });
    clock = new Date('2026-01-05T10:05:00Z'); // 07:05
    const svc = service();
    await svc.runScheduledTick();
    expect(bitlab.calls).toHaveLength(1);
    await svc.runScheduledTick(); // mesmo horario: ja rodou
    expect(bitlab.calls).toHaveLength(1);
    clock = new Date('2026-01-05T16:01:00Z'); // 13:01
    await svc.runScheduledTick();
    expect(bitlab.calls).toHaveLength(2);
  });
});

describe('POST /settings/lis-integration/requisitions/sync', () => {
  it('202 na hora, com running; audit; depois a rodada termina', async () => {
    await enable(tenantA.id, { watermark: '2026-01-05 07:00:00' });
    bitlab.responses.set('alteracao|2026-01-05 07:00:00|', page([req('01-7')], { watermark: '2026-01-05 11:00:00' }));
    const res = await app.agent.post(`${BASE}/requisitions/sync`).set(app.auth(managerA));
    expect(res.status).toBe(202);
    const body = res.body as LisIntegrationSettings;
    expect(body.requisitions.running).toBe(true);
    expect(body.requisitions.scheduleTimes).toEqual(expect.any(Array));

    for (let i = 0; i < 50 && (await requisitionsOf(tenantA.id)).length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((await requisitionsOf(tenantA.id)).map((r) => r.number)).toEqual(['01-7']);
    const audit = await db.withoutTenant((tx) =>
      tx.query(`SELECT 1 FROM audit_logs WHERE action = 'run_lis_requisitions_sync' AND tenant_id = $1`, [tenantA.id]),
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('desligada -> 409 lis_sync_not_configured; atendente -> 403', async () => {
    const off = await app.agent.post(`${BASE}/requisitions/sync`).set(app.auth(managerA));
    expect(off.status).toBe(409);
    expect((off.body as ApiErrorBody).error.details).toMatchObject({ reason: 'lis_sync_not_configured' });
    const denied = await app.agent.post(`${BASE}/requisitions/sync`).set(app.auth(attendantA));
    expect(denied.status).toBe(403);
  });

  it('isolamento: a rodada de A nao toca B, e B nao ve as requisicoes de A', async () => {
    await enable(tenantA.id, { watermark: '2026-01-05 07:00:00' });
    bitlab.responses.set('alteracao|2026-01-05 07:00:00|', page([req('01-7')]));
    await service().runForTenant(tenantA.id);
    expect(await requisitionsOf(tenantB.id)).toEqual([]);
    const b = (await app.agent.get(BASE).set(app.auth(managerB)).expect(200)).body as LisIntegrationSettings;
    expect(b.requisitions).toMatchObject({ total: 0, watermark: null, initialLoad: { done: false } });
  });
});
