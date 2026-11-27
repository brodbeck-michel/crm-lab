/**
 * Cliente da consulta de requisicoes do Bitlab (CRMLAB-200, D-338; BUSINESS_RULES §11.13).
 * `fetchImpl` falso; o corpo e o da homologacao do Bitlab de 26/11/2026 (dados ficticios).
 */
import { describe, expect, it } from 'vitest';
import { BitlabError } from '../../src/lib/bitlab-client.js';
import { createBitlabRequisitionsClient } from '../../src/lib/bitlab-requisitions-client.js';

const HML_BODY = {
  success: true,
  status: 'LISTA',
  filtro: { dataInicio: '2026-11-26 00:00:00', dataFim: '2026-11-26 23:59:59', tipoData: 'emissao' },
  paginacao: { pagina: 1, tamanhoPagina: 100, totalRegistros: 2, totalPaginas: 1, temProxima: false, proximoCursor: '20261126094950000-1-135' },
  marcaDagua: '2026-11-26 09:50:35',
  total: 2,
  requisicoes: [
    {
      requisicao: '01-000132',
      dataRequisicao: '26/11/2026 09:43:57',
      orcamento: null,
      convenio: { codigo: 1, nome: 'PARTICULAR', tipo: 'Particular' },
      medico: { nome: ' MÉDICO SOLICITANTE ', conselho: 'crm', numero: '12.345', uf: 'sc' },
      usuario: 'BITLAB',
      dataAlteracao: '26/11/2026 09:45:55',
      taxas: [],
      cobrancaPaciente: {
        valorExames: 60, valorTaxas: 0, valorCobrado: 60, descontos: 10, acrescimos: 0, valorPago: 50,
        tributoRepasse: 0, valorEstornado: 0, saldo: 0,
        pagamentos: [
          { id: 21, data: '26/11/2026 09:45:55', forma: 'Dinheiro', bandeira: null, valor: 50, desconto: 10, acrescimo: 0,
            tributoRepasse: 0, situacao: 'ATIVO', dataEstorno: null, valorEstorno: null },
          { id: 22, data: '26/11/2026 09:46:00', forma: 'PIX', bandeira: null, valor: 5, desconto: 0, acrescimo: 0,
            tributoRepasse: 0, situacao: 'ESTORNADO', dataEstorno: '26/11/2026 10:00:00', valorEstorno: 5 },
        ],
      },
      faturamentoConvenio: { exames: 0, taxas: 0, valorExames: 0, valorTaxas: 0, valorConvenio: 0 },
    },
    {
      requisicao: '01-000150',
      dataRequisicao: '26/11/2026 10:00:00',
      orcamento: '0018',
      convenio: { codigo: 7, nome: 'UNIMED', tipo: 'Convenio' },
      medico: { nome: 'Dr. Caio', conselho: 'CRM', numero: '1', uf: 'XX' },
      usuario: 'RECEPCAO',
      dataAlteracao: '26/11/2026 10:00:00',
      cobrancaPaciente: { valorCobrado: '0.00', descontos: 0, acrescimos: 0, valorPago: 0, pagamentos: [] },
      faturamentoConvenio: { valorConvenio: '134.90' },
    },
  ],
  requisicoesExcluidas: [{ requisicao: '01-000149', dataExclusao: '26/11/2026 11:02:10', usuario: 'RECEPCAO' }],
};

function fakeFetch(status: number, body: unknown, seen: Array<{ url: string; init: RequestInit }> = []): typeof fetch {
  return ((url: string, init: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as unknown as typeof fetch;
}

const QUERY = { dataInicio: '2026-11-26 00:00:00', dataFim: '2026-11-26 23:59:59', tipoData: 'emissao' as const, cursor: null };

describe('createBitlabRequisitionsClient', () => {
  it('mapeia a resposta real da homologacao', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const client = createBitlabRequisitionsClient({ baseUrl: 'https://api.bitlab.net.br/homologacao/', fetchImpl: fakeFetch(200, HML_BODY, seen) });
    const page = await client.fetchRequisitionsPage('k', QUERY);

    expect(seen[0]?.url).toBe('https://api.bitlab.net.br/homologacao/requisicoes/consulta');
    expect((seen[0]?.init.headers as Record<string, string>)['x-api-key']).toBe('k');
    expect(JSON.parse(String(seen[0]?.init.body))).toMatchObject({ tipoData: 'emissao', tamanhoPagina: 1000, cursor: null });

    expect(page).toMatchObject({
      hasNext: false,
      nextCursor: '20261126094950000-1-135',
      watermark: '2026-11-26 09:50:35',
      excluded: ['01-000149'],
    });
    expect(page.rows[0]).toEqual({
      number: '01-000132',
      requestedAt: '2026-11-26 09:43:57',
      requestedOn: '2026-11-26',
      budgetNumber: null,
      insuranceCode: '1',
      insuranceName: 'PARTICULAR',
      insuranceType: 'Particular',
      attendantName: 'BITLAB',
      requestingDoctorName: 'MÉDICO SOLICITANTE',
      requestingDoctorCouncil: 'CRM',
      requestingDoctorCrm: '12345',
      requestingDoctorUf: 'SC',
      patientValue: 50, // 60 - 10 + 0
      insuranceValue: 0,
      paidValue: 50,
      changedAt: '2026-11-26 09:45:55',
      payments: [
        { paymentKey: '21', paidAt: '2026-11-26 09:45:55', paidOn: '2026-11-26', paidValue: 50, status: 'ativo', paymentMethod: 'Dinheiro' },
        { paymentKey: '22', paidAt: '2026-11-26 09:46:00', paidOn: '2026-11-26', paidValue: 5, status: 'estornado', paymentMethod: 'PIX' },
      ],
    });
    // Convenio, orcamento com zero a esquerda, numero em string, UF invalida vira null.
    expect(page.rows[1]).toMatchObject({
      budgetNumber: '18',
      insuranceName: 'UNIMED',
      patientValue: 0,
      insuranceValue: 134.9,
      requestingDoctorCrm: '1',
      requestingDoctorUf: null,
    });
  });

  it('status HTTP e envelope de erro viram BitlabError', async () => {
    const cases: Array<[number, unknown, string]> = [
      [401, {}, 'auth'],
      [429, { success: false, error: 'Rate Limit excedido' }, 'unavailable'],
      [500, {}, 'unavailable'],
      [400, { success: false, status: 'PERIODO_MUITO_LONGO', error: 'Período máximo de 1 dia' }, 'rejected'],
      [200, { success: false, error: 'Chave inválida ou não cadastrada em INTEGRACAO_API_KEYS.' }, 'auth'],
      [200, { success: true, requisicoes: [{ dataRequisicao: 'x' }] }, 'contract'],
    ];
    for (const [status, body, kind] of cases) {
      const client = createBitlabRequisitionsClient({ baseUrl: 'https://x', fetchImpl: fakeFetch(status, body) });
      const error = await client.fetchRequisitionsPage('k', QUERY).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BitlabError);
      expect((error as BitlabError).kind).toBe(kind);
      expect((error as BitlabError).message).not.toContain('k"');
    }
  });

  it('pagina vazia (SEM_RESULTADOS) sem arrays', async () => {
    const client = createBitlabRequisitionsClient({
      baseUrl: 'https://x',
      fetchImpl: fakeFetch(200, { success: true, status: 'SEM_RESULTADOS', marcaDagua: null }),
    });
    expect(await client.fetchRequisitionsPage('k', QUERY)).toEqual({
      rows: [], excluded: [], hasNext: false, nextCursor: null, watermark: null,
    });
  });
});
