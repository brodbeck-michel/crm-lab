import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';

const BOM = String.fromCharCode(0xfeff);

describe('toCsv (CRMLAB-193)', () => {
  it('BOM, ponto e vírgula, CRLF e decimal com vírgula', () => {
    expect(toCsv([['Nome', 'Cobertura'], ['Carla', 57.1], ['Diego', null]])).toBe(
      `${BOM}Nome;Cobertura\r\nCarla;57,1\r\nDiego;`,
    );
  });

  it('aspas quando há separador, aspas ou quebra de linha', () => {
    expect(toCsv([['Dr. "Zé"; Silva', 'linha\nnova']])).toBe(`${BOM}"Dr. ""Zé""; Silva";"linha\nnova"`);
  });

  it('célula de texto que começa com = + - @ vira texto (injeção de fórmula)', () => {
    expect(toCsv([['=HYPERLINK("x")', '+1', '-2', '@SUM']])).toBe(`${BOM}"'=HYPERLINK(""x"")";'+1;'-2;'@SUM`);
    // Número negativo é número, não fórmula.
    expect(toCsv([[-3.5]])).toBe(`${BOM}-3,5`);
  });
});
