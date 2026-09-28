import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Conversation,
  GetConversationResponse,
  ListConversationsResponse,
  Message,
  UserRole,
} from '@crm-lab/shared';
import type * as ApiModule from '@/api';

const listMock = vi.fn();
const playSoundMock = vi.fn();

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      conversations: { ...actual.api.conversations, list: listMock },
    },
  };
});

vi.mock('@/lib/notification-sound', () => ({ playNewMessageSound: playSoundMock }));

const { queryKeys } = await import('@/api');
const { useAuthStore } = await import('@/stores');
const { useMessageAlertsStore, reloadMessageAlertPrefs, ALERT_SOUND_KEY, ALERT_NOTIFICATIONS_KEY } =
  await import('@/stores/message-alerts.store');
const {
  ALERTS_QUERY,
  useNewMessageAlerts,
  detectNewMessages,
  baselineOf,
  alertBody,
  titleWithCount,
  isInMyQueue,
} = await import('./useNewMessageAlerts');

/**
 * CRMLAB-72 (D-240/D-241) — o que este spec protege:
 *  - quem é avisado: fila da pessoa (dela + sem dona); outra atendente e
 *    mensagem da equipe não avisam;
 *  - aba em foco × sem foco; conversa aberta × outra conversa;
 *  - permissão negada não quebra (título e som seguem);
 *  - o `body` da notificação NUNCA carrega o conteúdo da mensagem;
 *  - título "(N) CRM Lab".
 */

const SECRET = 'Resultado do exame de HIV: reagente';

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c-1',
    patientId: 'p-1',
    patientName: 'Marina Alves',
    patientPhone: '+5548999990001',
    assignedTo: 'u-1',
    assignedToName: 'Ana',
    channel: 'whatsapp',
    status: 'active',
    unreadCount: 0,
    lastMessagePreview: SECRET,
    lastMessageAt: '2026-09-28T10:00:00Z',
    tags: [],
    pinned: false,
    createdAt: '2026-09-20T10:00:00Z',
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

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm-1',
    conversationId: 'c-1',
    senderType: 'patient',
    senderId: null,
    senderName: null,
    content: SECRET,
    messageType: 'text',
    attachmentUrl: null,
    status: 'delivered',
    readAt: null,
    createdAt: '2026-09-28T10:00:00Z',
    ...overrides,
  };
}

function detail(
  messages: Message[],
  overrides: Partial<Conversation> = {},
): GetConversationResponse {
  return {
    conversation: { ...conversation(overrides), patientEmail: null, customFields: {} },
    messages,
    pagination: { page: 1, limit: 50, total: messages.length, totalPages: 1 },
    cursors: { before: null, after: null },
  };
}

/** Formato real do cache desde o CRMLAB-71 (D-238): páginas do `useInfiniteQuery`. */
function infinite(...pages: GetConversationResponse[]) {
  return { pages, pageParams: pages.map((_, i) => (i === 0 ? null : `cursor-${i}`)) };
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

let focused = true;

function setFocus(value: boolean): void {
  focused = value;
}

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

/** Carga inicial (linha de base) e, depois, a lista nova que chega pelo WS. */
async function loadThen(first: Conversation[], next: Conversation[]): Promise<void> {
  listMock.mockResolvedValueOnce(listResponse(first));
  renderHarness();
  // Espera a linha de base ENTRAR no cache: invalidar com o fetch inicial em
  // voo cancelaria o primeiro e a "lista nova" viraria a linha de base.
  await waitFor(() =>
    expect(queryClient.getQueryData(queryKeys.conversations(ALERTS_QUERY))).toBeDefined(),
  );
  listMock.mockResolvedValue(listResponse(next));
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ['conversations'] });
  });
}

function login(role: UserRole = 'attendant'): void {
  useAuthStore.setState({
    user: { id: 'u-1', email: 'a@lab.com', name: 'Ana', role, discountLimit: 15 },
    tenant: null,
    theme: null,
    tokens: { accessToken: 'a', expiresAt: Date.now() + 60_000 },
  });
}

beforeEach(() => {
  listMock.mockReset();
  playSoundMock.mockReset();
  FakeNotification.permission = 'granted';
  FakeNotification.instances = [];
  vi.stubGlobal('Notification', FakeNotification);
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  setFocus(false);
  localStorage.clear();
  reloadMessageAlertPrefs();
  useMessageAlertsStore.setState({ openConversationId: null });
  document.title = 'CRM Lab';
  login();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('regra pura (D-241)', () => {
  it('fila = atribuída a mim ou sem dona', () => {
    expect(isInMyQueue({ assignedTo: 'u-1' }, 'u-1')).toBe(true);
    expect(isInMyQueue({ assignedTo: null }, 'u-1')).toBe(true);
    expect(isInMyQueue({ assignedTo: 'u-2' }, 'u-1')).toBe(false);
  });

  it('conversa transferida para mim com mensagens antigas não avisa; conversa nova avisa', () => {
    const previous = baselineOf([
      conversation({ id: 'c-1', lastMessageAt: '2026-09-28T10:00:00Z' }),
    ]);
    const alerts = detectNewMessages(
      previous,
      [
        conversation({ id: 'c-1', lastMessageAt: '2026-09-28T10:00:00Z' }),
        conversation({ id: 'c-old', unreadCount: 2, lastMessageAt: '2026-09-27T08:00:00Z' }),
        conversation({ id: 'c-new', unreadCount: 1, lastMessageAt: '2026-09-28T10:05:00Z' }),
      ],
      'u-1',
      null,
    );
    expect(alerts.map((a) => a.conversationId)).toEqual(['c-new']);
  });

  it('body é só a contagem', () => {
    expect(alertBody(1)).toBe('Nova mensagem');
    expect(alertBody(3)).toBe('3 novas mensagens');
  });

  it('título: prefixo (N) e volta ao original quando zera', () => {
    expect(titleWithCount('CRM Lab', 3)).toBe('(3) CRM Lab');
    expect(titleWithCount('(3) CRM Lab', 1)).toBe('(1) CRM Lab');
    expect(titleWithCount('(3) CRM Lab', 0)).toBe('CRM Lab');
  });
});

describe('useNewMessageAlerts — quem é avisado', () => {
  it('aba sem foco + mensagem de paciente na minha conversa: notificação com o nome e "Nova mensagem", e som', async () => {
    await loadThen(
      [conversation()],
      [conversation({ unreadCount: 1, lastMessageAt: '2026-09-28T10:01:00Z' })],
    );

    await waitFor(() => expect(FakeNotification.instances).toHaveLength(1));
    const [notification] = FakeNotification.instances;
    expect(notification?.title).toBe('Marina Alves');
    expect(notification?.options?.body).toBe('Nova mensagem');
    expect(notification?.options?.tag).toBe('c-1');
    expect(playSoundMock).toHaveBeenCalledTimes(1);
  });

  it('conversa sem dona também avisa', async () => {
    await loadThen(
      [],
      [conversation({ assignedTo: null, unreadCount: 1, lastMessageAt: '2026-09-28T10:01:00Z' })],
    );
    await waitFor(() => expect(FakeNotification.instances).toHaveLength(1));
  });

  it('conversa de outra atendente: nada (nem para gestor)', async () => {
    login('manager');
    await loadThen(
      [conversation({ assignedTo: 'u-2' })],
      [conversation({ assignedTo: 'u-2', unreadCount: 1, lastMessageAt: '2026-09-28T10:01:00Z' })],
    );
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    expect(FakeNotification.instances).toHaveLength(0);
    expect(playSoundMock).not.toHaveBeenCalled();
    expect(document.title).toBe('CRM Lab');
  });

  it('mensagem da equipe (não sobe unreadCount): nada', async () => {
    await loadThen(
      [conversation({ unreadCount: 0 })],
      [conversation({ unreadCount: 0, lastMessageAt: '2026-09-28T10:01:00Z' })],
    );
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    expect(FakeNotification.instances).toHaveLength(0);
    expect(playSoundMock).not.toHaveBeenCalled();
  });

  it('primeira carga é linha de base: não avisa das não lidas que já existiam', async () => {
    listMock.mockResolvedValue(listResponse([conversation({ unreadCount: 4 })]));
    renderHarness();
    await waitFor(() => expect(document.title).toBe('(1) CRM Lab'));
    expect(FakeNotification.instances).toHaveLength(0);
    expect(playSoundMock).not.toHaveBeenCalled();
  });
});

describe('useNewMessageAlerts — foco e conversa aberta', () => {
  it('aba em foco + outra conversa: só som, sem notificação', async () => {
    setFocus(true);
    useMessageAlertsStore.setState({ openConversationId: 'c-9' });
    await loadThen(
      [conversation()],
      [conversation({ unreadCount: 1, lastMessageAt: '2026-09-28T10:01:00Z' })],
    );
    await waitFor(() => expect(playSoundMock).toHaveBeenCalledTimes(1));
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('conversa aberta com a aba em foco: sem notificação e sem som', async () => {
    setFocus(true);
    useMessageAlertsStore.setState({ openConversationId: 'c-1' });
    listMock.mockResolvedValue(listResponse([conversation()]));
    renderHarness();
    const key = [...queryKeys.conversation('c-1'), 'messages'];
    act(() => {
      queryClient.setQueryData(key, infinite(detail([message()])));
    });
    act(() => {
      queryClient.setQueryData(
        key,
        infinite(detail([message(), message({ id: 'm-2', createdAt: '2026-09-28T10:01:00Z' })])),
      );
    });
    expect(FakeNotification.instances).toHaveLength(0);
    expect(playSoundMock).not.toHaveBeenCalled();
  });

  it('conversa aberta com a aba SEM foco: notifica pelo detalhe, sem o conteúdo', async () => {
    useMessageAlertsStore.setState({ openConversationId: 'c-1' });
    listMock.mockResolvedValue(listResponse([conversation()]));
    renderHarness();
    const key = [...queryKeys.conversation('c-1'), 'messages'];
    act(() => {
      queryClient.setQueryData(key, infinite(detail([message()])));
    });
    act(() => {
      queryClient.setQueryData(
        key,
        // Duas páginas: a nova mais recente e a antiga já carregada pela rolagem.
        infinite(
          detail([
            message({ id: 'm-2', senderType: 'agent', createdAt: '2026-09-28T10:01:00Z' }),
            message({ id: 'm-3', createdAt: '2026-09-28T10:02:00Z' }),
            message({ id: 'm-4', createdAt: '2026-09-28T10:03:00Z' }),
          ]),
          detail([message()]),
        ),
      );
    });
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]?.options?.body).toBe('2 novas mensagens');
    expect(JSON.stringify(FakeNotification.instances[0])).not.toContain(SECRET);
    expect(playSoundMock).toHaveBeenCalledTimes(1);
  });
});

describe('useNewMessageAlerts — conteúdo nunca vai para a notificação (D-240)', () => {
  it('o body não contém o texto da mensagem nem a prévia, e não há imagem/ícone', async () => {
    await loadThen(
      [conversation()],
      [conversation({ unreadCount: 3, lastMessageAt: '2026-09-28T10:01:00Z' })],
    );
    await waitFor(() => expect(FakeNotification.instances).toHaveLength(1));
    const [notification] = FakeNotification.instances;
    expect(notification?.options?.body).toBe('3 novas mensagens');
    expect(notification?.options?.body).not.toContain(SECRET);
    expect(notification?.title).not.toContain(SECRET);
    expect(notification?.options).not.toHaveProperty('image');
    expect(notification?.options).not.toHaveProperty('icon');
  });
});

describe('useNewMessageAlerts — permissão, clique e preferências', () => {
  it('permissão negada: não notifica, mas o título e o som funcionam', async () => {
    FakeNotification.permission = 'denied';
    await loadThen(
      [conversation()],
      [conversation({ unreadCount: 1, lastMessageAt: '2026-09-28T10:01:00Z' })],
    );
    await waitFor(() => expect(playSoundMock).toHaveBeenCalledTimes(1));
    expect(FakeNotification.instances).toHaveLength(0);
    expect(document.title).toBe('(1) CRM Lab');
  });

  it('navegador sem a API Notification: nada quebra', async () => {
    vi.stubGlobal('Notification', undefined);
    await loadThen(
      [conversation()],
      [conversation({ unreadCount: 1, lastMessageAt: '2026-09-28T10:01:00Z' })],
    );
    await waitFor(() => expect(playSoundMock).toHaveBeenCalledTimes(1));
    expect(document.title).toBe('(1) CRM Lab');
  });

  it('clicar na notificação traz a aba e abre a conversa certa', async () => {
    const focusSpy = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    await loadThen(
      [conversation({ id: 'c-7' })],
      [conversation({ id: 'c-7', unreadCount: 1, lastMessageAt: '2026-09-28T10:01:00Z' })],
    );
    await waitFor(() => expect(FakeNotification.instances).toHaveLength(1));
    const [notification] = FakeNotification.instances;
    act(() => notification?.onclick?.());
    expect(focusSpy).toHaveBeenCalled();
    expect(notification?.close).toHaveBeenCalled();
    expect(screen.getByTestId('location')).toHaveTextContent('/attendance?conversationId=c-7');
  });

  it('som e notificação desligados na preferência: nada toca; persiste ao recarregar', async () => {
    act(() => {
      useMessageAlertsStore.getState().setSoundEnabled(false);
      useMessageAlertsStore.getState().setNotificationsEnabled(false);
    });
    expect(localStorage.getItem(ALERT_SOUND_KEY)).toBe('false');
    expect(localStorage.getItem(ALERT_NOTIFICATIONS_KEY)).toBe('false');
    useMessageAlertsStore.setState({ soundEnabled: true, notificationsEnabled: true });
    reloadMessageAlertPrefs();
    expect(useMessageAlertsStore.getState().soundEnabled).toBe(false);

    await loadThen(
      [conversation()],
      [conversation({ unreadCount: 1, lastMessageAt: '2026-09-28T10:01:00Z' })],
    );
    await waitFor(() => expect(document.title).toBe('(1) CRM Lab'));
    expect(FakeNotification.instances).toHaveLength(0);
    expect(playSoundMock).not.toHaveBeenCalled();
  });
});

describe('useNewMessageAlerts — título "(N) CRM Lab"', () => {
  it('conta conversas da fila com não lidas e acompanha a leitura', async () => {
    await loadThen(
      [
        conversation({ id: 'c-1', unreadCount: 2 }),
        conversation({ id: 'c-2', assignedTo: null, unreadCount: 1 }),
        conversation({ id: 'c-3', assignedTo: 'u-2', unreadCount: 5 }),
      ],
      [
        conversation({ id: 'c-1', unreadCount: 0 }),
        conversation({ id: 'c-2', assignedTo: null, unreadCount: 1 }),
        conversation({ id: 'c-3', assignedTo: 'u-2', unreadCount: 5 }),
      ],
    );
    await waitFor(() => expect(document.title).toBe('(1) CRM Lab'));

    listMock.mockResolvedValue(listResponse([conversation({ id: 'c-2', assignedTo: null })]));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
    });
    await waitFor(() => expect(document.title).toBe('CRM Lab'));
  });
});
