import { describe, expect, it } from 'vitest';
import { effectiveSearchTerm, SEARCH_MIN_LENGTH } from './search-term';

describe('effectiveSearchTerm (CRMLAB-125)', () => {
  it('ignora termo com menos de 2 caracteres e apara espaços', () => {
    expect(SEARCH_MIN_LENGTH).toBe(2);
    expect(effectiveSearchTerm('')).toBe('');
    expect(effectiveSearchTerm(' m ')).toBe('');
    expect(effectiveSearchTerm(' ma ')).toBe('ma');
    expect(effectiveSearchTerm('Maria da Silva')).toBe('Maria da Silva');
  });
});
