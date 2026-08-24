import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Channel,
  InternalMessage,
  ListChannelsResponse,
  ListInternalMessagesResponse,
  ProposalDetail,
} from '@crm-lab/shared';
import type * as ApiModule from '@/api';

const channelsMock = vi.fn();
const messagesMock = vi.fn();
const sendMock = vi.fn();
const getProposalMock = vi.fn();
const approveMock = vi.fn();
const rejectMock = vi.fn();

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      internalChat: {
        ...actual.api.internalChat,
        channels: channelsMock,
        messages: messagesMock,
        send: sendMock,
      },
      proposals: {
        ...actual.api.proposals,
        get: getProposalMock,
        approve: approveMock,
        reject: rejectMock,
      },
    },
  };
});

const { ApiError } = await import('@/api');
const { ToastProvider } = await import('@/components/ui');
const { useAuthStore, useUIStore } = await import('@/stores');
const { InternalChat } = await import('./index');

/**
 * Chat Interno — PAGES.md §9 · WORKFLOWS.md §3 e §6.
 *
 * O que este teste protege: os canais aparecem, a mensagem sai pelo endpoint
 * certo, [Aprovar]/[Rejeitar] chamam os PATCH corretos (rejeição SEMPRE com
 * motivo) e a auto-aprovação (D-046) vira um toast explicativo — nunca um
 * estado otimista de "aprovado".
 */

const GERAL: Channel = {
  id: '11111111-1111-4111-8111-111111111111',
  key: 'geral',
  name: '#geral',
  kind: 'channel',
  unreadCount: 0,
  lastMessageAt: '2026-08-23T09:00:00Z',
};

const APROVACOES: Channel = {
  id: '22222222-2222-4222-8222-222222222222',
  key: 'aprovacoes',
  name: '#aprovacoes',
  kind: 'channel',
  unreadCount: 2,
  lastMessageAt: '2026-08-23T10:00:00Z',
};

const DM: Channel = {
  id: '33333333-3333-4333-8333-333333333333',
  key: 'dm-marina',
  name: 'Marina Alves',
  kind: 'dm',
  unreadCount: 0,
  lastMessageAt: null,
};

const PROPOSAL_ID = '44444444-4444-4444-8444-444444444444';

function message(overrides: Partial<InternalMessage> = {}): InternalMessage {
  return {
    id: 'm-1',
    channelId: GERAL.id,
    senderId: 'u-9',
    senderName: 'Carla Souza',
    content: 'Bom dia, equipe!',
    attachedProposalId: null,
    isSystem: false,
    createdAt: '2026-08-23T09:00:00Z',
    ...overrides,
  };
}

const APPROVAL_POST = message({
  id: 'm-2',
  channelId: APROVACOES.id,
  senderId: null,
  senderName: 'Sistema',
  content: '@gestor Pedido de aprovação de desconto: Marina Alves',
  attachedProposalId: PROPOSAL_ID,
  isSystem: true,
  createdAt: '2026-08-23T10:00:00Z',
});

function messagesResponse(messages: InternalMessage[]): ListInternalMessagesResponse {
  return {
    messages,
    pagination: { page: 1, limit: 50, total: messages.length, totalPages: 1 },
  };
}

function proposal(overrides: Partial<ProposalDetail> = {}): ProposalDetail {
  return {
    id: PROPOSAL_ID,
    conversationId: 'c-1',
    patientName: 'Marina Alves',
    patientPhone: '(11) 98765-4321',
    status: 'novo_contato',
    discountPercent: 40,
    totalPrice: 179.8,
    subtotal: 299.67,
    createdBy: 'u-9',
    createdByName: 'Carla Souza',
    approvalStatus: 'pending',
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
    rejectionReason: null,
    reasonLost: null,
    sentAt: null,
    items: [],
    history: [],
    createdAt: '2026-08-23T09:50:00Z',
    updatedAt: '2026-08-23T09:50:00Z',
    closedAt: null,
    ...overrides,
  };
}

const CHANNELS: ListChannelsResponse = { channels: [GERAL, APROVACOES, DM] };

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/internal-chat']}>
          <InternalChat />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** Abre `#aprovacoes` e espera o cartão da proposta anexada. */
async function openApprovals(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /#aprovacoes/ }));
  await screen.findByRole('button', { name: /Aprovar/ });
}

beforeEach(() => {
  vi.clearAllMocks();
  useUIStore.setState({ activeModal: null });
  useAuthStore.setState({
    user: {
      id: 'u-1',
      email: 'gestor@lab.com',
      name: 'Ana Gestora',
      role: 'manager',
      discountLimit: 30,
    },
    tenant: null,
    theme: null,
    tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 60_000 },
  });

  channelsMock.mockResolvedValue(CHANNELS);
  messagesMock.mockImplementation((channelId: string) =>
    Promise.resolve(
      messagesResponse(channelId === APROVACOES.id ? [APPROVAL_POST] : [message()]),
    ),
  );
  sendMock.mockResolvedValue(message({ id: 'm-3', content: 'Combinado' }));
  getProposalMock.mockResolvedValue(proposal());
  approveMock.mockResolvedValue({
    id: PROPOSAL_ID,
    approvalStatus: 'approved',
    approvedAt: '2026-08-23T10:05:00Z',
  });
  rejectMock.mockResolvedValue({
    id: PROPOSAL_ID,
    approvalStatus: 'rejected',
    approvedAt: null,
  });
});

describe('Chat Interno', () => {
  it('lista canais e mensagens diretas e abre o primeiro canal', async () => {
    renderScreen();

    expect(await screen.findByRole('button', { name: /#geral/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /#aprovacoes/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Mensagens diretas' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Marina Alves/ })).toBeInTheDocument();

    // Abre `#geral` sozinho e mostra as mensagens dele.
    expect(await screen.findByText('Bom dia, equipe!')).toBeInTheDocument();
  });

  it('mostra o vazio do canal sem deixar área em branco', async () => {
    messagesMock.mockResolvedValue(messagesResponse([]));
    renderScreen();

    expect(await screen.findByText('Nenhuma mensagem ainda')).toBeInTheDocument();
  });

  it('mostra o erro do painel com ação de repetir', async () => {
    messagesMock.mockRejectedValue(new ApiError('INTERNAL_ERROR', 'falhou', 500));
    renderScreen();

    expect(await screen.findByText('Não foi possível carregar o canal')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeInTheDocument();
  });

  it('envia mensagem para o canal aberto', async () => {
    const user = userEvent.setup({ delay: null });
    renderScreen();
    await screen.findByText('Bom dia, equipe!');

    await user.type(screen.getByLabelText('Mensagem'), 'Combinado');
    await user.click(screen.getByRole('button', { name: 'Enviar' }));

    await waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith(GERAL.id, { content: 'Combinado' });
    });
  });

  it('aprova o pedido de #aprovacoes pelo PATCH /proposals/:id/approve', async () => {
    const user = userEvent.setup({ delay: null });
    renderScreen();
    await openApprovals(user);

    await user.click(screen.getByRole('button', { name: 'Aprovar' }));

    await waitFor(() => {
      expect(approveMock).toHaveBeenCalledWith(PROPOSAL_ID);
    });
    expect(await screen.findByText('Desconto aprovado.')).toBeInTheDocument();
  });

  it('exige motivo para rejeitar e envia o motivo digitado', async () => {
    const user = userEvent.setup({ delay: null });
    renderScreen();
    await openApprovals(user);

    await user.click(screen.getByRole('button', { name: 'Rejeitar' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar rejeição' }));

    expect(rejectMock).not.toHaveBeenCalled();
    expect(await screen.findByText('Informe o motivo da rejeição.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Motivo da rejeição'), 'Desconto fora da tabela');
    await user.click(screen.getByRole('button', { name: 'Confirmar rejeição' }));

    await waitFor(() => {
      expect(rejectMock).toHaveBeenCalledWith(PROPOSAL_ID, {
        reason: 'Desconto fora da tabela',
      });
    });
  });

  it('explica a recusa de auto-aprovação (D-046) em vez de fingir sucesso', async () => {
    approveMock.mockRejectedValue(
      new ApiError('FORBIDDEN', 'Acesso negado', 403, { reason: 'self_approval' }),
    );

    const user = userEvent.setup({ delay: null });
    renderScreen();
    await openApprovals(user);

    await user.click(screen.getByRole('button', { name: 'Aprovar' }));

    expect(
      await screen.findByText(/Você não pode aprovar a própria proposta/),
    ).toBeInTheDocument();
    // Nada de otimismo: o botão continua lá para outra tentativa.
    expect(screen.getByRole('button', { name: 'Aprovar' })).toBeInTheDocument();
  });

  it('não oferece decisão para atendente', async () => {
    useAuthStore.setState({
      user: {
        id: 'u-2',
        email: 'atendente@lab.com',
        name: 'Bia Atendente',
        role: 'attendant',
        discountLimit: 15,
      },
    });

    const user = userEvent.setup({ delay: null });
    renderScreen();
    await user.click(await screen.findByRole('button', { name: /#aprovacoes/ }));

    expect(await screen.findByText(/Pedido de aprovação de desconto/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aprovar' })).not.toBeInTheDocument();
  });
});
