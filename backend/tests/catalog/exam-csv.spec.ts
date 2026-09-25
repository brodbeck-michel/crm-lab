/**
 * Parser puro `lib/exam-csv.ts` — CRMLAB-23, D-178 (API_CONTRACTS.md §4,
 * "Importação do catálogo por CSV").
 */
import { describe, expect, it } from 'vitest';
import {
  EXAM_IMPORT_COLUMNS,
  EXAM_IMPORT_MAX_ROWS,
  EXAM_IMPORT_TEMPLATE_EXAMPLE,
} from '@crm-lab/shared';
import {
  ExamCsvError,
  detectSeparator,
  parseExamCsv,
  parsePrice,
  splitRecords,
} from '../../src/lib/exam-csv.js';

const HEADER_SEMI = 'nome;codigo;categoria;descricao;preparo;prazo_horas;preco_convenio;preco_particular';

function csv(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

function expectCsvError(fn: () => unknown, reason: string): ExamCsvError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ExamCsvError);
    expect((err as ExamCsvError).reason).toBe(reason);
    return err as ExamCsvError;
  }
  throw new Error(`esperava ExamCsvError(${reason})`);
}

describe('parsePrice', () => {
  it.each([
    ['1.234,56', 1234.56],
    ['1234,56', 1234.56],
    ['1234.56', 1234.56],
    ['1,234.56', 1234.56],
    ['1234', 1234],
    ['89,9', 89.9],
    ['0', 0],
    ['R$ 1.234,56', 1234.56],
    ['r$89,90', 89.9],
    ['1.234.567,89', 1234567.89],
    ['1.234.567', 1234567],
    [' 75,00 ', 75],
  ])('%s -> %s', (raw, expected) => {
    expect(parsePrice(raw)).toEqual({ ok: true, value: expected });
  });

  it.each(['abc', '12a', '1.234', '1,234', '12,345', '1,2,3', '12.34.5', '1.23,4.5', ''])(
    'recusa %s',
    (raw) => {
      expect(parsePrice(raw).ok).toBe(false);
    },
  );

  it('explica o ambiguo com casas decimais demais', () => {
    const parsed = parsePrice('1.234');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain('mais de 2 casas decimais');
  });

  it('recusa negativo e acima de NUMERIC(12,2)', () => {
    expect(parsePrice('-10,00')).toEqual({ ok: false, message: 'Preço não pode ser negativo' });
    expect(parsePrice('10000000000,00').ok).toBe(false);
    expect(parsePrice('9.999.999.999,99')).toEqual({ ok: true, value: 9_999_999_999.99 });
  });
});

describe('detectSeparator / splitRecords', () => {
  it('escolhe ; ou , pelo cabecalho, ignorando o que esta entre aspas; empate fica com ;', () => {
    expect(detectSeparator('a;b;c\n1,2;3')).toBe(';');
    expect(detectSeparator('a,b,c\n1;2;3;4;5')).toBe(',');
    expect(detectSeparator('"a;b;c",d,e\n')).toBe(',');
    expect(detectSeparator('abc')).toBe(';');
  });

  it('respeita aspas, "" escapado, quebra de linha entre aspas e CRLF', () => {
    const records = splitRecords('a;"b;c";"diz ""oi"""\r\n"linha\numa";x\r\n', ';');
    expect(records).toEqual([
      ['a', 'b;c', 'diz "oi"'],
      ['linha\numa', 'x'],
    ]);
  });

  it('aspas nunca fechadas -> malformed', () => {
    expectCsvError(() => splitRecords('a;"b\n1;2', ';'), 'malformed');
  });
});

describe('parseExamCsv — arquivo', () => {
  it('le separador ; com BOM, preco BR e campos opcionais', () => {
    const buffer = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      csv(`${HEADER_SEMI}\nHemograma completo;HC;Hematologia;Sangue;Jejum;24;75,00;1.089,90\n`),
    ]);
    const result = parseExamCsv(buffer);
    expect(result.errors).toEqual([]);
    expect(result.totalRows).toBe(1);
    expect(result.rows).toEqual([
      {
        line: 2,
        name: 'Hemograma completo',
        code: 'HC',
        category: 'Hematologia',
        description: 'Sangue',
        preparation: 'Jejum',
        turnaroundHours: 24,
        priceInsurance: 75,
        pricePrivate: 1089.9,
      },
    ]);
  });

  it('le separador , sem BOM, preco com ponto e texto com virgula entre aspas', () => {
    const result = parseExamCsv(
      csv('nome,codigo,preco_convenio,preco_particular\n"Glicose, jejum",GLI,10.50,20\n'),
    );
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      name: 'Glicose, jejum',
      code: 'GLI',
      category: null,
      description: null,
      preparation: null,
      turnaroundHours: null,
      priceInsurance: 10.5,
      pricePrivate: 20,
    });
  });

  it('casa cabecalho sem caixa/acento, aceita "Prazo (horas)"/"prazo" e ignora coluna desconhecida', () => {
    const result = parseExamCsv(
      csv('Nome;Código;Observação;Prazo;Preço Convênio;PREÇO PARTICULAR\nTSH;TSH;qualquer;48;30;40\n'),
    );
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({ code: 'TSH', turnaroundHours: 48, pricePrivate: 40 });

    const outra = parseExamCsv(csv('nome;codigo;Prazo (horas);preco_convenio;preco_particular\nA;A;12;1;2\n'));
    expect(outra.rows[0]?.turnaroundHours).toBe(12);
  });

  it('coluna obrigatoria ausente -> missing_column com a lista', () => {
    const err = expectCsvError(() => parseExamCsv(csv('nome;codigo;preco_convenio\nA;A;1\n')), 'missing_column');
    expect(err.details).toEqual({ columns: ['preco_particular'] });
  });

  it('coluna repetida -> duplicate_column', () => {
    const err = expectCsvError(
      () => parseExamCsv(csv('nome;codigo;Código;preco_convenio;preco_particular\nA;A;B;1;2\n')),
      'duplicate_column',
    );
    expect(err.details).toEqual({ columns: ['codigo'] });
  });

  it('arquivo vazio, so cabecalho ou so linhas em branco -> empty', () => {
    expectCsvError(() => parseExamCsv(csv('')), 'empty');
    expectCsvError(() => parseExamCsv(csv(`${HEADER_SEMI}\n`)), 'empty');
    expectCsvError(() => parseExamCsv(csv(`${HEADER_SEMI}\n;;;;;;;\n\n`)), 'empty');
  });

  it('bytes que nao sao UTF-8 (Windows-1252) -> invalid_encoding', () => {
    // "Código" em Windows-1252: o "ó" e 0xF3, byte invalido isolado em UTF-8.
    const latin1 = Buffer.from('nome;C\xf3digo;preco_convenio;preco_particular\nA;A;1;2\n', 'latin1');
    expectCsvError(() => parseExamCsv(latin1), 'invalid_encoding');
  });

  it('byte NUL (UTF-16 sem BOM, binario) -> invalid_encoding, antes de chegar ao banco', () => {
    const withNul = csv('nome;codigo;preco_convenio;preco_particular\nHemo\u0000grama;HC;1;2\n');
    expectCsvError(() => parseExamCsv(withNul), 'invalid_encoding');
    const utf16NoBom = Buffer.from('nome;codigo;preco_convenio;preco_particular\nA;A;1;2\n', 'utf16le');
    expectCsvError(() => parseExamCsv(utf16NoBom), 'invalid_encoding');
  });

  it('o modelo baixavel (colunas + exemplo de @crm-lab/shared, com BOM e ;) passa sem erro', () => {
    const header = EXAM_IMPORT_COLUMNS.join(';');
    const example = EXAM_IMPORT_COLUMNS.map((c) => EXAM_IMPORT_TEMPLATE_EXAMPLE[c]).join(';');
    const result = parseExamCsv(csv(`\uFEFF${header}\r\n${example}\r\n`));
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ code: 'HC', priceInsurance: 75, pricePrivate: 89.9, turnaroundHours: 24 });
  });

  it(`mais de ${EXAM_IMPORT_MAX_ROWS} linhas -> too_many_rows`, () => {
    const lines = Array.from({ length: EXAM_IMPORT_MAX_ROWS + 1 }, (_, i) => `E${i};E${i};1;2`);
    const err = expectCsvError(
      () => parseExamCsv(csv(`nome;codigo;preco_convenio;preco_particular\n${lines.join('\n')}`)),
      'too_many_rows',
    );
    expect(err.details).toEqual({ rows: EXAM_IMPORT_MAX_ROWS + 1, max: EXAM_IMPORT_MAX_ROWS });
  });

  it(`exatamente ${EXAM_IMPORT_MAX_ROWS} linhas passa`, () => {
    const lines = Array.from({ length: EXAM_IMPORT_MAX_ROWS }, (_, i) => `E${i};E${i};1;2`);
    const result = parseExamCsv(csv(`nome;codigo;preco_convenio;preco_particular\n${lines.join('\n')}`));
    expect(result.rows).toHaveLength(EXAM_IMPORT_MAX_ROWS);
  });
});

describe('parseExamCsv — erros por linha', () => {
  it('aponta linha, coluna e motivo; linhas validas continuam', () => {
    const text = [
      HEADER_SEMI,
      'Ok;OK1;;;;24;10;20',
      ';SEMNOME;;;;;10;20',
      'Preco ruim;P1;;;;;abc;20',
      'Prazo ruim;P2;;;;24,5;10;20',
      '', // em branco: pula, mas conta na numeracao
      'Sem preco;P3;;;;;;',
      `${'x'.repeat(256)};P4;;;;;1;2`,
      'Negativo;P5;;;;0;-1;2',
    ].join('\n');
    const result = parseExamCsv(csv(text));

    expect(result.totalRows).toBe(7);
    expect(result.rows.map((row) => row.code)).toEqual(['OK1']);
    expect(result.errorCount).toBe(6);
    expect(result.errors).toEqual([
      { line: 3, column: 'nome', message: 'Nome é obrigatório' },
      { line: 4, column: 'preco_convenio', message: 'Preço inválido: "abc"' },
      {
        line: 5,
        column: 'prazo_horas',
        message: 'Prazo deve ser um número inteiro de horas, de 1 a 100000',
      },
      { line: 7, column: 'preco_convenio', message: 'Preço é obrigatório' },
      { line: 7, column: 'preco_particular', message: 'Preço é obrigatório' },
      { line: 8, column: 'nome', message: 'Máximo de 255 caracteres' },
      {
        line: 9,
        column: 'prazo_horas',
        message: 'Prazo deve ser um número inteiro de horas, de 1 a 100000',
      },
      { line: 9, column: 'preco_convenio', message: 'Preço não pode ser negativo' },
    ]);
  });

  it('codigo repetido no arquivo e erro em todas as linhas que o repetem', () => {
    const text = [
      'nome;codigo;preco_convenio;preco_particular',
      'A;DUP;1;2',
      'B;UNICO;1;2',
      'C; DUP ;1;2',
      'D;dup;1;2', // caixa diferente = outro codigo (mesma regra da UNIQUE do banco)
    ].join('\n');
    const result = parseExamCsv(csv(text));
    expect(result.rows.map((row) => row.code)).toEqual(['UNICO', 'dup']);
    expect(result.errorCount).toBe(2);
    expect(result.errors).toEqual([
      { line: 2, column: null, message: 'Código "DUP" repetido no arquivo (linhas 2, 4)' },
      { line: 4, column: null, message: 'Código "DUP" repetido no arquivo (linhas 2, 4)' },
    ]);
  });

  it('registro com quebra de linha entre aspas conta como UMA linha da planilha', () => {
    const text = 'nome;codigo;descricao;preco_convenio;preco_particular\nA;A;"linha 1\nlinha 2";1;2\nB;B;;x;2\n';
    const result = parseExamCsv(csv(text));
    expect(result.rows[0]?.description).toBe('linha 1\nlinha 2');
    expect(result.errors).toEqual([{ line: 3, column: 'preco_convenio', message: 'Preço inválido: "x"' }]);
  });
});
