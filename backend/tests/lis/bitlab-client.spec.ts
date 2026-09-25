/**
 * Cliente da API de Orcamentos do Bitlab — SERVICES.md §24.1 (CRMLAB-52).
 *
 * Respostas gravadas do manual de 25/09/2026 e dos comportamentos observados na
 * sandbox de 18/09 (envelope em array, numero como string, 403 em texto do
 * n8n). Nenhuma chamada de rede: `fetchImpl` falso.
 */
import { describe, expect, it } from 'vitest';
import {
  bitlabDateToIsoDate,
  createBitlabClient,
  saoPauloDateTime,
  watermarkToBitlabDateTime,
  type BitlabError,
} from '../../src/lib/bitlab-client.js';

const QUERY = { dataInicio: '2026-09-01 00:00:00', dataFim: '2026-09-30 23:59:59', pagina: 1, tamanhoPagina: 100 };

const BUDGET = {
  ORCAMENTO: 1234,
  DATA_ORÇAMENTO: '2026-09-15T10:22:00.000Z',
  NM_PACIENTE: 'FULANO DE TAL',
  DT_NASCIMENTO: '1980-05-10T00:00:00.000Z',
  ID_CPF: '12345678900',
  CONVENIO1: 'PARTICULAR',
  VL_TOTAL1: 250.0,
  CONVENIO2: null,
  VL_TOTAL2: null,
  CONVENIO3: null,
  VL_TOTAL3: null,
  MEDIA_CONVENIO: 250.0,
  QTD_EXAMES: 5,
  USUÁRIO: 'RECEPCAO01',
  REQUISICAO: '001-0009876',
  CONVENIO_REQUISICAO: 'PARTICULAR',
  VALOR_REQUISICAO: 250.0,
  Valor_Pago: 100.0,
  Data_Pagamento: '2026-09-28T14:05:00.000Z',
  CONTA_NULO: 1,
};

function listResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sucesso: true,
    apiVersao: 'v1',
    status: 'LISTA',
    avisos: [],
    filtro: { dataInicio: '2026-09-01 00:00:00', dataFim: '2026-09-30 23:59:59', tipoData: 'alteracao' },
    paginacao: { pagina: 1, tamanhoPagina: 100, totalRegistros: 1, totalPaginas: 1, temProxima: false },
    marcaDagua: '2026-09-30T18:22:00.000Z',
    total: 1,
    orcamentos: [BUDGET],
    ...overrides,
  };
}

interface Captured {
  url: string;
  init: RequestInit;
}

function fakeFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
  captured: Captured[] = [],
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers });
  }) as typeof fetch;
}

function client(fetchImpl: typeof fetch) {
  return createBitlabClient({ baseUrl: 'https://bitlab.test/webhook/', fetchImpl, timeoutMs: 1000 });
}

async function failure(promise: Promise<unknown>): Promise<BitlabError> {
  try {
    await promise;
  } catch (error) {
    return error as BitlabError;
  }
  throw new Error('esperava falha');
}

describe('BitlabClient.fetchBudgetsPage', () => {
  it('manda POST com x-api-key, tipoData alteracao e o corpo da consulta', async () => {
    const captured: Captured[] = [];
    await client(fakeFetch(200, listResponse(), {}, captured)).fetchBudgetsPage('chave-123', QUERY);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe('https://bitlab.test/webhook/v1/bitlab/orcamentos');
    expect(captured[0]?.init.method).toBe('POST');
    expect((captured[0]?.init.headers as Record<string, string>)['x-api-key']).toBe('chave-123');
    expect(JSON.parse(String(captured[0]?.init.body))).toEqual({ ...QUERY, tipoData: 'alteracao' });
  });

  it('mapeia o orcamento para a mesma linha da planilha e descarta CPF/nascimento', async () => {
    const page = await client(fakeFetch(200, listResponse())).fetchBudgetsPage('k', QUERY);

    expect(page.hasNext).toBe(false);
    expect(page.watermark).toBe('2026-09-30T18:22:00.000Z');
    expect(page.rows).toEqual([
      {
        number: '1234',
        issuedOn: '2026-09-15',
        patientName: 'FULANO DE TAL',
        insurance1: 'PARTICULAR',
        value1: 250,
        insurance2: null,
        value2: null,
        insurance3: null,
        value3: null,
        attendantName: 'RECEPCAO01',
        insuranceAverage: 250,
        requisitionNumber: '001-0009876',
        requisitionValue: 250,
        paidValue: 100,
        paidOn: '2026-09-28',
      },
    ]);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('12345678900');
    expect(serialized).not.toContain('1980-05-10');
  });

  it('SEM_RESULTADOS sem avisos devolve pagina vazia', async () => {
    const page = await client(
      fakeFetch(200, {
        sucesso: true,
        apiVersao: 'v1',
        status: 'SEM_RESULTADOS',
        mensagem: 'Nenhum orcamento encontrado no periodo informado.',
        paginacao: { pagina: 1, tamanhoPagina: 100, totalRegistros: 0, totalPaginas: 0, temProxima: false },
        marcaDagua: null,
        total: 0,
        orcamentos: [],
      }),
    ).fetchBudgetsPage('k', QUERY);

    expect(page).toEqual({ rows: [], hasNext: false, watermark: null, deprecationNotices: [] });
  });

  it('tolera envelope dentro de array, numero como string e zeros a esquerda no orcamento', async () => {
    const body = [
      listResponse({
        orcamentos: [{ ...BUDGET, ORCAMENTO: '001234', VL_TOTAL1: '250.00', Valor_Pago: '100', REQUISICAO: '' }],
      }),
    ];
    const page = await client(fakeFetch(200, body)).fetchBudgetsPage('k', QUERY);

    expect(page.rows[0]).toMatchObject({ number: '1234', value1: 250, paidValue: 100, requisitionNumber: null });
  });

  it('avisos[] e X-API-Deprecation viram deprecationNotices', async () => {
    const page = await client(
      fakeFetch(200, listResponse({ avisos: ['v1 sera desligada em 2027'] }), { 'X-API-Deprecation': 'true' }),
    ).fetchBudgetsPage('k', QUERY);

    expect(page.deprecationNotices).toEqual(['v1 sera desligada em 2027', 'X-API-Deprecation: true']);
  });

  it('403 do n8n em texto vira auth, sem vazar a chave na mensagem', async () => {
    const error = await failure(
      client(fakeFetch(403, 'Authorization data is wrong!')).fetchBudgetsPage('chave-secreta-xyz', QUERY),
    );
    expect(error.kind).toBe('auth');
    expect(error.message).not.toContain('chave-secreta-xyz');
    expect(error.userMessage).not.toContain('chave-secreta-xyz');
  });

  it('400 PARAMETROS_INVALIDOS vira rejected com a mensagem do Bitlab', async () => {
    const error = await failure(
      client(
        fakeFetch(400, {
          sucesso: false,
          apiVersao: 'v1',
          status: 'PARAMETROS_INVALIDOS',
          erro: { codigo: 'PARAMETROS_INVALIDOS', mensagem: 'Informe dataInicio e dataFim (formato YYYY-MM-DD).' },
        }),
      ).fetchBudgetsPage('k', QUERY),
    );
    expect(error.kind).toBe('rejected');
    expect(error.userMessage).toContain('Informe dataInicio e dataFim');
  });

  it('400 PERIODO_INVALIDO vira rejected', async () => {
    const error = await failure(
      client(
        fakeFetch(400, { sucesso: false, status: 'PERIODO_INVALIDO', erro: { codigo: 'PERIODO_INVALIDO' } }),
      ).fetchBudgetsPage('k', QUERY),
    );
    expect(error.kind).toBe('rejected');
  });

  it('sucesso:false com HTTP 200 tambem e erro (nao confia so no status HTTP)', async () => {
    const error = await failure(
      client(fakeFetch(200, { sucesso: false, status: 'QUALQUER' })).fetchBudgetsPage('k', QUERY),
    );
    expect(error.kind).toBe('rejected');
  });

  it('5xx e erro de rede viram unavailable', async () => {
    expect((await failure(client(fakeFetch(502, 'Bad Gateway')).fetchBudgetsPage('k', QUERY))).kind).toBe(
      'unavailable',
    );
    const broken = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect((await failure(client(broken).fetchBudgetsPage('k', QUERY))).kind).toBe('unavailable');
  });

  it('timeout vira unavailable', async () => {
    const slow = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const error = await failure(
      createBitlabClient({ baseUrl: 'https://bitlab.test', fetchImpl: slow, timeoutMs: 20 }).fetchBudgetsPage(
        'k',
        QUERY,
      ),
    );
    expect(error.kind).toBe('unavailable');
  });

  it('resposta fora do contrato vira contract, sem o valor do campo na mensagem', async () => {
    const error = await failure(
      client(fakeFetch(200, listResponse({ orcamentos: [{ ...BUDGET, ORCAMENTO: 'NOME DE PACIENTE' }] }))).fetchBudgetsPage(
        'k',
        QUERY,
      ),
    );
    expect(error.kind).toBe('contract');
    expect(error.message).not.toContain('NOME DE PACIENTE');

    expect((await failure(client(fakeFetch(200, '<html>')).fetchBudgetsPage('k', QUERY))).kind).toBe('contract');
  });
});

describe('datas do Bitlab (D-187)', () => {
  it('data pelos componentes da string, sem fuso', () => {
    expect(bitlabDateToIsoDate('2026-09-28T23:30:00.000Z')).toBe('2026-09-28');
    expect(bitlabDateToIsoDate(null)).toBeNull();
    expect(bitlabDateToIsoDate('lixo')).toBeNull();
  });

  it('marca d agua vira dataInicio YYYY-MM-DD HH:mm:ss pelos componentes', () => {
    expect(watermarkToBitlabDateTime('2026-09-30T18:22:00.000Z')).toBe('2026-09-30 18:22:00');
    expect(watermarkToBitlabDateTime('invalida')).toBeNull();
  });

  it('relogio de Brasilia no formato do Bitlab', () => {
    expect(saoPauloDateTime(new Date('2026-09-25T02:30:15.000Z'))).toBe('2026-09-24 23:30:15');
  });
});
