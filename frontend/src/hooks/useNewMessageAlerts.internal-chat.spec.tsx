import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPROVAL_REQUEST_POST_PREFIX } from '@crm-lab/shared';
import type {
  Channel,
  Conversation,
  InternalMessage,
  ListChannelsResponse,
  ListConversationsResponse,
  ListInternalMessagesResponse,
  UserRole,
} from '@crm-lab/shared';
import type * as ApiModule from '@/api';

const listMock = vi.fn();
const channelsMock = vi.fn();
const messagesMock = vi.fn();
const playSoundMock = vi.fn();

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      conversations: { ...actual.api.conversations, list: listMock },
      internalChat: {
        ...actual.api.internalChat,
        channels: channelsMock,
        messages: messagesMock,
      },
    },
  };
});

vi.mock('@/lib/notification-sound', () => ({ playNewMessageSound: playSoundMock }));

const { queryKeys } = await import('@/api');
const { useAuthStore } = await import('@/stores');
const { useMessageAlertsStore, reloadMessageAlertPrefs } =
  await import('@/stores/message-alerts.store');
const {
  useNewMessageAlerts,
  baselineOf,
  detectNewChannelMessages,
  decidesApprovals,
  freshFromColleagues,
  channelTitle,
  countUnreadChannels,
} = await import('./useNewMessageAlerts');

/**
 * CRMLAB-116 (D-284) — mensagem do Chat interno dá o mesmo aviso do atendimento:
 *  - som em outra tela / aba sem foco; notificação só com a aba sem foco, com o
 *    nome do canal ou da colega e SEM o texto; clique abre o canal certo;
 *  - canal aberto e em foco, mensagem minha, de sistema, edição/apagamento: nada;
 *  - mesmas preferências de som/notificação;
 *  - título da aba com a contagem ÚNICA (conversas + canais).
 */

const ME = 'u-1';
const CARLA = 'u-9';
const SECRET = 'Senha do cofre: 4321';
const T0 = '2026-10-25T10:00:00Z';
const T1 = '2026-10-25T10:01:00Z';

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'ch-geral',
    key: 'geral',
    name: '#geral',
    kind: 'channel',
    unreadCount: 0,
    lastReadAt: T0,
    lastMessageAt: T0,
    otherUserId: null,
    otherUserName: null,
    ...overrides,
  };
}

const DM_CARLA = channel({
  id: 'ch-dm',
  key: `dm:${CARLA}:${ME}`,
  name: `dm:${CARLA}:${ME}`,
  kind: 'dm',
  otherUserId: CARLA,
  otherUserName: 'Carla Souza',
});

function internalMessage(overrides: Partial<InternalMessage> = {}): InternalMessage {
  return {
    id: 'im-1',
    channelId: DM_CARLA.id,
    senderId: CARLA,
    senderName: 'Carla Souza',
    content: SECRET,
    attachedProposalId: null,
    isSystem: false,
    createdAt: T1,
    ...overrides,
  };
}

const APROVACOES = channel({ id: 'ch-aprov', key: 'aprovacoes', name: '#aprovacoes' });
const REQUEST_POST = `${APPROVAL_REQUEST_POST_PREFIX} Juliana Prado - R$ 138,00 (25% — acima da alçada de 15%)`;
const DECISION_POST = 'Desconto de 25% APROVADO na proposta #ABC123.';

function approvalPost(content: string): InternalMessage {
  return internalMessage({
    channelId: APROVACOES.id,
    senderId: null,
    senderName: 'Sistema',
    isSystem: true,
    attachedProposalId: 'p-1',
    content,
  });
}

function messagesResponse(messages: InternalMessage[]): ListInternalMessagesResponse {
  return { messages, pagination: { page: 1, limit: 50, total: messages.length, totalPages: 1 } };
}

function channelsResponse(channels: Channel[]): ListChannelsResponse {
  return { channels };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c-1',
    patientId: 'p-1',
    patientName: 'Marina Alves',
    patientPhone: '+5548999990001',
    assignedTo: ME,
    assignedToName: 'Ana',
    channel: 'whatsapp',
    status: 'active',
    unreadCount: 0,
    lastMessagePreview: null,
    lastMessageAt: T0,
    tags: [],
    pinned: false,
    createdAt: T0,
    ...overrides,
  };
}

function listResponse(conversations: Conversation[]): ListConversationsResponse {
  return {
    conversations,
    pagination: { page: 1, limit: 100, total: conversations.length, totalPages: 1 },
    counts: { mine: 0, unassigned: 0 },
  };
}

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static instances: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {
    FakeNotification.instances.push(this);
  }
}

let focused = false;

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

function Harness() {
  useNewMessageAlerts();
  return <LocationProbe />;
}

let queryClient: QueryClient;

function renderHarness() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/proposals']}>
        <Harness />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Linha de base dos canais e, depois, a lista que chega pelo WS `internal_chat.*`. */
async function loadChannelsThen(first: Channel[], next: Channel[]): Promise<void> {
  channelsMock.mockResolvedValueOnce(channelsResponse(first));
  renderHarness();
  await waitFor(() => expect(queryClient.getQueryData(queryKeys.internalChannels())).toBeDefined());
  channelsMock.mockResolvedValue(channelsResponse(next));
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.internalChannels() });
  });
}

function login(role: UserRole = 'attendant'): void {
  useAuthStore.setState({
    user: { id: ME, email: 'a@lab.com', name: 'Ana', role, discountLimit: 15 },
    tenant: null,
    theme: null,
    tokens: { accessToken: 'a', expiresAt: Date.now() + 60_000 },
  });
}

/** Deixa as promessas da confirmação (página 1) assentarem. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  listMock.mockReset();
  channelsMock.mockReset();
  messagesMock.mockReset();
  playSoundMock.mockReset();
  listMock.mockResolvedValue(listResponse([]));
  messagesMock.mockResolvedValue(messagesResponse([internalMessage()]));
  FakeNotification.permission = 'granted';
  FakeNotification.instances = [];
  vi.stubGlobal('Notification', FakeNotification);
  focused = false;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  localStorage.clear();
  reloadMessageAlertPrefs();
  useMessageAlertsStore.setState({ openConversationId: null, openInternalChannelId: null });
  document.title = 'CRM Lab';
  login();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('regra pura (D-284)', () => {
  it('candidato = contador subiu E última mensagem mudou; primeira carga não avisa', () => {
    const previous = baselineOf([channel(), DM_CARLA]);
    const candidates = detectNewChannelMessages(previous, [
      channel({ unreadCount: 0, lastMessageAt: T1 }), // minha (contador não subiu)
      { ...DM_CARLA, unreadCount: 1, lastMessageAt: T1 },
    ]);
    expect(candidates.map((c) => c.id)).toEqual([DM_CARLA.id]);
  });

  it('confirmação: só mensagem de colega, nova, não apagada e não de sistema', () => {
    const fresh = freshFromColleagues(
      [
        internalMessage({ id: 'velha', createdAt: T0 }),
        internalMessage({ id: 'minha', senderId: ME }),
        internalMessage({ id: 'sistema', senderId: null, isSystem: true }),
        internalMessage({ id: 'apagada', deletedAt: T1, content: '' }),
        internalMessage({ id: 'nova' }),
      ],
      ME,
      T0,
    );
    expect(fresh.map((m) => m.id)).toEqual(['nova']);
  });

  it('com withApprovalRequests: entra só o pedido de aprovação, não a decisão', () => {
    const posts = [
      { ...approvalPost(REQUEST_POST), id: 'pedido' },
      { ...approvalPost(DECISION_POST), id: 'decisao' },
      { ...approvalPost(REQUEST_POST), id: 'sem-proposta', attachedProposalId: null },
    ];
    expect(freshFromColleagues(posts, ME, T0).map((m) => m.id)).toEqual([]);
    expect(freshFromColleagues(posts, ME, T0, true).map((m) => m.id)).toEqual(['pedido']);
    expect(decidesApprovals('manager')).toBe(true);
    expect(decidesApprovals('admin')).toBe(true);
    expect(decidesApprovals('attendant')).toBe(false);
  });

  it('título: nome do canal ou, na DM, o da colega', () => {
    expect(channelTitle(channel())).toBe('#geral');
    expect(channelTitle(DM_CARLA)).toBe('Carla Souza');
  });

  it('conta canais com não lidas', () => {
    expect(countUnreadChannels([channel({ unreadCount: 3 }), DM_CARLA])).toBe(1);
  });
});

describe('useNewMessageAlerts — chat interno', () => {
  it('em outra tela com a aba em foco, colega manda DM: som, sem notificação', async () => {
    focused = true;
    await loadChannelsThen([DM_CARLA], [{ ...DM_CARLA, unreadCount: 1, lastMessageAt: T1 }]);
    await waitFor(() => expect(playSoundMock).toHaveBeenCalledTimes(1));
    expect(FakeNotification.instances).toHaveLength(0);
    expect(messagesMock).toHaveBeenCalledWith(DM_CARLA.id, { page: 1, limit: 50 });
  });

  it('aba em segundo plano: notificação com o nome, sem o texto; clique abre o canal', async () => {
    const focusSpy = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    await loadChannelsThen([DM_CARLA], [{ ...DM_CARLA, unreadCount: 1, lastMessageAt: T1 }]);

    await waitFor(() => expect(FakeNotification.instances).toHaveLength(1));
    const [notification] = FakeNotification.instances;
    expect(notification?.title).toBe('Carla Souza');
    expect(notification?.options?.body).toBe('Nova mensagem');
    expect(notification?.options?.tag).toBe(`internal-chat:${DM_CARLA.id}`);
    expect(JSON.stringify(notification)).not.toContain(SECRET);
    expect(playSoundMock).toHaveBeenCalledTimes(1);

    act(() => notification?.onclick?.());
    expect(focusSpy).toHaveBeenCalled();
    expect(notification?.close).toHaveBeenCalled();
    expect(screen.getByTestId('location')).toHaveTextContent(
      `/internal-chat?channelId=${DM_CARLA.id}`,
    );
  });

  it('canal: título da notificação é o nome do canal e conta as não lidas de colegas', async () => {
    const geral = channel({ lastReadAt: '2026-10-25T09:00:00Z' });
    messagesMock.mockResolvedValue(
      messagesResponse([
        internalMessage({ id: 'a', channelId: geral.id, createdAt: '2026-10-25T09:30:00Z' }),
        internalMessage({ id: 'b', channelId: geral.id }),
      ]),
    );
    await loadChannelsThen(
      [{ ...geral, unreadCount: 1 }],
      [{ ...geral, unreadCount: 2, lastMessageAt: T1 }],
    );
    await waitFor(() => expect(FakeNotification.instances).toHaveLength(1));
    expect(FakeNotification.instances[0]?.title).toBe('#geral');
    expect(FakeNotification.instances[0]?.options?.body).toBe('2 novas mensagens');
  });

  it('canal aberto e aba em foco: nada', async () => {
    focused = true;
    useMessageAlertsStore.setState({ openInternalChannelId: DM_CARLA.id });
    await loadChannelsThen([DM_CARLA], [{ ...DM_CARLA, unreadCount: 1, lastMessageAt: T1 }]);
    await settle();
    expect(playSoundMock).not.toHaveBeenCalled();
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('canal aberto com a aba SEM foco: avisa', async () => {
    useMessageAlertsStore.setState({ openInternalChannelId: DM_CARLA.id });
    await loadChannelsThen([DM_CARLA], [{ ...DM_CARLA, unreadCount: 1, lastMessageAt: T1 }]);
    await waitFor(() => expect(FakeNotification.instances).toHaveLength(1));
    expect(playSoundMock).toHaveBeenCalledTimes(1);
  });

  it('mensagem minha (inclusive de outra aba): o contador não sobe → nada', async () => {
    messagesMock.mockResolvedValue(messagesResponse([internalMessage({ senderId: ME })]));
    await loadChannelsThen([DM_CARLA], [{ ...DM_CARLA, lastMessageAt: T1 }]);
    await settle();
    expect(playSoundMock).not.toHaveBeenCalled();
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('mensagem de sistema (o contador sobe, D-068): nada', async () => {
    messagesMock.mockResolvedValue(
      messagesResponse([
        internalMessage({ channelId: APROVACOES.id, senderId: null, isSystem: true }),
      ]),
    );
    await loadChannelsThen([APROVACOES], [{ ...APROVACOES, unreadCount: 1, lastMessageAt: T1 }]);
    await waitFor(() => expect(messagesMock).toHaveBeenCalled());
    await settle();
    expect(playSoundMock).not.toHaveBeenCalled();
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('pedido de aprovação em #aprovacoes: gestor recebe som e notificação (D-284 item 8)', async () => {
    login('manager');
    messagesMock.mockResolvedValue(messagesResponse([approvalPost(REQUEST_POST)]));
    await loadChannelsThen([APROVACOES], [{ ...APROVACOES, unreadCount: 1, lastMessageAt: T1 }]);
    await waitFor(() => expect(FakeNotification.instances).toHaveLength(1));
    expect(playSoundMock).toHaveBeenCalledTimes(1);
    expect(FakeNotification.instances[0]?.title).toBe('#aprovacoes');
    expect(FakeNotification.instances[0]?.options?.body).toBe('Nova mensagem');
  });

  it('decisão (APROVADO/REJEITADO) em #aprovacoes: nem o gestor é avisado', async () => {
    login('admin');
    messagesMock.mockResolvedValue(messagesResponse([approvalPost(DECISION_POST)]));
    await loadChannelsThen([APROVACOES], [{ ...APROVACOES, unreadCount: 1, lastMessageAt: T1 }]);
    await waitFor(() => expect(messagesMock).toHaveBeenCalled());
    await settle();
    expect(playSoundMock).not.toHaveBeenCalled();
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('pedido de aprovação: atendente (não decide) não é avisada', async () => {
    messagesMock.mockResolvedValue(messagesResponse([approvalPost(REQUEST_POST)]));
    await loadChannelsThen([APROVACOES], [{ ...APROVACOES, unreadCount: 1, lastMessageAt: T1 }]);
    await waitFor(() => expect(messagesMock).toHaveBeenCalled());
    await settle();
    expect(playSoundMock).not.toHaveBeenCalled();
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('edição/apagamento (message_updated): contador não sobe → nada', async () => {
    const lido = { ...DM_CARLA, unreadCount: 1 };
    // Apagar tira do `unreadCount` (D-282); editar não muda nada da lista.
    await loadChannelsThen([lido], [{ ...lido, unreadCount: 0 }]);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.internalChannels() });
    });
    await settle();
    expect(messagesMock).not.toHaveBeenCalled();
    expect(playSoundMock).not.toHaveBeenCalled();
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('som e notificação desligados na preferência: nada também no chat', async () => {
    act(() => {
      useMessageAlertsStore.getState().setSoundEnabled(false);
      useMessageAlertsStore.getState().setNotificationsEnabled(false);
    });
    await loadChannelsThen([DM_CARLA], [{ ...DM_CARLA, unreadCount: 1, lastMessageAt: T1 }]);
    await waitFor(() => expect(messagesMock).toHaveBeenCalled());
    await settle();
    expect(playSoundMock).not.toHaveBeenCalled();
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('platform_operator: não lê canais nem avisa', async () => {
    login('platform_operator');
    renderHarness();
    await settle();
    expect(channelsMock).not.toHaveBeenCalled();
  });
});

describe('título da aba — contagem única (D-284)', () => {
  it('2 conversas + 1 canal não lidos → "(3)"; ler o canal → "(2)"', async () => {
    listMock.mockResolvedValue(
      listResponse([
        conversation({ id: 'c-1', unreadCount: 1 }),
        conversation({ id: 'c-2', unreadCount: 4 }),
      ]),
    );
    channelsMock.mockResolvedValue(channelsResponse([{ ...DM_CARLA, unreadCount: 2 }, channel()]));
    renderHarness();
    await waitFor(() => expect(document.title).toBe('(3) CRM Lab'));

    channelsMock.mockResolvedValue(channelsResponse([DM_CARLA, channel()]));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.internalChannels() });
    });
    await waitFor(() => expect(document.title).toBe('(2) CRM Lab'));
  });
});
