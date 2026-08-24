import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BudgetLayout, BUDGET_CATALOG_MIN_WIDTH, BUDGET_SUMMARY_WIDTH } from './BudgetLayout';

/**
 * BudgetLayout — `flex 1 min 520px | 372px`, total em rodapé fixo
 * (COMPONENTS.md `layout/` · DESIGN_TOKENS.md "Orçamento").
 */

function renderLayout() {
  return render(
    <BudgetLayout
      catalog={<div>catálogo</div>}
      summary={<div>itens</div>}
      total={<div>total</div>}
    />,
  );
}

describe('BudgetLayout — larguras do doc', () => {
  it('catálogo é flexível COM min-width explícito de 520px', () => {
    renderLayout();
    const catalog = screen.getByTestId('budget-catalog');
    expect(catalog.style.flex).toBe('1 1 0%');
    expect(catalog).toHaveStyle({ minWidth: `${BUDGET_CATALOG_MIN_WIDTH}px` });
  });

  it('resumo tem 372px fixos', () => {
    renderLayout();
    const summary = screen.getByTestId('budget-summary');
    expect(summary).toHaveStyle({ width: `${BUDGET_SUMMARY_WIDTH}px` });
    expect(summary.style.flex).toBe('0 0 372px');
  });

  it('a linha rola no eixo x em tela estreita', () => {
    renderLayout();
    expect(screen.getByTestId('budget-layout').className).toContain('overflow-x-auto');
  });
});

describe('BudgetLayout — total em rodapé fixo', () => {
  it('o rodapé do total é sticky no fundo da coluna de resumo', () => {
    renderLayout();
    const total = screen.getByTestId('budget-total');
    expect(total).toHaveStyle({ position: 'sticky', bottom: '0px' });
    expect(screen.getByTestId('budget-summary').contains(total)).toBe(true);
  });

  it('renderiza as três áreas', () => {
    renderLayout();
    expect(screen.getByText('catálogo')).toBeInTheDocument();
    expect(screen.getByText('itens')).toBeInTheDocument();
    expect(screen.getByText('total')).toBeInTheDocument();
  });
});
