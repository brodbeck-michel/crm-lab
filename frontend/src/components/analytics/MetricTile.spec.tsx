import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import MetricTile from './MetricTile';

const norm = (value: string) => value.replace(/[\s\u00a0\u202f]+/g, ' ');

describe('MetricTile', () => {
  it('sem value mostra travessao', () => {
    render(<MetricTile label="Receita" />);
    expect(screen.getByText('-')).toBeInTheDocument();
  });

  it('variante money usa MoneyDisplay (pt-BR)', () => {
    render(<MetricTile label="Receita" value={1350} variant="money" />);
    expect(norm(screen.getByText(/R\$/).textContent ?? '')).toBe('R$ 1.350,00');
  });

  it('variante number formata contagem inteira em pt-BR', () => {
    render(<MetricTile label="Propostas Criadas" value={2400} variant="number" />);
    expect(screen.getByText('2.400')).toBeInTheDocument();
  });

  /**
   * `value` da variante `percent` já vem em PONTOS percentuais do contrato
   * (API_CONTRACTS.md: `conversionRate: 30` = 30%) — não é fração 0–1. O
   * defeito real não era de escala, era de locale: `toFixed(1)` imprimia
   * "30.0%" com PONTO enquanto o resto da tela é pt-BR.
   */
  it('variante percent formata em pt-BR (vírgula decimal)', () => {
    render(<MetricTile label="Conversão" value={30} variant="percent" />);
    expect(screen.getByText('30,0%')).toBeInTheDocument();
  });
});
