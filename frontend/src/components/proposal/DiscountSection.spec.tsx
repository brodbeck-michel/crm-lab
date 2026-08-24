import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import DiscountSection from './DiscountSection';

/**
 * Defeito QA-E2E #4: o `<label>` "Desconto (%)" não estava associado ao input —
 * nem leitor de tela nem `getByLabel` alcançavam o campo.
 */
describe('DiscountSection', () => {
  it('associa o rótulo "Desconto (%)" ao campo', () => {
    render(
      <DiscountSection discountPercent={10} discountLimit={15} onChange={vi.fn()} />,
    );

    const field = screen.getByLabelText('Desconto (%)');
    expect(field).toHaveValue(10);
  });

  it('avisa quando o desconto excede a alçada', () => {
    render(
      <DiscountSection discountPercent={30} discountLimit={15} onChange={vi.fn()} />,
    );

    expect(screen.getByText('Exigirá aprovação do gestor')).toBeInTheDocument();
  });
});
