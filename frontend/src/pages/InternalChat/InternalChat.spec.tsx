import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Channel,
  ChatDirectoryUser,
  InternalMessage,
  ListChannelsResponse,
  ListInternalMessagesResponse,
  PaginationQuery,
  ProposalDetail,
} from '@crm-lab/shared';
import type * as ApiModule from '@/api';

const channelsMock = vi.fn();
const messagesMock = vi.fn();
const sendMock = vi.fn();
const markReadMock = vi.fn();
const directoryMock = vi.fn();
const startDirectChannelMock = vi.fn();
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
        markRead: markReadMock,
        directory: directoryMock,
        startDirectChannel: startDirectChannelMock,
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
  lastReadAt: '2026-08-23T09:00:00Z',
  lastMessageAt: '2026-08-23T09:00:00Z',
  otherUserId: null,
  otherUserName: null,
};

const APROVACOES: Channel = {
  id: '22222222-2222-4222-8222-222222222222',
  key: 'aprovacoes',
  name: '#aprovacoes',
  kind: 'channel',
  unreadCount: 2,
  // Nunca lido: e o que faz `unreadCount` valer 2 (D-068).
  lastReadAt: null,
  lastMessageAt: '2026-08-23T10:00:00Z',
  otherUserId: null,
  otherUserName: null,
};

const MARINA_ID = '55555555-5555-4555-8555-555555555555';

const DM: Channel = {
  id: '33333333-3333-4333-8333-333333333333',
  key: `dm:${MARINA_ID}:u-1`,
  name: `dm:${MARINA_ID}:u-1`,
  kind: 'dm',
  unreadCount: 0,
  lastReadAt: null,
  lastMessageAt: null,
  otherUserId: MARINA_ID,
  otherUserName: 'Marina Alves',
};

const DIRECTORY_USERS: ChatDirectoryUser[] = [
  { id: MARINA_ID, name: 'Marina Alves', role: 'attendant' },
];

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
    proposalNumber: 1,
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
    // `overrides` é `Partial<ProposalDetail>`: `insuranceId` chega opcional
    // (`string | null | undefined`), mas o tipo exige `string | null`. Sem
    // esta linha depois do spread, o `undefined` vaza pro retorno.
    insuranceId: overrides.insuranceId ?? null,
    // Mesma correção para `requestingDoctor` (CRMLAB-9).
    requestingDoctor: overrides.requestingDoctor ?? null,
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
  markReadMock.mockResolvedValue(undefined);
  directoryMock.mockResolvedValue({ users: DIRECTORY_USERS });
  startDirectChannelMock.mockResolvedValue(DM);
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
    // A DM já aberta com Marina mostra o nome dela (vindo de `otherUserName`, D-101).
    expect(screen.getByRole('button', { name: /Marina Alves/ })).toBeInTheDocument();
    // A barra lateral NÃO lista usuários permanentemente — só canais e DMs (feedback:
    // a lista fixa ocupava espaço demais). Busca de usuário fica em `UserSearch`.
    expect(screen.queryByRole('heading', { name: 'Usuários' })).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: /Buscar usuário/ })).toBeInTheDocument();

    // Abre `#geral` sozinho e mostra as mensagens dele.
    expect(await screen.findByText('Bom dia, equipe!')).toBeInTheDocument();
  });

  it('busca um usuário, clica no resultado e abre (ou cria) a DM com ele', async () => {
    const user = userEvent.setup({ delay: null });
    renderScreen();

    const search = await screen.findByRole('searchbox', { name: /Buscar usuário/ });
    await waitFor(() => expect(search).not.toBeDisabled());
    await user.type(search, 'mari');

    const result = await screen.findByTestId('user-search-result');
    expect(result).toHaveTextContent('Marina Alves');
    await user.click(result);

    await waitFor(() => {
      expect(startDirectChannelMock).toHaveBeenCalledWith({ userId: MARINA_ID });
    });

    // A busca limpa depois de escolher — o resultado some da tela.
    await waitFor(() => {
      expect(screen.queryByTestId('user-search-result')).not.toBeInTheDocument();
    });
  });

  it('busca sem resultado mostra aviso, sem lançar erro', async () => {
    const user = userEvent.setup({ delay: null });
    renderScreen();

    const search = await screen.findByRole('searchbox', { name: /Buscar usuário/ });
    await waitFor(() => expect(search).not.toBeDisabled());
    await user.type(search, 'ninguém com esse nome');

    expect(await screen.findByText('Nenhum usuário encontrado')).toBeInTheDocument();
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

  it('diretório indisponível desabilita a busca em vez de travar a tela', async () => {
    directoryMock.mockRejectedValue(new ApiError('INTERNAL_ERROR', 'falhou', 500));
    renderScreen();

    // Canais continuam abrindo normalmente — a falha da busca não bloqueia o chat.
    await screen.findByRole('button', { name: /#geral/ });
    expect(await screen.findByRole('searchbox', { name: /Buscar usuário/ })).toBeDisabled();
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
  /**
   * ─────────────────────────────────────────────────────────────────────────
   *  Estado de leitura do canal — D-068 · PAGES.md §9
   * ─────────────────────────────────────────────────────────────────────────
   * A Onda 5 fechou com o badge subindo e nunca descendo (defeito D5). O
   * backend passou a expor `POST /internal-chat/channels/:id/read`; o que
   * faltava era a TELA ligar o fio. Estes testes provam o fio inteiro: o POST
   * sai ao abrir, a lista de canais é revalidada depois dele, o badge some — e
   * nada disso acontece para canal que ninguém abriu.
   */
  describe('marcar canal como lido (D-068)', () => {
    /** Faz `GET /channels` responder com `#aprovacoes` zerado depois do POST. */
    function channelsThatZeroOnRead(): string[] {
      const lidos: string[] = [];
      markReadMock.mockImplementation((channelId: string) => {
        lidos.push(channelId);
        return Promise.resolve();
      });
      channelsMock.mockImplementation(() => {
        const aprovacoes: Channel = lidos.includes(APROVACOES.id)
          ? { ...APROVACOES, unreadCount: 0, lastReadAt: '2026-08-23T11:00:00Z' }
          : APROVACOES;
        const response: ListChannelsResponse = { channels: [GERAL, aprovacoes, DM] };
        return Promise.resolve(response);
      });
      return lidos;
    }

    it('chama POST /read ao abrir o canal e o badge desce', async () => {
      channelsThatZeroOnRead();

      const user = userEvent.setup({ delay: null });
      renderScreen();

      // O badge existe ANTES de abrir — senão o teste provaria o nada.
      expect(
        await screen.findByLabelText('2 mensagens não lidas em #aprovacoes'),
      ).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /#aprovacoes/ }));

      await waitFor(() => {
        expect(markReadMock).toHaveBeenCalledWith(APROVACOES.id);
      });

      // Invalidação da lista de canais: o badge some da tela.
      await waitFor(() => {
        expect(
          screen.queryByLabelText('2 mensagens não lidas em #aprovacoes'),
        ).not.toBeInTheDocument();
      });
    });

    /**
     * O primeiro canal da lista é selecionado pela TELA, não pelo usuário. Como
     * a ordem é fixa (`kind ASC, key ASC`), esse canal seria quase sempre
     * `#aprovacoes` — apagar o badge dele só por entrar na tela apagaria o
     * aviso que a pessoa entrou para ver. Só o clique marca.
     */
    it('não marca nada só por abrir a tela, nem canal que o usuário não clicou', async () => {
      renderScreen();
      await screen.findByText('Bom dia, equipe!');

      // O canal auto-selecionado já renderizou suas mensagens e ainda assim
      // nenhum POST /read saiu.
      expect(markReadMock).not.toHaveBeenCalled();
    });

    it('marca só o canal clicado', async () => {
      const user = userEvent.setup({ delay: null });
      renderScreen();
      await screen.findByText('Bom dia, equipe!');

      await user.click(await screen.findByRole('button', { name: /#aprovacoes/ }));

      await waitFor(() => {
        expect(markReadMock).toHaveBeenCalledWith(APROVACOES.id);
      });
      expect(markReadMock).not.toHaveBeenCalledWith(DM.id);
    });

    it('marca UMA vez por clique, mesmo com a lista de canais revalidando', async () => {
      const lidos = channelsThatZeroOnRead();

      const user = userEvent.setup({ delay: null });
      renderScreen();
      await screen.findByText('Bom dia, equipe!');

      await user.click(await screen.findByRole('button', { name: /#aprovacoes/ }));
      await screen.findByRole('button', { name: /Aprovar/ });

      // A revalidação disparada pelo POST já voltou do servidor: se ela
      // realimentasse o marcar-como-lido, o contador abaixo cresceria sem
      // parar.
      await waitFor(() => {
        expect(channelsMock.mock.calls.length).toBeGreaterThan(1);
      });

      expect(lidos.filter((id) => id === APROVACOES.id)).toHaveLength(1);
    });
  });

  /**
   * ─────────────────────────────────────────────────────────────────────────
   *  Paginação do histórico — D-069 · PAGES.md §9
   * ─────────────────────────────────────────────────────────────────────────
   * `page=1` é a fatia das mensagens MAIS RECENTES. Antes, a tela assumia o
   * contrário e lia a última página em DOIS requests — com mais de 50
   * mensagens o canal abria nas mais antigas.
   */
  describe('paginação do histórico (D-069)', () => {
    const ANTIGA = message({ id: 'm-antiga', content: 'Bloco anterior' });
    const RECENTE = message({ id: 'm-recente', content: 'Bloco recente' });

    /** Canal com 2 páginas: `page=1` = recente, `page=2` = bloco anterior. */
    function paginatedChannel() {
      messagesMock.mockImplementation((_channelId: string, query: PaginationQuery = {}) => {
        const page = query.page ?? 1;
        const response: ListInternalMessagesResponse = {
          messages: page === 2 ? [ANTIGA] : [RECENTE],
          pagination: { page, limit: 50, total: 60, totalPages: 2 },
        };
        return Promise.resolve(response);
      });
    }

    it('abre no bloco mais recente com UM único request', async () => {
      paginatedChannel();
      renderScreen();

      expect(await screen.findByText('Bloco recente')).toBeInTheDocument();
      expect(screen.queryByText('Bloco anterior')).not.toBeInTheDocument();

      // Um request, não dois: o `fetchTail` (ler `totalPages`, depois buscar a
      // última página) deixou de existir.
      expect(messagesMock).toHaveBeenCalledTimes(1);
      expect(messagesMock).toHaveBeenCalledWith(GERAL.id, { page: 1, limit: 50 });
    });

    it('"carregar anteriores" pede a página SEGUINTE e a coloca acima', async () => {
      paginatedChannel();

      const user = userEvent.setup({ delay: null });
      renderScreen();
      await screen.findByText('Bloco recente');

      await user.click(screen.getByRole('button', { name: 'Carregar mensagens anteriores' }));

      expect(await screen.findByText('Bloco anterior')).toBeInTheDocument();
      expect(messagesMock).toHaveBeenCalledWith(GERAL.id, { page: 2, limit: 50 });

      // Ordem cronológica na tela: o bloco anterior vem ANTES do recente.
      const renderizado = screen.getAllByText(/^Bloco /).map((node) => node.textContent);
      expect(renderizado).toEqual(['Bloco anterior', 'Bloco recente']);
    });

    it('não oferece "carregar anteriores" quando o canal cabe em uma página', async () => {
      renderScreen();
      await screen.findByText('Bom dia, equipe!');

      expect(
        screen.queryByRole('button', { name: 'Carregar mensagens anteriores' }),
      ).not.toBeInTheDocument();
    });
  });
});
