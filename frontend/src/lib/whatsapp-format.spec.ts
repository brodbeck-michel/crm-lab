import { describe, expect, it } from 'vitest';
import { splitBold } from './whatsapp-format';

/** Negrito padrão WhatsApp — D-183. */

const bolds = (text: string) =>
  splitBold(text)
    .filter((s) => s.bold)
    .map((s) => s.text);

describe('splitBold — formata', () => {
  it('trecho entre asteriscos vira negrito, o resto fica como está', () => {
    expect(splitBold('Seu *resultado* saiu')).toEqual([
      { text: 'Seu ', bold: false },
      { text: 'resultado', bold: true },
      { text: ' saiu', bold: false },
    ]);
  });

  it('texto inteiro, um caractere e vários trechos na mesma linha', () => {
    expect(splitBold('*Olá*')).toEqual([{ text: 'Olá', bold: true }]);
    expect(bolds('*a*')).toEqual(['a']);
    expect(bolds('*um* e *dois*')).toEqual(['um', 'dois']);
  });

  it('espaço no meio pode; pontuação em volta pode', () => {
    expect(bolds('Atenção: *jejum de 8 horas*.')).toEqual(['jejum de 8 horas']);
    expect(bolds('(*urgente*)')).toEqual(['urgente']);
    // negrito + itálico/tachado do WhatsApp: o negrito aparece
    expect(bolds('_*importante*_ e ~*antigo*~')).toEqual(['importante', 'antigo']);
  });

  it('cada linha formata sozinha', () => {
    expect(bolds('*linha um*\n*linha dois*')).toEqual(['linha um', 'linha dois']);
  });
});

describe('splitBold — NÃO formata', () => {
  it.each([
    ['sem asterisco', 'bom dia'],
    ['asterisco solto', 'nota * importante'],
    ['conta com espaços', '2 * 3 * 4'],
    ['conta sem espaços (borda da palavra)', '2*3*4'],
    ['colado em letra por fora', 'a*b*c'],
    ['** vazio', 'isso ** aquilo'],
    ['abertura seguida de espaço', '* texto*'],
    ['fechamento precedido de espaço', '*texto *'],
    ['atravessa quebra de linha', '*linha um\nlinha dois*'],
    ['string vazia', ''],
  ])('%s', (_label, text) => {
    expect(bolds(text)).toEqual([]);
    expect(
      splitBold(text)
        .map((s) => s.text)
        .join(''),
    ).toBe(text);
  });
});
