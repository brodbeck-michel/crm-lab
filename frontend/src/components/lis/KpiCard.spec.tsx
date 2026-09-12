import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KpiCard } from './KpiCard';

describe('KpiCard', () => {
  it('renderiza o valor sem variação quando deltaPct é omitido', () => {
    render(<KpiCard label="Total em aberto" value={34} variant="number" />);

    expect(screen.getByText('Total em aberto')).toBeInTheDocument();
    expect(screen.getByText('34')).toBeInTheDocument();
    expect(screen.queryByText(/vs\. período anterior/)).not.toBeInTheDocument();
  });

  it('mostra a variação em pontos percentuais com sinal, tom positivo por padrão', () => {
    render(<KpiCard label="Conversão" value={78.5} variant="percent" deltaPct={12.4} />);

    expect(screen.getByText('+12,4% vs. período anterior')).toBeInTheDocument();
  });

  it('a TELA decide o tom — deltaTone="negative" mesmo com delta positivo', () => {
    render(<KpiCard label="Em aberto" value={10} deltaPct={5} deltaTone="negative" />);

    const delta = screen.getByText('+5,0% vs. período anterior');
    expect(delta.className).toContain('text-accent-700');
  });
});
