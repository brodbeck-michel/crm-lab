import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgeBadge } from './AgeBadge';

describe('AgeBadge', () => {
  it('mostra o número de dias e a faixa juntos — o número sempre acompanha a cor (D5)', () => {
    render(<AgeBadge daysOpen={12} ageBand="8-15" />);
    expect(screen.getByText('12 dias · 8-15')).toBeInTheDocument();
  });

  it('singular para 1 dia', () => {
    render(<AgeBadge daysOpen={1} ageBand="0-7" />);
    expect(screen.getByText('1 dia · 0-7')).toBeInTheDocument();
  });

  it('faixa 30+ usa o tom mais intenso', () => {
    render(<AgeBadge daysOpen={45} ageBand="30+" />);
    const badge = screen.getByText('45 dias · 30+');
    expect(badge.className).toContain('bg-accent-500');
  });
});
