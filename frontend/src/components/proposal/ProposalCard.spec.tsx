import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Proposal } from '@crm-lab/shared';
import ProposalCard from './ProposalCard';

function buildProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-1',
    proposalNumber: 1,
    origin: 'crm',
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
    lisRequisitionNumber: null,
    lisIssuedOn: null,
    lisAttendantName: null,
    ...overrides,
  };
}

/** Cartão que nasceu do orçamento do Bitlab (CRMLAB-57, D-195). */
function bitlabProposal(overrides: Partial<Proposal> = {}): Proposal {
  return buildProposal({
    origin: 'bitlab',
    conversationId: null,
    createdBy: null,
    createdByName: '',
    patientName: 'Joana do Bitlab',
    status: 'novo_contato',
    approvalStatus: 'none',
    closedAt: null,
    totalPrice: 150.5,
    lisBudgetNumber: '5001',
    lisIssuedOn: '2026-09-20',
    lisAttendantName: 'MARIA SOUZA',
    ...overrides,
  });
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

  it('rótulo do primeiro estágio é "Novo orçamento"', () => {
    render(<ProposalCard proposal={buildProposal({ status: 'novo_contato', closedAt: null })} />);
    expect(screen.getByText('Novo orçamento')).toBeInTheDocument();
  });

  it('proposta do CRM não mostra nada de Bitlab', () => {
    render(<ProposalCard proposal={buildProposal({ status: 'novo_contato', closedAt: null })} />);
    expect(screen.queryByText('Bitlab')).not.toBeInTheDocument();
    expect(screen.queryByText('Sem conversa vinculada')).not.toBeInTheDocument();
  });
});

// CRMLAB-57 — PAGES.md §5: cartão de origem Bitlab.
describe('ProposalCard de origem Bitlab', () => {
  it('mostra nome do paciente, nº e data do orçamento, atendente do Bitlab e o aviso sem conversa', () => {
    render(<ProposalCard proposal={bitlabProposal()} />);
    expect(screen.getByText('Joana do Bitlab')).toBeInTheDocument();
    expect(screen.getByText('Bitlab')).toBeInTheDocument();
    expect(screen.getByText(/Orç\. LIS 5001/)).toHaveTextContent('Orç. LIS 5001 · 20/09/2026');
    expect(screen.getByText('MARIA SOUZA')).toBeInTheDocument();
    expect(screen.getByText('Sem conversa vinculada')).toBeInTheDocument();
    expect(screen.queryByText('Pré-cadastro feito')).not.toBeInTheDocument();
  });

  it('selo "Pré-cadastro feito" quando o orçamento já tem requisição e está em "Novo orçamento"', () => {
    render(<ProposalCard proposal={bitlabProposal({ lisRequisitionNumber: '001-0001234' })} />);
    expect(screen.getByText('Pré-cadastro feito')).toBeInTheDocument();
    expect(screen.queryByText('Conciliado')).not.toBeInTheDocument();
  });

  it('proposta de origem crm com requisição em "Novo orçamento" também mostra o selo (D-252)', () => {
    render(
      <ProposalCard
        proposal={bitlabProposal({ origin: 'crm', lisRequisitionNumber: '001-0001234' })}
      />,
    );
    expect(screen.getByText('Pré-cadastro feito')).toBeInTheDocument();
  });

  it('fora de "Novo orçamento" o selo de pré-cadastro some', () => {
    render(
      <ProposalCard
        proposal={bitlabProposal({ status: 'orcamento_enviado', lisRequisitionNumber: '001-0001234' })}
      />,
    );
    expect(screen.queryByText('Pré-cadastro feito')).not.toBeInTheDocument();
  });

  it('com conversa vinculada o aviso não aparece', () => {
    render(<ProposalCard proposal={bitlabProposal({ conversationId: 'conv-9' })} />);
    expect(screen.queryByText('Sem conversa vinculada')).not.toBeInTheDocument();
  });
});

// CRMLAB-59/D-207 — PAGES.md §5: selo "Parado há N h" calculado com a mesma função do motor.
describe('ProposalCard — Novo orçamento parado', () => {
  const rule = { enabled: true, hours: 4 };
  const entered = '2026-09-21T13:00:00.000Z';

  it('mostra "Parado há N h" em "Novo orçamento" depois de N horas', () => {
    render(
      <ProposalCard
        proposal={bitlabProposal({ stageEnteredAt: entered })}
        staleAlert={rule}
        now={new Date('2026-09-21T18:30:00.000Z')}
      />,
    );
    expect(screen.getByText('Parado há 5 h')).toBeInTheDocument();
  });

  it('antes do prazo, com a regra desligada, fora da coluna ou sem a regra: sem selo', () => {
    const { rerender } = render(
      <ProposalCard
        proposal={bitlabProposal({ stageEnteredAt: entered })}
        staleAlert={rule}
        now={new Date('2026-09-21T16:59:00.000Z')}
      />,
    );
    expect(screen.queryByText(/Parado há/)).not.toBeInTheDocument();

    const later = new Date('2026-09-22T13:00:00.000Z');
    rerender(
      <ProposalCard
        proposal={bitlabProposal({ stageEnteredAt: entered })}
        staleAlert={{ ...rule, enabled: false }}
        now={later}
      />,
    );
    expect(screen.queryByText(/Parado há/)).not.toBeInTheDocument();

    rerender(
      <ProposalCard
        proposal={bitlabProposal({ status: 'orcamento_enviado', stageEnteredAt: entered })}
        staleAlert={rule}
        now={later}
      />,
    );
    expect(screen.queryByText(/Parado há/)).not.toBeInTheDocument();

    rerender(<ProposalCard proposal={bitlabProposal({ stageEnteredAt: entered })} now={later} />);
    expect(screen.queryByText(/Parado há/)).not.toBeInTheDocument();
  });
});
