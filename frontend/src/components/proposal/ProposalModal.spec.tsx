import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ProposalDetail, UpdateProposalStatusRequest } from '@crm-lab/shared';
import { querySuccess, mutationIdle } from '@/test/query-mocks';
import type { UpdateProposalStatusResponse } from '@/api/proposals';
import ProposalModal from './ProposalModal';
import * as proposalsApi from '@/api/proposals';
import { queryClient } from '@/api/query-client';

vi.mock('@/api/proposals');

describe('ProposalModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders items, discount, total, and history', () => {
    const mockProposal: ProposalDetail = {
      id: 'prop-1',
      conversationId: 'conv-1',
      patientName: 'João Silva',
      patientPhone: '11999999999',
      status: 'orcamento_enviado' as const,
      items: [
        {
          id: 'item-1',
          examId: 'exam-1',
          examName: 'Hemograma',
          quantity: 1,
          unitPrice: 50,
        },
      ],
      discountPercent: 10,
      totalPrice: 45,
      subtotal: 50,
      createdBy: 'user-1',
      createdByName: 'Maria',
      approvalStatus: 'none' as const,
      reasonLost: null,
      approvedBy: null,
      approvedByName: null,
      approvedAt: null,
      rejectionReason: null,
      sentAt: null,
      closedAt: null,
      createdAt: '2026-08-24T10:00:00Z',
      updatedAt: '2026-08-24T10:00:00Z',
      history: [
        {
          status: 'novo_contato' as const,
          changedAt: '2026-08-24T10:00:00Z',
          changedBy: 'user-1',
          changedByName: 'Maria',
        },
      ],
    };

    vi.mocked(proposalsApi.useProposalDetail).mockReturnValue(
      querySuccess<ProposalDetail>(mockProposal),
    );

    vi.mocked(proposalsApi.useUpdateProposalStatus).mockReturnValue(
      mutationIdle<
        UpdateProposalStatusResponse,
        { proposalId: string } & UpdateProposalStatusRequest
      >(),
    );

    render(
      <QueryClientProvider client={queryClient}>
        <ProposalModal proposalId="prop-1" onClose={() => {}} />
      </QueryClientProvider>
    );

    expect(screen.getByText('João Silva')).toBeInTheDocument();
    expect(screen.getByText('Hemograma')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /histórico/i })).toBeInTheDocument();
  });

  it('renders approval alert when approvalStatus is pending', () => {
    const mockProposal: ProposalDetail = {
      id: 'prop-1',
      conversationId: 'conv-1',
      patientName: 'João Silva',
      patientPhone: '11999999999',
      status: 'orcamento_enviado' as const,
      items: [],
      discountPercent: 15,
      totalPrice: 100,
      subtotal: 100,
      createdBy: 'user-1',
      createdByName: 'Maria',
      approvalStatus: 'pending' as const,
      reasonLost: null,
      approvedBy: null,
      approvedByName: null,
      approvedAt: null,
      rejectionReason: null,
      sentAt: null,
      closedAt: null,
      createdAt: '2026-08-24T10:00:00Z',
      updatedAt: '2026-08-24T10:00:00Z',
      history: [],
    };

    vi.mocked(proposalsApi.useProposalDetail).mockReturnValue(
      querySuccess<ProposalDetail>(mockProposal),
    );

    vi.mocked(proposalsApi.useUpdateProposalStatus).mockReturnValue(
      mutationIdle<
        UpdateProposalStatusResponse,
        { proposalId: string } & UpdateProposalStatusRequest
      >(),
    );

    render(
      <QueryClientProvider client={queryClient}>
        <ProposalModal proposalId="prop-1" onClose={() => {}} />
      </QueryClientProvider>
    );

    expect(screen.getByText(/aguardando aprovação/i)).toBeInTheDocument();
  });
});
