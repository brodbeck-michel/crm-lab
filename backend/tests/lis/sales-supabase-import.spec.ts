/**
 * Carga das vendas dos dois Supabases (CRMLAB-45, D-179/D-180) com dados
 * sinteticos em PGlite: dedupe por id, conflito por updated_at, atendente
 * criado/casado sem acento, tipo exames->exams, valor <= 0 rejeitado,
 * idempotencia, dry-run, tenant inexistente recusado e isolamento de tenant.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import {
  TenantNotFoundError,
  centsToDecimal,
  foldAttendantName,
  formatSalesImportReport,
  importSales,
  mergeSources,
  parityWindows,
  parseTimestamp,
  parseVendasCsv,
  reportToJson,
  resolveTenant,
  toCents,
  type ParsedSource,
} from '../../src/services/sales-supabase-import.service.js';
import { createTenant, createUser, type TenantRecord } from '../helpers/factories.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const HEADER = 'id,atendente,data_venda,codigo,valor,exames,tipo,created_by,created_at,updated_at';
const TODAY = '2026-09-25';

interface VendaInput {
  id?: string;
  atendente?: string;
  data_venda?: string;
  codigo?: string;
  valor?: string;
  exames?: string;
  tipo?: string;
  created_by?: string;
  created_at?: string;
  updated_at?: string;
}

function venda(v: VendaInput = {}): Required<VendaInput> {
  return {
    id: v.id ?? randomUUID(),
    atendente: v.atendente ?? 'Maria Souza',
    data_venda: v.data_venda ?? '2026-09-10',
    codigo: v.codigo ?? 'V-1',
    valor: v.valor ?? '100.00',
    exames: v.exames ?? 'Hemograma, Glicose',
    tipo: v.tipo ?? 'exames',
    created_by: v.created_by ?? '',
    created_at: v.created_at ?? '2026-09-10 12:00:00.123456+00',
    updated_at: v.updated_at ?? '2026-09-10 12:00:00.123456+00',
  };
}

const quote = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

function csv(rows: Array<Required<VendaInput>>): string {
  const body = rows.map((r) =>
    [
      r.id,
      r.atendente,
      r.data_venda,
      r.codigo,
      r.valor,
      r.exames,
      r.tipo,
      r.created_by,
      r.created_at,
      r.updated_at,
    ]
      .map(quote)
      .join(','),
  );
  return `\uFEFF${[HEADER, ...body].join('\r\n')}\r\n`;
}

const fx = (rows: Array<Required<VendaInput>>): ParsedSource =>
  parseVendasCsv(csv(rows), 'fluxolab');
const lv = (rows: Array<Required<VendaInput>>): ParsedSource =>
  parseVendasCsv(csv(rows), 'lovable');

let db: DbClient;
let tenant: TenantRecord;
let other: TenantRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  tenant = await createTenant({ name: 'Sante', slug: 'sante', db });
  other = await createTenant({ name: 'Outro Lab', slug: 'outro', db });
});

interface StoredSale {
  id: string;
  attendant: string;
  sold_on: string;
  code: string | null;
  value: string;
  exams: string | null;
  kind: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

async function storedSales(tenantId: string): Promise<StoredSale[]> {
  const result = await db.withTenant(tenantId, (tx) =>
    tx.query<StoredSale>(
      `SELECT s.id, a.name AS attendant, to_char(s.sold_on, 'YYYY-MM-DD') AS sold_on, s.code,
              s.value::text AS value, s.exams, s.kind, s.created_by,
              to_char(s.created_at, 'YYYY-MM-DD HH24:MI:SS.US') AS created_at,
              to_char(s.updated_at, 'YYYY-MM-DD HH24:MI:SS.US') AS updated_at
         FROM sales s JOIN attendants a ON a.id = s.attendant_id
        ORDER BY s.id`,
    ),
  );
  return result.rows;
}

async function attendantNames(tenantId: string): Promise<string[]> {
  const result = await db.withTenant(tenantId, (tx) =>
    tx.query<{ name: string }>('SELECT name FROM attendants ORDER BY name'),
  );
  return result.rows.map((r) => r.name);
}

async function createAttendant(tenantId: string, name: string): Promise<string> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      'INSERT INTO attendants (tenant_id, name) VALUES ($1, $2) RETURNING id',
      [tenantId, name],
    ),
  );
  return result.rows[0]!.id;
}

function run(fluxolab: ParsedSource, lovable: ParsedSource, dryRun = false, tenantId = tenant.id) {
  return importSales(db, { tenantId, fluxolab, lovable, dryRun, today: TODAY });
}

describe('conversoes puras', () => {
  it('centavos inteiros, sem float', () => {
    expect(toCents('0.1')).toBe(10);
    expect(toCents('1234.56')).toBe(123456);
    expect(toCents('10')).toBe(1000);
    expect(toCents('-5.00')).toBe(-500);
    expect(toCents('1.234')).toBeNull();
    expect(toCents('1,50')).toBeNull();
    expect(toCents('abc')).toBeNull();
    expect(centsToDecimal(123456)).toBe('1234.56');
    expect(centsToDecimal(5)).toBe('0.05');
  });

  it('timestamptz do export vira UTC com microssegundos', () => {
    expect(parseTimestamp('2026-06-04 19:53:44.123456+00')).toBe('2026-06-04 19:53:44.123456');
    expect(parseTimestamp('2026-06-04T16:53:44.5-03:00')).toBe('2026-06-04 19:53:44.500000');
    expect(parseTimestamp('2026-06-04T19:53:44Z')).toBe('2026-06-04 19:53:44.000000');
    expect(parseTimestamp('2026-02-30 10:00:00+00')).toBeNull();
    expect(parseTimestamp('ontem')).toBeNull();
  });

  it('dobra de atendente ignora acento, caixa e espacos', () => {
    expect(foldAttendantName('  José   da  SILVA ')).toBe('jose da silva');
  });

  it('janelas de paridade: mes anterior atravessando o ano', () => {
    expect(parityWindows('2026-01-15')).toEqual([
      { label: 'mes_anterior', start: '2025-12-01', end: '2025-12-31' },
      { label: 'mes_corrente', start: '2026-01-01', end: '2026-01-31' },
      { label: 'tudo', start: null, end: null },
    ]);
  });
});

describe('parseVendasCsv', () => {
  it('valida linha a linha e rejeita com motivo (nunca em silencio)', () => {
    const parsed = fx([
      venda({ valor: '0' }),
      venda({ valor: '-10.00' }),
      venda({ id: 'nao-e-uuid' }),
      venda({ data_venda: '2026-13-01' }),
      venda({ valor: 'dez' }),
      venda({ tipo: 'outro' }),
      venda({ atendente: '   ' }),
      venda({ updated_at: '' }),
      venda(),
    ]);
    expect(parsed.read).toBe(9);
    expect(parsed.rows).toHaveLength(1);
    const reasons = parsed.rejected.map((r) => r.reason);
    expect(reasons[0]).toMatch(/valor <= 0/);
    expect(reasons[1]).toMatch(/valor <= 0/);
    expect(reasons[2]).toMatch(/id invalido/);
    expect(reasons[3]).toMatch(/data_venda invalida/);
    expect(reasons[4]).toMatch(/valor invalido/);
    expect(reasons[5]).toMatch(/tipo invalido/);
    expect(reasons[6]).toMatch(/atendente vazio/);
    expect(reasons[7]).toMatch(/updated_at invalido/);
    expect(parsed.rejected[0]).toMatchObject({ source: 'fluxolab', line: 2 });
  });

  it('tipo exames -> exams e checkup -> checkup; campos opcionais vazios -> null', () => {
    const parsed = fx([
      venda({ tipo: 'exames', codigo: '', exames: '' }),
      venda({ tipo: 'checkup' }),
    ]);
    expect(parsed.rows.map((r) => r.kind)).toEqual(['exams', 'checkup']);
    expect(parsed.rows[0]).toMatchObject({ code: null, exams: null });
  });

  it('cabecalho sem coluna obrigatoria: erro do arquivo', () => {
    expect(() => parseVendasCsv('id,atendente\n', 'lovable')).toThrow(/data_venda/);
  });
});

describe('mergeSources (D-179)', () => {
  it('uniao por id: identica nas duas bases nao e conflito', () => {
    const shared = venda();
    const merged = mergeSources(fx([shared, venda()]).rows, lv([shared, venda()]).rows);
    expect(merged.rows).toHaveLength(3);
    expect(merged).toMatchObject({ inBoth: 1, onlyFluxolab: 1, onlyLovable: 1, conflicts: [] });
  });

  it('conflito: vence o updated_at mais recente, mesmo vindo do Lovable', () => {
    const id = randomUUID();
    const merged = mergeSources(
      fx([venda({ id, valor: '100.00', updated_at: '2026-09-10 12:00:00+00' })]).rows,
      lv([venda({ id, valor: '150.00', updated_at: '2026-09-11 08:00:00+00' })]).rows,
    );
    expect(merged.rows[0]).toMatchObject({ source: 'lovable', cents: 15000 });
    expect(merged.conflicts).toEqual([
      expect.objectContaining({ id, winner: 'lovable', loser: 'fluxolab', fields: ['valor'] }),
    ]);
  });

  it('empate de updated_at com conteudo diferente: vence o FluxoLab e reporta', () => {
    const id = randomUUID();
    const merged = mergeSources(
      fx([venda({ id, exames: 'A' })]).rows,
      lv([venda({ id, exames: 'B' })]).rows,
    );
    expect(merged.rows[0]).toMatchObject({ source: 'fluxolab', exams: 'A' });
    expect(merged.conflicts[0]).toMatchObject({ winner: 'fluxolab', fields: ['exames'] });
  });
});

describe('importSales — gravacao', () => {
  it('grava a uniao preservando id, timestamps e mapeando os campos', async () => {
    const shared = venda({ atendente: 'Ana', valor: '80.50', tipo: 'checkup', codigo: 'C9' });
    const onlyFx = venda({ atendente: 'Bruno', created_at: '2026-08-01 09:00:00-03' });
    const onlyLv = venda({ atendente: 'Ana' });
    const report = await run(fx([shared, onlyFx]), lv([shared, onlyLv]));

    expect(report).toMatchObject({
      dryRun: false,
      read: { fluxolab: 2, lovable: 2 },
      inBoth: 1,
      onlyFluxolab: 1,
      onlyLovable: 1,
      inserted: 3,
      updated: 0,
      unchanged: 0,
      conflicts: [],
      rejected: [],
    });
    expect(report.attendantsCreated.sort()).toEqual(['Ana', 'Bruno']);

    const rows = await storedSales(tenant.id);
    expect(rows).toHaveLength(3);
    const s = rows.find((r) => r.id === shared.id)!;
    expect(s).toMatchObject({
      attendant: 'Ana',
      sold_on: '2026-09-10',
      code: 'C9',
      value: '80.50',
      kind: 'checkup',
      created_by: null,
      created_at: '2026-09-10 12:00:00.123456',
      updated_at: '2026-09-10 12:00:00.123456',
    });
    expect(rows.find((r) => r.id === onlyFx.id)?.created_at).toBe('2026-08-01 12:00:00.000000');
  });

  it('atendente existente e casado sem acento/caixa; inexistente e criado', async () => {
    await createAttendant(tenant.id, 'José da Silva');
    const report = await run(
      fx([venda({ atendente: 'jose  DA silva' }), venda({ atendente: 'Carla Nova' })]),
      lv([]),
    );
    expect(report.attendantsCreated).toEqual(['Carla Nova']);
    expect(await attendantNames(tenant.id)).toEqual(['Carla Nova', 'José da Silva']);
  });

  it('created_by: mantem usuario do tenant, zera usuario inexistente ou de outro tenant', async () => {
    const own = await createUser({ tenantId: tenant.id, role: 'attendant', db });
    const foreign = await createUser({ tenantId: other.id, role: 'attendant', db });
    const a = venda({ created_by: own.id });
    const b = venda({ created_by: foreign.id });
    const c = venda({ created_by: randomUUID() });
    await run(fx([a, b, c]), lv([]));
    const byId = new Map((await storedSales(tenant.id)).map((r) => [r.id, r.created_by]));
    expect(byId.get(a.id)).toBe(own.id);
    expect(byId.get(b.id)).toBeNull();
    expect(byId.get(c.id)).toBeNull();
  });

  it('valor <= 0 vai para rejeitadas e nao e gravado', async () => {
    const bad = venda({ valor: '0.00' });
    const report = await run(fx([bad, venda()]), lv([]));
    expect(report.inserted).toBe(1);
    expect(report.rejected).toEqual([
      expect.objectContaining({
        source: 'fluxolab',
        id: bad.id,
        reason: expect.stringMatching(/valor <= 0/),
      }),
    ]);
    expect((await storedSales(tenant.id)).map((r) => r.id)).not.toContain(bad.id);
  });
});

describe('importSales — idempotencia e atualizacao', () => {
  it('reexecucao com os mesmos dados nao insere nem altera nada', async () => {
    const rows = [venda(), venda({ atendente: 'Bruno' })];
    const lovable = [venda()];
    await run(fx(rows), lv(lovable));
    const before = await storedSales(tenant.id);

    const second = await run(fx(rows), lv(lovable));
    expect(second).toMatchObject({ inserted: 0, updated: 0, unchanged: 3, attendantsCreated: [] });
    expect(await storedSales(tenant.id)).toEqual(before);
  });

  it('origem com updated_at mais novo atualiza preservando os timestamps da origem', async () => {
    const id = randomUUID();
    await run(fx([venda({ id, valor: '100.00' })]), lv([]));
    const report = await run(
      fx([venda({ id, valor: '120.00', updated_at: '2026-09-12 10:00:00.5+00' })]),
      lv([]),
    );
    expect(report).toMatchObject({ inserted: 0, updated: 1, unchanged: 0 });
    const [row] = await storedSales(tenant.id);
    expect(row).toMatchObject({ value: '120.00', updated_at: '2026-09-12 10:00:00.500000' });
  });

  it('venda editada no CRM depois da carga (updated_at mais novo no destino) nao e sobrescrita', async () => {
    const id = randomUUID();
    await run(fx([venda({ id })]), lv([]));
    await db.withTenant(tenant.id, (tx) =>
      tx.query('UPDATE sales SET value = 999 WHERE id = $1', [id]),
    );
    const report = await run(fx([venda({ id })]), lv([]));
    expect(report).toMatchObject({ updated: 0, unchanged: 1 });
    expect((await storedSales(tenant.id))[0]?.value).toBe('999.00');
  });
});

describe('importSales — dry-run e paridade', () => {
  it('--dry-run gera o relatorio completo sem gravar nada', async () => {
    const report = await run(fx([venda({ atendente: 'Nova' })]), lv([venda()]), true);
    expect(report).toMatchObject({ dryRun: true, inserted: 2 });
    expect([...report.attendantsCreated].sort()).toEqual(['Maria Souza', 'Nova']);
    expect(report.parity.find((w) => w.label === 'tudo')).toMatchObject({
      source: { count: 2, cents: 20000 },
      stored: { count: 2, cents: 20000 },
      matches: true,
    });
    expect(await storedSales(tenant.id)).toEqual([]);
    expect(await attendantNames(tenant.id)).toEqual([]);
  });

  it('paridade em 3 janelas e por atendente, ao centavo', async () => {
    const report = await run(
      fx([
        venda({ data_venda: '2026-08-31', valor: '0.10', atendente: 'Ana' }),
        venda({ data_venda: '2026-09-01', valor: '0.20', atendente: 'Ana' }),
        venda({ data_venda: '2025-01-01', valor: '1000.01', atendente: 'Bruno' }),
      ]),
      lv([]),
    );
    const [prev, current, all] = report.parity;
    expect(prev).toMatchObject({
      start: '2026-08-01',
      end: '2026-08-31',
      source: { count: 1, cents: 10 },
      matches: true,
    });
    expect(current).toMatchObject({
      source: { count: 1, cents: 20 },
      stored: { count: 1, cents: 20 },
      matches: true,
    });
    expect(all).toMatchObject({
      source: { count: 3, cents: 100031 },
      stored: { count: 3, cents: 100031 },
    });
    expect(report.byAttendant).toEqual([
      {
        attendant: 'Ana',
        source: { count: 2, cents: 30 },
        stored: { count: 2, cents: 30 },
        matches: true,
      },
      {
        attendant: 'Bruno',
        source: { count: 1, cents: 100001 },
        stored: { count: 1, cents: 100001 },
        matches: true,
      },
    ]);

    const text = formatSalesImportReport(report);
    expect(text).toContain('Inseridas: 3');
    expect(text).toContain('R$ 1.000,31');
    expect(JSON.parse(reportToJson(report)).parity[2].stored.value).toBe('1000.31');
  });

  it('paridade acusa divergencia quando o tenant ja tem venda fora das origens', async () => {
    await run(fx([venda()]), lv([]));
    const report = await run(fx([venda()]), lv([]));
    expect(report.parity.find((w) => w.label === 'tudo')).toMatchObject({
      source: { count: 1 },
      stored: { count: 2 },
      matches: false,
    });
  });
});

describe('tenant e isolamento', () => {
  it('resolve por slug e por uuid; tenant inexistente e recusado', async () => {
    expect(await resolveTenant(db, 'sante')).toBe(tenant.id);
    expect(await resolveTenant(db, tenant.id.toUpperCase())).toBe(tenant.id);
    await expect(resolveTenant(db, 'nao-existe')).rejects.toBeInstanceOf(TenantNotFoundError);
    await expect(resolveTenant(db, randomUUID())).rejects.toBeInstanceOf(TenantNotFoundError);
  });

  it('importSales recusa tenant inexistente sem gravar', async () => {
    await expect(run(fx([venda()]), lv([]), false, randomUUID())).rejects.toBeInstanceOf(
      TenantNotFoundError,
    );
    expect(await storedSales(tenant.id)).toEqual([]);
  });

  it('grava so no tenant indicado e reaproveita so atendentes dele', async () => {
    await createAttendant(other.id, 'Maria Souza');
    await run(fx([venda()]), lv([]));
    expect(await storedSales(other.id)).toEqual([]);
    expect(await attendantNames(tenant.id)).toEqual(['Maria Souza']);
    const otherAttendants = await attendantNames(other.id);
    expect(otherAttendants).toEqual(['Maria Souza']);
  });

  it('id ja usado por outro tenant: nao toca a linha alheia e rejeita com motivo', async () => {
    const id = randomUUID();
    await run(fx([venda({ id, valor: '50.00' })]), lv([]), false, other.id);
    const report = await run(
      fx([venda({ id, valor: '70.00', updated_at: '2026-09-20 00:00:00+00' })]),
      lv([]),
    );
    expect(report.inserted).toBe(0);
    expect(report.rejected).toEqual([
      expect.objectContaining({ id, reason: expect.stringMatching(/outro tenant/) }),
    ]);
    expect(await storedSales(tenant.id)).toEqual([]);
    expect((await storedSales(other.id))[0]?.value).toBe('50.00');
  });
});
