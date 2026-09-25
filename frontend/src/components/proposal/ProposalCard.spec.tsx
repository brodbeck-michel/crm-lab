import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Proposal } from '@crm-lab/shared';
import ProposalCard from './ProposalCard';

function buildProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-1',
    proposalNumber: 1,
    conversationId: 'conv-1',
    patientName: 'Maria',
    status: 'ganho',
    discountPercent: 0,
    totalPrice: 100,
    createdBy: 'user-1',
    createdByName: 'Ana',
    approvalStatus: 'approved',
    reasonLost: null,
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    closedAt: '2026-09-25T10:00:00.000Z',
    insuranceId: null,
    lisBudgetNumber: null,
    lisReconciledAt: null,
    ...overrides,
  };
}

// CRMLAB-52/D-119 — PAGES.md §5: o pipeline lê `lisReconciledAt` da listagem.
describe('ProposalCard', () => {
  it('mostra o selo "Conciliado" quando o LIS fechou a proposta', () => {
    render(<ProposalCard proposal={buildProposal({ lisBudgetNumber: '1234', lisReconciledAt: '2026-09-25T10:00:00.000Z' })} />);
    expect(screen.getByText('Conciliado')).toBeInTheDocument();
  });

  it('ganho marcado à mão não leva o selo', () => {
    render(<ProposalCard proposal={buildProposal()} />);
    expect(screen.queryByText('Conciliado')).not.toBeInTheDocument();
  });
});
