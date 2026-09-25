/**
 * Integracao LIS pela API do Bitlab — API_CONTRACTS.md §10.3, SERVICES.md §24
 * (CRMLAB-52, D-185/D-186).
 *
 * O Bitlab e um `BitlabClient` falso com paginas roteirizadas: nenhuma chamada
 * de rede. O que se prova aqui e o lado do CRM — chave write-only e cifrada,
 * alcada, rodada vazia sem historico, marca d'agua que so anda no sucesso,
 * chave recusada desligando, e o dado entrando pelo MESMO caminho da planilha.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, LisIntegrationSettings, LisSyncRunResult, ListLisImportsResponse } from '@crm-lab/shared';
import { lisImportModule } from '../../src/controllers/lis-import.routes.js';
import { createLisSyncServiceFromDeps, makeLisSyncModule } from '../../src/controllers/lis-sync.routes.js';
import type { DbClient } from '../../src/db/types.js';
import {
  BitlabError,
  type BitlabBudgetsPage,
  type BitlabBudgetsQuery,
  type BitlabClient,
} from '../../src/lib/bitlab-client.js';
import { createCache } from '../../src/lib/cache.js';
import type { LisSpreadsheetRow } from '../../src/lib/lis-spreadsheet.js';
import { resetLisSyncLocksForTest } from '../../src/services/lis-sync.service.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const BASE = '/api/v1/settings/lis-integration';
const KEY = 'sante_orcamento_chave-de-teste-6y6M';

function row(number: string, overrides: Partial<LisSpreadsheetRow> = {}): LisSpreadsheetRow {
  return {
    number,
    issuedOn: '2026-09-20',
    patientName: `Paciente ${number}`,
    insurance1: 'PARTICULAR',
    value1: 100,
    insurance2: null,
    value2: null,
    insurance3: null,
    value3: null,
    attendantName: null,
    insuranceAverage: 100,
    requisitionNumber: null,
    requisitionValue: null,
    paidValue: null,
    paidOn: null,
    ...overrides,
  };
}

/** Bitlab roteirizado: cada chamada consome o proximo item (pagina ou erro). */
class ScriptedBitlab implements BitlabClient {
  calls: Array<{ apiKey: string; query: BitlabBudgetsQuery }> = [];
  script: Array<BitlabBudgetsPage | BitlabError> = [];

  fetchBudgetsPage(apiKey: string, query: BitlabBudgetsQuery): Promise<BitlabBudgetsPage> {
    this.calls.push({ apiKey, query });
    const next = this.script.shift() ?? { rows: [], hasNext: false, watermark: null, deprecationNotices: [] };
    return next instanceof BitlabError ? Promise.reject(next) : Promise.resolve(next);
  }
}

function page(rows: LisSpreadsheetRow[], watermark: string | null, hasNext = false): BitlabBudgetsPage {
  return { rows, hasNext, watermark, deprecationNotices: [] };
}

let db: DbClient;
let app: TestApp;
let bitlab: ScriptedBitlab;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let adminA: UserRecord;
let managerA: UserRecord;
let attendantA: UserRecord;
let adminB: UserRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  resetLisSyncLocksForTest();
  process.env.CHANNEL_SECRET_KEY = 'chave-de-teste-com-mais-de-32-caracteres-000';
  bitlab = new ScriptedBitlab();
  app = await createTestApp({ db, modules: [makeLisSyncModule({ bitlab }), lisImportModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  adminA = await createUser({ tenantId: tenantA.id, role: 'admin', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', db });
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
  adminB = await createUser({ tenantId: tenantB.id, role: 'admin', db });
});

afterEach(() => {
  delete process.env.CHANNEL_SECRET_KEY;
});

async function configure(user: UserRecord, body: Record<string, unknown>): Promise<LisIntegrationSettings> {
  const res = await app.agent.patch(BASE).set(app.auth(user)).send(body);
  expect(res.status).toBe(200);
  return res.body as LisIntegrationSettings;
}

async function sync(user: UserRecord): Promise<LisSyncRunResult> {
  const res = await app.agent.post(`${BASE}/sync`).set(app.auth(user));
  expect(res.status).toBe(200);
  return res.body as LisSyncRunResult;
}

async function budgetsOf(tenantId: string): Promise<Array<{ number: string; paid_value: number | null }>> {
  const result = await db.withTenant(tenantId, (tx) =>
    tx.query<{ number: string; paid_value: number | null }>(
      'SELECT number, paid_value::float8 AS paid_value FROM lis_budgets ORDER BY number',
    ),
  );
  return result.rows;
}

describe('GET /settings/lis-integration', () => {
  it('sem configuracao devolve os defaults sem gravar', async () => {
    const res = await app.agent.get(BASE).set(app.auth(managerA));
    expect(res.status).toBe(200);
    expect(res.body as LisIntegrationSettings).toMatchObject({
      enabled: false,
      apiKeySet: false,
      apiKeyMasked: null,
      watermark: null,
      lastRunAt: null,
      lastError: null,
      running: false,
    });
    const count = await db.withTenant(tenantA.id, (tx) =>
      tx.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM lis_sync_settings'),
    );
    expect(count.rows[0]?.n).toBe(0);
  });

  it('atendente recebe FORBIDDEN', async () => {
    const res = await app.agent.get(BASE).set(app.auth(attendantA));
    expect(res.status).toBe(403);
    expect((res.body as ApiErrorBody).error.details).toMatchObject({ requiredRoles: ['manager', 'admin'] });
  });
});

describe('PATCH /settings/lis-integration', () => {
  it('grava a chave cifrada e so devolve a versao mascarada', async () => {
    const body = await configure(adminA, { apiKey: KEY, enabled: true });
    expect(body).toMatchObject({ enabled: true, apiKeySet: true, apiKeyMasked: '••••••••6y6M' });
    expect(JSON.stringify(body)).not.toContain(KEY);

    const stored = await db.withTenant(tenantA.id, (tx) =>
      tx.query<{ api_key: string }>('SELECT api_key FROM lis_sync_settings'),
    );
    expect(stored.rows[0]?.api_key.startsWith('enc:v1:')).toBe(true);
    expect(stored.rows[0]?.api_key).not.toContain(KEY);
  });

  it('gestor nao edita (admin apenas)', async () => {
    const res = await app.agent.patch(BASE).set(app.auth(managerA)).send({ enabled: false });
    expect(res.status).toBe(403);
    expect((res.body as ApiErrorBody).error.details).toMatchObject({ requiredRoles: ['admin'] });
  });

  it('ligar sem chave e VALIDATION_ERROR', async () => {
    const res = await app.agent.patch(BASE).set(app.auth(adminA)).send({ enabled: true });
    expect(res.status).toBe(400);
    expect((res.body as ApiErrorBody).error.details).toMatchObject({ fields: { enabled: 'requires_api_key' } });
  });

  it('chave vazia e VALIDATION_ERROR', async () => {
    const res = await app.agent.patch(BASE).set(app.auth(adminA)).send({ apiKey: '' });
    expect(res.status).toBe(400);
  });

  it('ausente preserva, null apaga e desliga', async () => {
    await configure(adminA, { apiKey: KEY, enabled: true });
    const kept = await configure(adminA, { enabled: true });
    expect(kept.apiKeySet).toBe(true);

    const cleared = await configure(adminA, { apiKey: null });
    expect(cleared).toMatchObject({ apiKeySet: false, enabled: false });
  });

  it('audita sem a chave em claro', async () => {
    await configure(adminA, { apiKey: KEY, enabled: true });
    const logs = await db.withTenant(tenantA.id, (tx) =>
      tx.query<{ new_values: unknown }>(
        "SELECT new_values FROM audit_logs WHERE action = 'update_lis_integration'",
      ),
    );
    expect(logs.rows).toHaveLength(1);
    expect(JSON.stringify(logs.rows[0]?.new_values)).toContain('[REDACTED]');
    expect(JSON.stringify(logs.rows[0]?.new_values)).not.toContain(KEY);
  });
});

describe('POST /settings/lis-integration/sync', () => {
  it('sem configuracao responde CONFLICT lis_sync_not_configured', async () => {
    const res = await app.agent.post(`${BASE}/sync`).set(app.auth(managerA));
    expect(res.status).toBe(409);
    expect((res.body as ApiErrorBody).error.details).toMatchObject({ reason: 'lis_sync_not_configured' });
    expect(bitlab.calls).toHaveLength(0);
  });

  it('percorre as paginas, grava pelo caminho da planilha e avanca a marca', async () => {
    await configure(adminA, { apiKey: KEY, enabled: true });
    bitlab.script = [
      page([row('1'), row('2')], '2026-09-25 10:00:00', true),
      page([row('3', { requisitionNumber: '001-9', paidValue: 80, paidOn: '2026-09-24' })], '2026-09-25 11:00:00'),
    ];

    const result = await sync(managerA);

    expect(result).toMatchObject({
      status: 'completed',
      received: 3,
      rowsAccepted: 3,
      watermark: '2026-09-25 11:00:00',
      error: null,
    });
    expect(result.importId).not.toBeNull();
    expect(bitlab.calls.map((c) => c.query.pagina)).toEqual([1, 2]);
    expect(bitlab.calls[0]?.apiKey).toBe(KEY);
    expect(bitlab.calls[0]?.query.dataInicio).toMatch(/^\d{4}-\d{2}-\d{2} 00:00:00$/);
    expect(await budgetsOf(tenantA.id)).toEqual([
      { number: '1', paid_value: null },
      { number: '2', paid_value: null },
      { number: '3', paid_value: 80 },
    ]);

    const history = await app.agent.get('/api/v1/lis-imports').set(app.auth(managerA));
    const imports = (history.body as ListLisImportsResponse).imports;
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ kind: 'sync', fileName: null, rowsInFile: 3, createdBy: managerA.id });
  });

  it('a proxima rodada parte da marca d agua gravada', async () => {
    await configure(adminA, { apiKey: KEY, enabled: true });
    bitlab.script = [page([row('1')], '2026-09-25 10:00:00')];
    await sync(adminA);

    bitlab.script = [page([], null)];
    await sync(adminA);

    expect(bitlab.calls[1]?.query.dataInicio).toBe('2026-09-25 10:00:00');
  });

  it('rodada vazia nao grava historico de importacao', async () => {
    await configure(adminA, { apiKey: KEY, enabled: true });
    bitlab.script = [page([], null)];

    const result = await sync(adminA);

    expect(result).toMatchObject({ status: 'completed', received: 0, importId: null });
    expect(result.settings.lastSuccessAt).not.toBeNull();
    const history = await app.agent.get('/api/v1/lis-imports').set(app.auth(adminA));
    expect((history.body as ListLisImportsResponse).imports).toHaveLength(0);
  });

  it('pagina com falha nao grava nada e nao anda a marca', async () => {
    await configure(adminA, { apiKey: KEY, enabled: true });
    bitlab.script = [page([row('1')], '2026-09-25 10:00:00')];
    await sync(adminA);

    bitlab.script = [page([row('2')], '2026-09-25 12:00:00', true), new BitlabError('unavailable', 'timeout')];
    const result = await sync(adminA);

    expect(result.status).toBe('failed');
    expect(result.error?.kind).toBe('unavailable');
    expect(result.settings).toMatchObject({ enabled: true, watermark: '2026-09-25 10:00:00' });
    expect(result.settings.lastError).toContain('não respondeu');
    expect((await budgetsOf(tenantA.id)).map((b) => b.number)).toEqual(['1']);
  });

  it('chave recusada desliga a sincronizacao e mostra o erro', async () => {
    await configure(adminA, { apiKey: KEY, enabled: true });
    bitlab.script = [new BitlabError('auth', 'HTTP 403')];

    const result = await sync(adminA);

    expect(result.status).toBe('failed');
    expect(result.error?.kind).toBe('auth');
    expect(result.settings.enabled).toBe(false);
    expect(result.settings.lastError).toContain('recusou a chave');
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('sucesso depois de erro limpa o lastError', async () => {
    await configure(adminA, { apiKey: KEY, enabled: true });
    bitlab.script = [new BitlabError('unavailable', 'HTTP 502')];
    await sync(adminA);

    bitlab.script = [page([], null)];
    const result = await sync(adminA);
    expect(result.settings.lastError).toBeNull();
  });

  it('atendente recebe FORBIDDEN', async () => {
    const res = await app.agent.post(`${BASE}/sync`).set(app.auth(attendantA));
    expect(res.status).toBe(403);
  });

  it('isolamento: a rodada de A nao grava nem le nada de B', async () => {
    await configure(adminA, { apiKey: KEY, enabled: true });
    await configure(adminB, { apiKey: 'chave-do-lab-b-0000', enabled: true });
    bitlab.script = [page([row('1')], '2026-09-25 10:00:00')];

    await sync(adminA);

    expect(bitlab.calls[0]?.apiKey).toBe(KEY);
    expect(await budgetsOf(tenantB.id)).toEqual([]);
    const settingsB = await app.agent.get(BASE).set(app.auth(adminB));
    expect((settingsB.body as LisIntegrationSettings).watermark).toBeNull();
  });
});

describe('agendador (runScheduledTick, D-186)', () => {
  it('roda so os tenants ligados e com chave, cada um com a propria chave', async () => {
    await configure(adminA, { apiKey: KEY, enabled: true });
    await configure(adminB, { apiKey: 'chave-do-lab-b-0000', enabled: false });
    bitlab.script = [page([row('9')], '2026-09-25 10:00:00')];

    const service = createLisSyncServiceFromDeps({ db, cache: createCache() }, { bitlab });
    await service.runScheduledTick();

    expect(bitlab.calls.map((c) => c.apiKey)).toEqual([KEY]);
    expect((await budgetsOf(tenantA.id)).map((b) => b.number)).toEqual(['9']);
    const history = await db.withTenant(tenantA.id, (tx) =>
      tx.query<{ created_by: string | null; kind: string }>('SELECT created_by, kind FROM lis_imports'),
    );
    expect(history.rows).toEqual([{ created_by: null, kind: 'sync' }]);
  });

  it('um tenant com erro nao impede o proximo', async () => {
    await configure(adminA, { apiKey: KEY, enabled: true });
    await configure(adminB, { apiKey: 'chave-do-lab-b-0000', enabled: true });
    const ordered = [tenantA.id, tenantB.id].sort();
    bitlab.script = [new BitlabError('unavailable', 'HTTP 502'), page([row('7')], '2026-09-25 10:00:00')];

    const service = createLisSyncServiceFromDeps({ db, cache: createCache() }, { bitlab });
    await service.runScheduledTick();

    expect(bitlab.calls).toHaveLength(2);
    expect((await budgetsOf(ordered[1] ?? '')).map((b) => b.number)).toEqual(['7']);
  });
});
