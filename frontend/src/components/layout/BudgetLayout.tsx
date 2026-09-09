import type { ReactNode } from 'react';
import { cn } from '@/components/ui';

/**
 * BudgetLayout — 2 colunas: `flex 1 min 520px | 372px`, total em RODAPÉ FIXO
 * da coluna direita (COMPONENTS.md `layout/` + DESIGN_TOKENS.md "Orçamento").
 *
 * O rodapé é `position: sticky; bottom: 0` — o total nunca sai da vista
 * enquanto a lista de itens rola. O valor exibido ali é sempre DERIVADO de
 * items + desconto (BUSINESS_RULES §1); esta camada só reserva o espaço.
 */

export interface BudgetLayoutProps {
  /** Coluna esquerda — catálogo (flex, mínimo 520px). */
  catalog: ReactNode;
  /** Coluna direita — itens do orçamento (372px). */
  summary: ReactNode;
  /** Rodapé fixo da coluna direita — total + ação. */
  total: ReactNode;
  className?: string;
}

export const BUDGET_CATALOG_MIN_WIDTH = 520;
export const BUDGET_SUMMARY_WIDTH = 372;

export function BudgetLayout({ catalog, summary, total, className }: BudgetLayoutProps) {
  return (
    <div
      data-testid="budget-layout"
      className={cn('flex h-screen w-full overflow-x-auto bg-bg', className)}
    >
      <section
        data-testid="budget-catalog"
        aria-label="Catálogo de exames"
        style={{ flex: '1 1 0%', minWidth: BUDGET_CATALOG_MIN_WIDTH }}
        className="flex flex-col overflow-y-auto"
      >
        {catalog}
      </section>

      <aside
        data-testid="budget-summary"
        aria-label="Resumo do orçamento"
        style={{ flex: `0 0 ${BUDGET_SUMMARY_WIDTH}px`, width: BUDGET_SUMMARY_WIDTH }}
        className="flex flex-col border-l border-neutral-300 bg-surface"
      >
        <div className="min-h-0 flex-1 overflow-y-auto">{summary}</div>

        <footer
          data-testid="budget-total"
          style={{ position: 'sticky', bottom: 0 }}
          className="border-t border-neutral-300 bg-surface px-lg py-md"
        >
          {total}
        </footer>
      </aside>
    </div>
  );
}
