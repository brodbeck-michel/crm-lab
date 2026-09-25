/**
 * `parseCsv` (backend/src/lib/csv.ts) — formato dos exports do Supabase
 * (CRMLAB-45): virgula, aspas, `""`, quebra de linha dentro de aspas, CRLF, BOM.
 */
import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../src/lib/csv.js';

describe('parseCsv', () => {
  it('le cabecalho e linhas simples', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 2, fields: ['1', '2'] },
    ]);
  });

  it('remove o BOM e aceita CRLF', () => {
    const rows = parseCsv('\uFEFFid,nome\r\n1,Ana\r\n');
    expect(rows[0]?.fields).toEqual(['id', 'nome']);
    expect(rows[1]).toEqual({ line: 2, fields: ['1', 'Ana'] });
  });

  it('campo entre aspas com virgula, aspas escapadas e quebra de linha', () => {
    const rows = parseCsv('x,y\n"a, b","diz ""oi""\nsegunda"\n3,4');
    expect(rows[1]).toEqual({ line: 2, fields: ['a, b', 'diz "oi"\nsegunda'] });
    // A linha seguinte comeca na 4 do arquivo (a 3 foi consumida pela quebra dentro das aspas).
    expect(rows[2]).toEqual({ line: 4, fields: ['3', '4'] });
  });

  it('preserva campos vazios e ignora linhas totalmente vazias', () => {
    expect(parseCsv('a,b,c\n,,\n\n1,,3').map((r) => r.fields)).toEqual([
      ['a', 'b', 'c'],
      ['', '', ''],
      ['1', '', '3'],
    ]);
  });

  it('aspas nao fechadas: erro de arquivo', () => {
    expect(() => parseCsv('a\n"sem fim')).toThrow(/aspas abertas/);
  });
});
