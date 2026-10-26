import { describe, expect, it } from 'vitest';
import { formatBrazilianPhone, ninthDigitSuggestion } from './phone-suggestion';

describe('ninthDigitSuggestion (CRMLAB-121)', () => {
  it('celular com 8 dígitos ganha o 9 na frente, com ou sem máscara e 55', () => {
    expect(ninthDigitSuggestion('(48) 9999-1234')).toBe('(48) 99999-1234');
    expect(ninthDigitSuggestion('4888881234')).toBe('(48) 98888-1234');
    expect(ninthDigitSuggestion('+55 48 6999-1234')).toBe('(48) 96999-1234');
  });

  it('não sugere para número que já tem o 9, fixo ou incompleto', () => {
    expect(ninthDigitSuggestion('(48) 99999-1234')).toBeNull();
    expect(ninthDigitSuggestion('(48) 3622-1234')).toBeNull();
    expect(ninthDigitSuggestion('(48) 5622-1234')).toBeNull();
    expect(ninthDigitSuggestion('(48) 9999-12')).toBeNull();
    expect(ninthDigitSuggestion('')).toBeNull();
  });
});

describe('formatBrazilianPhone', () => {
  it('formata E.164 brasileiro e deixa o resto cru', () => {
    expect(formatBrazilianPhone('+5548999991234')).toBe('(48) 99999-1234');
    expect(formatBrazilianPhone('554836221234')).toBe('(48) 3622-1234');
    expect(formatBrazilianPhone('+14155550100')).toBe('+14155550100');
  });
});
