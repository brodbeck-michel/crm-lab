import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FUNNEL_RULES } from '@crm-lab/shared';
import * as funnelRulesApi from '@/api/funnel-rules';
import BudgetNew from './New';

vi.mock('@/api/funnel-rules', async (importOriginal) => ({
  ...(await importOriginal<typeof funnelRulesApi>()),
  useEffectiveFunnelRules: vi.fn(),
}));

/** CRMLAB-56 (D-193): origem manual desligada nas Regras. */
describe('BudgetNew com "Criar proposta manualmente no CRM" desligado', () => {
  it('mostra o aviso em vez do formulário', () => {
    vi.mocked(funnelRulesApi.useEffectiveFunnelRules).mockReturnValue({
      ...DEFAULT_FUNNEL_RULES,
      origin: { fromBitlab: true, manualInCrm: false },
    });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/budget/new?conversationId=conv-1']}>
          <BudgetNew />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByText('A criação manual de propostas está desligada.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /criar proposta/i })).not.toBeInTheDocument();
  });
});
