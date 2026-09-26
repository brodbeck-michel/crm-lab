import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Conversation, ListConversationsResponse, ProposalDetail } from '@crm-lab/shared';
import { DEFAULT_SEND_MESSAGE_TEMPLATE } from '@crm-lab/shared';
import { ApiError } from '@/api';
import { conversationsApi } from '@/api/conversations';
import * as proposalsApi from '@/api/proposals';
import { mutationIdle } from '@/test/query-mocks';
import SendProposalPanel, { rankCandidates } from './SendProposalPanel';

vi.mock('@/api/conversations');
vi.mock('@/api/proposals');

function conversation(id: string, patientName: string | null, extra: Partial<Conversation> = {}): Conversation {
  return {
    id,
    patientId: null,
    patientName,
    patientPhone: `+55489999900${id.slice(-2)}`,
    assignedTo: null,
    assignedToName: null,
    channel: 'whatsapp',
    status: 'active',
    unreadCount: 0,
    lastMessagePreview: null,
    lastMessageAt: null,
    tags: [],
    pinned: false,
    createdAt: '2026-09-26T00:00:00Z',
    ...extra,
  };
}

function listOf(conversations: Conversation[]): ListConversationsResponse {
  return {
    conversations,
    pagination: { page: 1, limit: 100, total: conversations.length, totalPages: 1 },
    counts: { mine: 0, unassigned: 0 },
  };
}

const PROPOSAL = {
  id: 'prop-1',
  proposalNumber: 7,
  origin: 'bitlab',
  conversationId: null,
  patientName: 'MARIA DA SILVA SOUZA',
  patientPhone: '',
  status: 'novo_contato',
  totalPrice: 1234.5,
  lisBudgetNumber: '5001',
  lisRequisitionNumber: null,
} as unknown as ProposalDetail;

let sendMutate: ReturnType<typeof vi.fn>;
let resendMutate: ReturnType<typeof vi.fn>;
let relinkMutate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  sendMutate = vi.fn();
  resendMutate = vi.fn();
  relinkMutate = vi.fn();
  vi.mocked(proposalsApi.useSendProposal).mockReturnValue(mutationIdle(sendMutate));
  vi.mocked(proposalsApi.useResendProposal).mockReturnValue(mutationIdle(resendMutate));
  vi.mocked(proposalsApi.useUpdateProposalConversation).mockReturnValue(mutationIdle(relinkMutate));
  vi.mocked(conversationsApi.list).mockResolvedValue(
    listOf([
      conversation('c-01', 'João Pereira'),
      conversation('c-02', 'Maria Oliveira'),
      conversation('c-03', 'Maria Souza', { assignedTo: 'u1', assignedToName: 'Ana' }),
    ]),
  );
});

function renderPanel(mode: 'send' | 'resend' | 'relink' = 'send', proposal = PROPOSAL) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onDone = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <SendProposalPanel
        proposal={proposal}
        mode={mode}
        insuranceName="Particular"
        template={DEFAULT_SEND_MESSAGE_TEMPLATE}
        target="orcamento_enviado"
        onDone={onDone}
        onCancel={() => {}}
      />
    </QueryClientProvider>,
  );
  return { onDone };
}

describe('rankCandidates', () => {
  it('sugeridas em cima pela nota; sem nota ficam na ordem do servidor', () => {
    const { suggested, others } = rankCandidates('MARIA DA SILVA SOUZA', [
      conversation('c-01', 'João Pereira'),
      conversation('c-02', 'Maria Oliveira'),
      conversation('c-03', 'Maria Souza'),
      conversation('c-04', null),
    ]);
    expect(suggested.map((c) => c.conversation.id)).toEqual(['c-03', 'c-02']);
    expect(others.map((c) => c.conversation.id)).toEqual(['c-01', 'c-04']);
  });
});

describe('SendProposalPanel', () => {
  it('mostra os dados do Bitlab, sugere a conversa pelo nome e pré-visualiza a mensagem do modelo', async () => {
    renderPanel();
    expect(screen.getByText('MARIA DA SILVA SOUZA')).toBeInTheDocument();
    expect(screen.getByText('5001')).toBeInTheDocument();

    const list = await screen.findByRole('list', { name: 'Conversas' });
    const items = within(list).getAllByRole('button');
    // Maria Souza (nota 1) > Maria Oliveira (0,5) > João (0).
    expect(items.map((b) => b.textContent)).toEqual([
      expect.stringContaining('Maria Souza'),
      expect.stringContaining('Maria Oliveira'),
      expect.stringContaining('João Pereira'),
    ]);
    expect(within(items[0]!).getByText('Sugerida')).toBeInTheDocument();
    expect(within(items[2]!).queryByText('Sugerida')).not.toBeInTheDocument();

    const message = screen.getByLabelText('Mensagem') as HTMLTextAreaElement;
    expect(message.value).toMatch(
      /^Olá, MARIA DA SILVA SOUZA! Segue o orçamento nº 5001 \(Particular\), no valor de R\$\s1\.234,50\.$/,
    );
  });

  it('nunca vincula sozinho: Enviar só liga depois de clicar numa conversa, e manda o texto editado', async () => {
    renderPanel();
    const list = await screen.findByRole('list', { name: 'Conversas' });
    const enviar = screen.getByRole('button', { name: 'Enviar' });
    expect(enviar).toBeDisabled();

    fireEvent.click(within(list).getByText('Maria Souza'));
    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: '  Oi, Maria!  ' } });
    expect(enviar).toBeEnabled();
    fireEvent.click(enviar);
    expect(sendMutate).toHaveBeenCalledWith(
      { proposalId: 'prop-1', body: { conversationId: 'c-03', message: 'Oi, Maria!' } },
      expect.anything(),
    );
  });

  it('mensagem vazia desliga o Enviar', async () => {
    renderPanel();
    const list = await screen.findByRole('list', { name: 'Conversas' });
    fireEvent.click(within(list).getByText('Maria Souza'));
    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
  });

  it('busca livre vai para o servidor como search', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderPanel();
      await screen.findByRole('list', { name: 'Conversas' });
      fireEvent.change(screen.getByLabelText('Buscar conversa'), { target: { value: '4899' } });
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      await waitFor(() =>
        expect(conversationsApi.list).toHaveBeenLastCalledWith({
          status: 'active',
          limit: 100,
          search: '4899',
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('erro do envio aparece para a atendente e o painel fica aberto', async () => {
    sendMutate.mockImplementation((_vars: unknown, handlers: { onError: (e: unknown) => void }) =>
      handlers.onError(
        new ApiError('MESSAGE_SEND_FAILED', 'Falha ao enviar a mensagem pelo canal', 502),
      ),
    );
    const { onDone } = renderPanel();
    const list = await screen.findByRole('list', { name: 'Conversas' });
    fireEvent.click(within(list).getByText('Maria Souza'));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Falha ao enviar a mensagem pelo canal');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('reenviar: só a mensagem, sem lista de conversas', () => {
    renderPanel('resend', {
      ...PROPOSAL,
      conversationId: 'c-03',
      status: 'follow_up',
    } as ProposalDetail);
    expect(screen.queryByRole('list', { name: 'Conversas' })).not.toBeInTheDocument();
    expect(conversationsApi.list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reenviar' }));
    expect(resendMutate).toHaveBeenCalledWith(
      { proposalId: 'prop-1', body: { message: expect.stringContaining('5001') } },
      expect.anything(),
    );
  });

  it('trocar conversa: só a lista, sem a vinculada e sem mensagem', async () => {
    renderPanel('relink', {
      ...PROPOSAL,
      conversationId: 'c-03',
      status: 'orcamento_enviado',
    } as ProposalDetail);
    const list = await screen.findByRole('list', { name: 'Conversas' });
    expect(within(list).queryByText('Maria Souza')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Mensagem')).not.toBeInTheDocument();
    fireEvent.click(within(list).getByText('Maria Oliveira'));
    fireEvent.click(screen.getByRole('button', { name: 'Trocar conversa' }));
    expect(relinkMutate).toHaveBeenCalledWith(
      { proposalId: 'prop-1', body: { conversationId: 'c-02' } },
      expect.anything(),
    );
  });
});
