/**
 * Parser puro `lis-spreadsheet.ts` — BUSINESS_RULES.md §11.
 */
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  consolidateLisRows,
  parseLisSpreadsheet,
  principalInsuranceName,
  totalValue,
  type LisSpreadsheetRow,
} from '../../src/lib/lis-spreadsheet.js';

async function buildWorkbook(
  headers: string[],
  rows: Array<Array<string | number | Date | null>>,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('orcamentos');
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

const FULL_HEADERS = [
  'ORCAMENTO',
  'DATA_ORÇAMENTO',
  'NM_PACIENTE',
  'CONVENIO1',
  'VL_TOTAL1',
  'CONVENIO2',
  'VL_TOTAL2',
  'CONVENIO3',
  'VL_TOTAL3',
  'USUÁRIO',
  'MEDIA_CONVENIO',
  'REQUISICAO',
  'VALOR_REQUISICAO',
  'Valor_Pago',
  'Data_Pagamento',
];

describe('parseLisSpreadsheet — guards', () => {
  it('recusa PDF disfarçado de xlsx', async () => {
    const buffer = Buffer.from('%PDF-1.4\n%algum conteudo de pdf');
    await expect(parseLisSpreadsheet(buffer)).rejects.toMatchObject({ reason: 'pdf_disguised' });
  });

  it('recusa planilha sem a coluna ORCAMENTO', async () => {
    const buffer = await buildWorkbook(['FOO', 'BAR'], [[1, 2]]);
    await expect(parseLisSpreadsheet(buffer)).rejects.toMatchObject({ reason: 'missing_column' });
  });

  it('recusa planilha sem nenhuma linha de dado (so cabecalho)', async () => {
    const buffer = await buildWorkbook(['ORCAMENTO'], []);
    await expect(parseLisSpreadsheet(buffer)).rejects.toMatchObject({ reason: 'empty' });
  });

  it('recusa arquivo vazio/corrompido', async () => {
    const buffer = Buffer.from('nao e um xlsx de verdade');
    await expect(parseLisSpreadsheet(buffer)).rejects.toMatchObject({ reason: 'empty' });
  });
});

describe('parseLisSpreadsheet — aliases e tipos', () => {
  it('le todas as colunas mapeadas, casando sem caixa/acento', async () => {
    const buffer = await buildWorkbook(FULL_HEADERS, [
      [
        '123',
        new Date(Date.UTC(2026, 7, 20, 10, 30)),
        'João Santos',
        'Unimed',
        200,
        'Bradesco',
        50,
        null,
        null,
        'Maria',
        250,
        'REQ-1',
        250,
        250,
        new Date(Date.UTC(2026, 7, 25, 8, 0)),
      ],
    ]);
    const rows = await parseLisSpreadsheet(buffer);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      number: '123',
      issuedOn: '2026-08-20',
      patientName: 'João Santos',
      insurance1: 'Unimed',
      value1: 200,
      insurance2: 'Bradesco',
      value2: 50,
      insurance3: null,
      value3: null,
      attendantName: 'Maria',
      insuranceAverage: 250,
      requisitionNumber: 'REQ-1',
      requisitionValue: 250,
      paidValue: 250,
      paidOn: '2026-08-25',
    });
  });

  it('aceita cabecalho com grafia alternativa (USUARIO sem acento, DATA_ORCAMENTO sem cedilha)', async () => {
    const buffer = await buildWorkbook(
      ['ORCAMENTO', 'DATA_ORCAMENTO', 'USUARIO'],
      [['1', new Date(Date.UTC(2026, 0, 1)), 'Ana']],
    );
    const rows = await parseLisSpreadsheet(buffer);
    expect(rows[0]?.issuedOn).toBe('2026-01-01');
    expect(rows[0]?.attendantName).toBe('Ana');
  });

  it('converte serial de data do Excel por componentes (sem fuso)', async () => {
    // serial 44927 = 2023-01-01 (referencia conhecida do serial do Excel;
    // dia 1 = 1900-01-01, com a correcao do bissexto de 1900 — §11.9)
    const buffer = await buildWorkbook(['ORCAMENTO', 'DATA_ORÇAMENTO'], [['1', 44927]]);
    const rows = await parseLisSpreadsheet(buffer);
    expect(rows[0]?.issuedOn).toBe('2023-01-01');
  });

  it('numero com virgula decimal (formato pt-BR) e reconhecido', async () => {
    const buffer = await buildWorkbook(['ORCAMENTO', 'VL_TOTAL1'], [['1', '1.234,56']]);
    const rows = await parseLisSpreadsheet(buffer);
    expect(rows[0]?.value1).toBeCloseTo(1234.56);
  });

  it('linha sem numero (ORCAMENTO vazio) fica com number: ""', async () => {
    const buffer = await buildWorkbook(['ORCAMENTO', 'NM_PACIENTE'], [['', 'Fulano']]);
    const rows = await parseLisSpreadsheet(buffer);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.number).toBe('');
  });
});

describe('principalInsuranceName (BUSINESS_RULES.md §11.3)', () => {
  const base: LisSpreadsheetRow = {
    number: '1',
    issuedOn: null,
    patientName: null,
    insurance1: null,
    value1: null,
    insurance2: null,
    value2: null,
    insurance3: null,
    value3: null,
    attendantName: null,
    insuranceAverage: null,
    requisitionNumber: null,
    requisitionValue: null,
    paidValue: null,
    paidOn: null,
  };

  it('escolhe o primeiro com nome E valor > 0', () => {
    const row: LisSpreadsheetRow = { ...base, insurance1: 'A', value1: 0, insurance2: 'B', value2: 10 };
    expect(principalInsuranceName(row)).toBe('B');
  });

  it('sem nenhum valor > 0, escolhe o primeiro com nome', () => {
    const row: LisSpreadsheetRow = { ...base, insurance1: 'A', value1: 0, insurance2: 'B', value2: 0 };
    expect(principalInsuranceName(row)).toBe('A');
  });

  it('nenhum convenio com nome -> null', () => {
    expect(principalInsuranceName(base)).toBeNull();
  });
});

describe('consolidateLisRows (BUSINESS_RULES.md §11.1)', () => {
  const make = (number: string, value1: number): LisSpreadsheetRow => ({
    number,
    issuedOn: null,
    patientName: null,
    insurance1: null,
    value1,
    insurance2: null,
    value2: null,
    insurance3: null,
    value3: null,
    attendantName: null,
    insuranceAverage: null,
    requisitionNumber: null,
    requisitionValue: null,
    paidValue: null,
    paidOn: null,
  });

  it('duas linhas com o mesmo numero: a de maior total_value vence', () => {
    const rows = [make('1', 100), make('1', 300), make('1', 200)];
    const consolidated = consolidateLisRows(rows);
    expect(consolidated).toHaveLength(1);
    expect(totalValue(consolidated[0]!)).toBe(300);
  });

  it('numeros diferentes viram linhas separadas', () => {
    const rows = [make('1', 100), make('2', 50)];
    expect(consolidateLisRows(rows)).toHaveLength(2);
  });
});
