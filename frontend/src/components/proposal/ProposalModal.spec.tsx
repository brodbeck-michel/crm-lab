import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type {
  Insurance,
  ListInsurancesResponse,
  ProposalDetail,
  ProposalItem,
  UpdateProposalStatusRequest,
} from '@crm-lab/shared';
import { querySuccess, mutationIdle } from '@/test/query-mocks';
import type { UpdateProposalStatusResponse } from '@/api/proposals';
import ProposalModal from './ProposalModal';
import * as proposalsApi from '@/api/proposals';
import * as insurancesApi from '@/api/insurances';
import { queryClient } from '@/api/query-client';

vi.mock('@/api/proposals');
vi.mock('@/api/insurances');

/** Convênio usado nos testes de resolução de nome/badge (D-082). */
const UNIMED: Insurance = {
  id: 'ins-1',
  name: 'Unimed Tubarão',
  officialName: null,
  ansCode: '364860',
  type: 'cooperativa',
  isActive: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function buildItem(overrides: Partial<ProposalItem> = {}): ProposalItem {
  return {
    id: 'item-1',
    examId: 'exam-1',
    examName: 'Hemograma',
    quantity: 1,
    unitPrice: 50,
    priceSource: 'private',
    ...overrides,
  };
}

function buildProposal(overrides: Partial<ProposalDetail> = {}): ProposalDetail {
  return {
    id: 'prop-1',
    conversationId: 'conv-1',
    patientName: 'João Silva',
    patientPhone: '11999999999',
    status: 'orcamento_enviado',
    discountPercent: 0,
    totalPrice: 100,
    subtotal: 100,
    createdBy: 'user-1',
    createdByName: 'Maria',
    approvalStatus: 'none',
    reasonLost: null,
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
    rejectionReason: null,
    sentAt: null,
    closedAt: null,
    createdAt: '2026-08-24T10:00:00Z',
    updatedAt: '2026-08-24T10:00:00Z',
    items: [],
    history: [],
    ...overrides,
    // `overrides` é `Partial<ProposalDetail>`: `insuranceId` chega opcional
    // (`string | null | undefined`), mas o tipo exige `string | null`. Sem
    // esta linha depois do spread, o `undefined` vaza pro retorno (mesma
    // correção de `InternalChat.spec.tsx`).
    insuranceId: overrides.insuranceId ?? null,
  };
}

function mockProposalDetail(proposal: ProposalDetail) {
  vi.mocked(proposalsApi.useProposalDetail).mockReturnValue(
    querySuccess<ProposalDetail>(proposal),
  );
  vi.mocked(proposalsApi.useUpdateProposalStatus).mockReturnValue(
    mutationIdle<UpdateProposalStatusResponse, { proposalId: string } & UpdateProposalStatusRequest>(),
  );
}

function mockInsurances(insurances: Insurance[]) {
  vi.mocked(insurancesApi.useInsuranceList).mockReturnValue(
    querySuccess<ListInsurancesResponse>({
      insurances,
      pagination: { page: 1, limit: 100, total: insurances.length, totalPages: 1 },
    }),
  );
}

function renderModal() {
  return render(
    <QueryClientProvider client={queryClient}>
      <ProposalModal proposalId="prop-1" onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe('ProposalModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsurances([]);
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
          priceSource: 'private' as const,
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
      insuranceId: null,
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
      insuranceId: null,
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

  it('resolve o NOME real do convênio via useInsuranceList, não um rótulo genérico', () => {
    mockInsurances([UNIMED]);
    mockProposalDetail(buildProposal({ insuranceId: UNIMED.id }));

    renderModal();

    expect(screen.getByText('Unimed Tubarão')).toBeInTheDocument();
    // "Convênio" só deve aparecer como o RÓTULO estático ao lado do chip — se
    // o chip também caísse no fallback genérico, o texto apareceria 2x.
    expect(screen.getAllByText('Convênio')).toHaveLength(1);
  });

  it('insuranceId null mostra "Particular" e não inventa nome de convênio', () => {
    // Convênio existe na lista — uma implementação degenerada que ignorasse
    // `insuranceId` e mostrasse o primeiro da lista precisa falhar aqui.
    mockInsurances([UNIMED]);
    mockProposalDetail(buildProposal({ insuranceId: null }));

    renderModal();

    expect(screen.getByText('Particular')).toBeInTheDocument();
    expect(screen.queryByText('Unimed Tubarão')).not.toBeInTheDocument();
  });

  it('badge de origem aparece só no item particular, com convênio selecionado', () => {
    mockInsurances([UNIMED]);
    mockProposalDetail(
      buildProposal({
        insuranceId: UNIMED.id,
        items: [
          buildItem({ id: 'i-1', examId: 'exam-1', examName: 'Hemograma', priceSource: 'private' }),
          buildItem({ id: 'i-2', examId: 'exam-2', examName: 'Glicose', priceSource: 'insurance' }),
        ],
      }),
    );

    renderModal();

    // Cabeçalho mostra o nome do convênio (não "Particular") — então
    // qualquer "Particular" na tela só pode vir do badge por item.
    const privateRow = screen.getByText('Hemograma').closest('div');
    const insuranceRow = screen.getByText('Glicose').closest('div');
    expect(within(privateRow!).getByText('Particular')).toBeInTheDocument();
    expect(within(insuranceRow!).queryByText('Particular')).not.toBeInTheDocument();
  });

  it('proposta inteiramente particular não mostra badge por item (seria redundante)', () => {
    mockInsurances([]);
    mockProposalDetail(
      buildProposal({
        insuranceId: null,
        items: [buildItem({ id: 'i-1', examId: 'exam-1', examName: 'Hemograma', priceSource: 'private' })],
      }),
    );

    renderModal();

    const row = screen.getByText('Hemograma').closest('div');
    expect(within(row!).queryByText('Particular')).not.toBeInTheDocument();
    // "Particular" aparece 1x só — o chip do cabeçalho, não o badge do item.
    expect(screen.getAllByText('Particular')).toHaveLength(1);
  });
});
