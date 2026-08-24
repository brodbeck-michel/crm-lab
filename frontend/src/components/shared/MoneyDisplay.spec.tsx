import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MoneyDisplay } from './MoneyDisplay';

const norm = (value: string) => value.replace(/[\u00a0\u202f\s]+/g, ' ');

describe('MoneyDisplay', () => {
  it('1350 vira R$ 1.350,00', () => {
    render(<MoneyDisplay value={1350} />);
    expect(norm(screen.getByText(/R\$/).textContent ?? '')).toBe('R$ 1.350,00');
  });

  it('variante compact remove os centavos', () => {
    render(<MoneyDisplay value={24400} variant="compact" />);
    expect(norm(screen.getByText(/R\$/).textContent ?? '')).toBe('R$ 24.400');
  });

  it('variante thousands encurta a escala', () => {
    render(<MoneyDisplay value={96400} variant="thousands" />);
    expect(norm(screen.getByText(/R\$/).textContent ?? '')).toBe('R$ 96,4 mil');
  });

  it('nunca quebra linha: whitespace-nowrap presente', () => {
    render(<MoneyDisplay value={1350} />);
    expect(screen.getByText(/R\$/)).toHaveClass('whitespace-nowrap');
  });

  it('emphasis usa a fonte de título', () => {
    render(<MoneyDisplay value={1350} emphasis />);
    expect(screen.getByText(/R\$/)).toHaveClass('font-heading');
  });
});
