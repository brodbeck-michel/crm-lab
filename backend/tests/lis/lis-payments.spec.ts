/**
 * Extrato de pagamentos do LIS e releitura diaria (CRMLAB-53, D-188/D-189).
 *
 * Os casos com numero de orcamento sao os reais que o Bitlab explicou em
 * 28/09/2026 (estorno), com os valores e IDs da consulta feita pela VPS.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import type {
  BitlabBudgetsPage,
  BitlabBudgetsQuery,
  BitlabClient,
} from '../../src/lib/bitlab-client.js';
import { MemoryCache, createCache } from '../../src/lib/cache.js';
import type { LisSpreadsheetRow } from '../../src/lib/lis-spreadsheet.js';
import { noopWsHub } from '../../src/lib/ws-hub.js';
import { createLisSyncServiceFromDeps } from '../../src/controllers/lis-sync.routes.js';
import { createAuditService } from '../../src/services/audit.service.js';
import {
  createLisImportService,
  type LisImportService,
} from '../../src/services/lis-import.service.js';
import { resetLisSyncLocksForTest } from '../../src/services/lis-sync.service.js';
import { encryptSecret } from '../../src/lib/secret-box.js';
import { createTenant, type TenantRecord } from '../helpers/factories.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

function budget(number: string, overrides: Partial<LisSpreadsheetRow> = {}): LisSpreadsheetRow {
  return {
    number,
    issuedOn: '2026-06-30',
    patientName: `Paciente ${number}`,
    insurance1: 'PARTICULAR',
    value1: 1000,
    insurance2: null,
    value2: null,
    insurance3: null,
    value3: null,
    attendantName: null,
    insuranceAverage: 1000,
    requisitionNumber: `01-${number}`,
    requisitionValue: null,
    paidValue: null,
    paidOn: null,
    ...overrides,
  };
}

/** Uma linha de pagamento da API, como `toLisRow` devolve (D-188). */
function payment(
  number: string,
  requisitionValue: number,
  id: string,
  value: number,
  paidAt: string,
  reversedAt: string | null = null,
): LisSpreadsheetRow {
  return budget(number, {
    requisitionValue,
    paidValue: value,
    paidOn: paidAt.slice(0, 10),
    paidAt,
    paymentId: id,
    paymentStatus: reversedAt ? 'estornado' : 'ativo',
    reversedAt,
  });
}

let db: DbClient;
let lis: LisImportService;
let tenant: TenantRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  lis = createLisImportService({
    db,
    cache: new MemoryCache(),
    audit: createAuditService(db),
    wsHub: noopWsHub,
  });
  tenant = await createTenant({ db });
});

async function sync(rows: LisSpreadsheetRow[]) {
  return lis.ingestRows({ tenantId: tenant.id, createdBy: null }, rows, { kind: 'sync' });
}

async function sheet(rows: LisSpreadsheetRow[]) {
  return lis.ingestRows({ tenantId: tenant.id, createdBy: null }, rows, {
    kind: 'import',
    fileName: 'x.xlsx',
  });
}

async function paid(
  number: string,
): Promise<{ paid_value: number | null; paid_on: string | null }> {
  const result = await db.withTenant(tenant.id, (tx) =>
    tx.query<{ paid_value: number | null; paid_on: string | null }>(
      `SELECT paid_value::float8 AS paid_value, to_char(paid_on, 'YYYY-MM-DD') AS paid_on
         FROM lis_budgets WHERE number = $1`,
      [number],
    ),
  );
  return result.rows[0] ?? { paid_value: null, paid_on: null };
}

describe('recebido = soma dos pagamentos ativos (D-188)', () => {
  it('66760: 0 e 528,26 estornados, 100 + 428,26 ativos -> 528,26', async () => {
    await sync([
      payment('66760', 528.26, '68642', 0, '2026-06-30 07:44:15', '2026-06-30 16:39:04'),
      payment('66760', 528.26, '68643', 528.26, '2026-06-30 07:44:16', '2026-06-30 16:39:05'),
      payment('66760', 528.26, '68675', 100, '2026-06-30 16:39:43'),
      payment('66760', 528.26, '68676', 428.26, '2026-06-30 16:39:44'),
    ]);
    expect(await paid('66760')).toEqual({ paid_value: 528.26, paid_on: '2026-06-30' });
  });

  it('parcela em rodadas separadas (maior primeiro, depois menor) soma, nao substitui', async () => {
    await sync([payment('66210', 676.24, '67806', 637.96, '2026-05-28 08:17:18')]);
    await sync([payment('66210', 676.24, '68041', 38.28, '2026-06-05 11:21:37')]);
    expect(await paid('66210')).toEqual({ paid_value: 676.24, paid_on: '2026-06-05' });
  });

  it('68905: lido ativo numa rodada e estornado noutra sai da soma (releitura)', async () => {
    await sync([payment('68905', 783.55, '69948', 854.17, '2026-08-14 07:24:26')]);
    // teto na requisicao enquanto o estorno nao chega
    expect(await paid('68905')).toEqual({ paid_value: 783.55, paid_on: '2026-08-14' });

    await sync([
      payment('68905', 783.55, '69948', 854.17, '2026-08-14 07:24:26', '2026-08-19 10:37:25'),
      payment('68905', 783.55, '70070', 783.55, '2026-08-19 10:38:07'),
    ]);
    expect(await paid('68905')).toEqual({ paid_value: 783.55, paid_on: '2026-08-19' });
    const rows = await db.withTenant(tenant.id, (tx) =>
      tx.query<{ payment_key: string; status: string }>(
        'SELECT payment_key, status FROM lis_budget_payments WHERE budget_number = $1 ORDER BY payment_key',
        ['68905'],
      ),
    );
    expect(rows.rows).toEqual([
      { payment_key: '69948', status: 'estornado' },
      { payment_key: '70070', status: 'ativo' },
    ]);
  });

  it('68281: linha ativa de 0 depois de paga nao zera o pago', async () => {
    await sync([payment('68281', 476.39, '69525', 467.68, '2026-07-31 07:44:05')]);
    await sync([payment('68281', 476.39, '69956', 0, '2026-08-14 10:09:05')]);
    expect((await paid('68281')).paid_value).toBe(467.68);
  });

  it('so estornos: recebido 0 e sem data de pagamento', async () => {
    await sync([payment('1', 100, '9', 100, '2026-06-08 11:14:17', '2026-06-09 08:10:27')]);
    expect(await paid('1')).toEqual({ paid_value: 0, paid_on: null });
  });

  it('mesma rodada duas vezes nao muda nada (idempotente)', async () => {
    const rows = [
      payment('68785', 837.47, '69905', 111.47, '2026-08-12 14:22:54'),
      payment('68785', 837.47, '70185', 726, '2026-08-24 09:28:32'),
    ];
    await sync(rows);
    await sync(rows);
    expect(await paid('68785')).toEqual({ paid_value: 837.47, paid_on: '2026-08-24' });
    const count = await db.withTenant(tenant.id, (tx) =>
      tx.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM lis_budget_payments'),
    );
    expect(count.rows[0]?.n).toBe(2);
  });

  it('planilha e depois API do mesmo orcamento: vale so a API', async () => {
    await sheet([budget('7', { requisitionValue: 500, paidValue: 300, paidOn: '2026-08-01' })]);
    expect((await paid('7')).paid_value).toBe(300);
    await sync([payment('7', 500, '100', 250, '2026-08-01 09:00:00')]);
    expect((await paid('7')).paid_value).toBe(250);
  });

  it('so planilha: soma tudo com teto na requisicao', async () => {
    await sheet([
      budget('8', {
        requisitionValue: 293.96,
        paidValue: 293.96,
        paidOn: '2026-06-01',
        paidAt: '2026-06-01 07:38:00',
      }),
      budget('8', {
        requisitionValue: 293.96,
        paidValue: 293.96,
        paidOn: '2026-06-01',
        paidAt: '2026-06-01 07:42:00',
      }),
    ]);
    expect((await paid('8')).paid_value).toBe(293.96);
  });

  it('orcamento pago de carga anterior, sem extrato, nao e tocado', async () => {
    await sync([budget('9')]);
    await db.withTenant(tenant.id, (tx) =>
      tx.query("UPDATE lis_budgets SET paid_value = 80, paid_on = '2026-05-01' WHERE number = '9'"),
    );
    await sync([budget('9')]);
    expect(await paid('9')).toEqual({ paid_value: 80, paid_on: '2026-05-01' });
  });
});

describe('releitura diaria (D-189)', () => {
  class RecordingBitlab implements BitlabClient {
    calls: BitlabBudgetsQuery[] = [];
    watermark = '2026-09-28 10:00:00';
    fetchBudgetsPage(_apiKey: string, query: BitlabBudgetsQuery): Promise<BitlabBudgetsPage> {
      this.calls.push(query);
      return Promise.resolve({
        rows: [],
        hasNext: false,
        watermark: this.watermark,
        deprecationNotices: [],
      });
    }
  }

  let bitlab: RecordingBitlab;
  let clock: Date;

  beforeEach(async () => {
    resetLisSyncLocksForTest();
    process.env.CHANNEL_SECRET_KEY = 'chave-de-teste-com-mais-de-32-caracteres-000';
    bitlab = new RecordingBitlab();
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO lis_sync_settings (tenant_id, enabled, api_key, watermark)
         VALUES ($1, true, $2, '2026-09-28 09:00:00')`,
        [tenant.id, encryptSecret('chave')],
      ),
    );
  });

  function service() {
    return createLisSyncServiceFromDeps(
      { db, cache: createCache(), wsHub: noopWsHub },
      { bitlab, now: () => clock },
    );
  }

  async function settings() {
    const result = await db.withoutTenant((tx) =>
      tx.query<{ watermark: string; last_full_scan_on: string | null }>(
        `SELECT watermark, to_char(last_full_scan_on, 'YYYY-MM-DD') AS last_full_scan_on
           FROM lis_sync_settings WHERE tenant_id = $1`,
        [tenant.id],
      ),
    );
    return result.rows[0];
  }

  it('antes das 03:00 e incremental; depois, uma releitura de 90 dias por dia', async () => {
    clock = new Date('2026-09-28T05:30:00Z'); // 02:30 em Brasilia
    await service().runScheduledTick();
    expect(bitlab.calls.at(-1)?.dataInicio).toBe('2026-09-28 09:00:00');

    clock = new Date('2026-09-28T06:10:00Z'); // 03:10
    await service().runScheduledTick();
    expect(bitlab.calls.at(-1)?.dataInicio).toBe('2026-06-30 00:00:00');
    expect((await settings())?.last_full_scan_on).toBe('2026-09-28');

    clock = new Date('2026-09-28T06:12:00Z'); // proximo tique, mesmo dia
    await service().runScheduledTick();
    expect(bitlab.calls.at(-1)?.dataInicio).toBe('2026-09-28 10:00:00');
  });

  it('a releitura nao recua a marca', async () => {
    bitlab.watermark = '2026-07-01 08:00:00';
    clock = new Date('2026-09-28T06:10:00Z');
    await service().runScheduledTick();
    expect((await settings())?.watermark).toBe('2026-09-28 09:00:00');
  });

  it('releitura com erro nao grava o dia: o proximo tique tenta de novo', async () => {
    const failing: BitlabClient = {
      fetchBudgetsPage: () => Promise.reject(new Error('rede')),
    };
    clock = new Date('2026-09-28T06:10:00Z');
    await createLisSyncServiceFromDeps(
      { db, cache: createCache(), wsHub: noopWsHub },
      { bitlab: failing, now: () => clock },
    ).runScheduledTick();
    expect((await settings())?.last_full_scan_on).toBeNull();

    clock = new Date('2026-09-28T06:12:00Z');
    await service().runScheduledTick();
    expect(bitlab.calls.at(-1)?.dataInicio).toBe('2026-06-30 00:00:00');
  });
});
