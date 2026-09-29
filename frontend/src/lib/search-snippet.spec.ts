import { describe, expect, it } from 'vitest';
import { highlightParts, isSearchableTerm, searchSnippet, searchWords } from './search-snippet';

/** Trecho e destaque da busca (CRMLAB-68, D-228 item 6): sem acento e sem caixa. */
describe('search-snippet', () => {
  it('palavras do termo como o servidor: só letras e dígitos, sem acento, minúsculas', () => {
    expect(searchWords('Orçamento, HEMOGRAMA!')).toEqual(['orcamento', 'hemograma']);
    expect(isSearchableTerm('a')).toBe(false);
    expect(isSearchableTerm('!!')).toBe(false);
    expect(isSearchableTerm('tsh')).toBe(true);
  });

  it('destaca a palavra acentuada quando se digitou sem acento, e vice-versa', () => {
    expect(highlightParts('Segue o orçamento do exame', 'orcamento')).toEqual([
      { text: 'Segue o ', match: false },
      { text: 'orçamento', match: true },
      { text: ' do exame', match: false },
    ]);
    expect(highlightParts('Resultado da Glicose', 'GLICÓSE').filter((p) => p.match)).toEqual([
      { text: 'Glicose', match: true },
    ]);
  });

  it('várias palavras e várias ocorrências; sobreposição vira um destaque só', () => {
    const parts = highlightParts('glicose e mais glicose, jejum', 'glic glicose jejum');
    expect(parts.filter((p) => p.match).map((p) => p.text)).toEqual([
      'glicose',
      'glicose',
      'jejum',
    ]);
  });

  it('trecho em volta da primeira ocorrência, com reticências onde cortou', () => {
    const long = `${'palavra '.repeat(20)}quero o hemograma completo ${'fim '.repeat(40)}`;
    const snippet = searchSnippet(long, 'hemograma');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).toContain('hemograma');
    expect(snippet.length).toBeLessThanOrEqual(122);
  });

  it('texto curto e sem ocorrência: o começo, sem reticências; espaços colapsados', () => {
    expect(searchSnippet('Bom   dia\n tudo bem', 'hemog')).toBe('Bom dia tudo bem');
  });
});
