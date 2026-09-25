import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ProposalDetail, UpdateProposalLisReferenceRequest } from '@crm-lab/shared';
import { ApiError } from '@/api/client';
import * as proposalsApi from '@/api/proposals';
import { mutationIdle } from '@/test/query-mocks';
import { ToastProvider } from '@/components/ui';
import LisReferenceSection from './LisReferenceSection';

vi.mock('@/api/proposals');

type Vars = { proposalId: string } & UpdateProposalLisReferenceRequest;
type Callbacks = { onSuccess?: (detail: ProposalDetail) => void; onError?: (err: Error) => void };

function buildProposal(overrides: Partial<ProposalDetail> = {}): ProposalDetail {
  return {
    id: 'prop-1',
    proposalNumber: 7,
    conversationId: 'conv-1',
    patientName: 'Maria',
    patientPhone: '48999999999',
    status: 'orcamento_enviado',
    discountPercent: 0,
    totalPrice: 100,
    subtotal: 100,
    items: [],
    createdBy: 'user-1',
    createdByName: 'Ana',
    approvalStatus: 'approved',
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
    rejectionReason: null,
    reasonLost: null,
    sentAt: null,
    history: [],
    createdAt: '2026-09-20T10:00:00Z',
    updatedAt: '2026-09-20T10:00:00Z',
    closedAt: null,
    insuranceId: null,
    requestingDoctor: null,
    lisBudgetNumber: null,
    lisReconciledAt: null,
    lisRequisitionNumber: null,
    lisPaidValue: null,
    lisPaidOn: null,
    ...overrides,
  };
}

let mutate: ReturnType<typeof vi.fn>;

function renderSection(proposal: ProposalDetail) {
  return render(
    <ToastProvider>
      <LisReferenceSection proposal={proposal} />
    </ToastProvider>,
  );
}

function typeAndSave(value: string) {
  fireEvent.click(screen.getByRole('button', { name: /Informar|Alterar/ }));
  fireEvent.change(screen.getByLabelText('Nº do orçamento no LIS'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
}

describe('LisReferenceSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutate = vi.fn();
    vi.mocked(proposalsApi.useUpdateProposalLisReference).mockReturnValue(
      mutationIdle<ProposalDetail, Vars>(mutate),
    );
  });

  it('sem vínculo mostra "Informar" e envia o número digitado', () => {
    renderSection(buildProposal());
    typeAndSave('001234');
    expect(mutate).toHaveBeenCalledWith(
      { proposalId: 'prop-1', lisBudgetNumber: '001234' },
      expect.any(Object),
    );
  });

  it('campo vazio pede confirmação e envia null para desvincular', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderSection(buildProposal({ lisBudgetNumber: '1234' }));
    typeAndSave('');
    expect(confirm).toHaveBeenCalledWith('Desvincular do orçamento do LIS?');
    expect(mutate).toHaveBeenCalledWith({ proposalId: 'prop-1', lisBudgetNumber: null }, expect.any(Object));
    confirm.mockRestore();
  });

  it('número já usado mostra a proposta dona no campo', () => {
    mutate.mockImplementation((_vars: Vars, callbacks: Callbacks) => {
      callbacks.onError?.(
        new ApiError('CONFLICT', 'conflito', 409, { reason: 'lis_budget_number_taken', proposalNumber: 3 }),
      );
    });
    renderSection(buildProposal());
    typeAndSave('1234');
    expect(screen.getByRole('alert').textContent).toMatch(/já está vinculado à proposta/);
  });

  it('resposta em ganho avisa que o LIS já tinha convertido', () => {
    mutate.mockImplementation((_vars: Vars, callbacks: Callbacks) => {
      callbacks.onSuccess?.(buildProposal({ status: 'ganho', lisBudgetNumber: '1234' }));
    });
    renderSection(buildProposal());
    typeAndSave('1234');
    expect(
      screen.getByText('Orçamento já convertido no LIS — proposta marcada como ganha'),
    ).toBeTruthy();
  });

  it('proposta ganha: só leitura, com selo e pagamento', () => {
    renderSection(
      buildProposal({
        status: 'ganho',
        lisBudgetNumber: '1234',
        lisReconciledAt: '2026-09-25T14:00:00Z',
        lisRequisitionNumber: '001-0009876',
        lisPaidValue: 100,
        lisPaidOn: '2026-09-28',
      }),
    );
    expect(screen.queryByRole('button', { name: /Informar|Alterar/ })).toBeNull();
    expect(screen.getByText('Conciliado')).toBeTruthy();
    expect(screen.getByText(/Pago no LIS/).textContent).toMatch(/28\/09\/2026/);
  });
});
