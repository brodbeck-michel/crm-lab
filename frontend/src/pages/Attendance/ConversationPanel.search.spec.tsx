import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationDetail, Message, MessageSearchHit } from '@crm-lab/shared';
import type * as ApiModule from '@/api';

const searchInConversationMock = vi.fn();

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      conversations: {
        ...actual.api.conversations,
        searchInConversation: searchInConversationMock,
      },
    },
  };
});

const { ConversationPanel } = await import('./ConversationPanel');
type Props = Parameters<typeof ConversationPanel>[0];

/**
 * Painel da conversa — CRMLAB-68 (D-228/D-230): lupa com ↑ ↓, abrir numa
 * mensagem (foco + destaque) e a janela no meio da conversa (mais novas
 * carregadas embaixo não descem a tela; ↓ volta para a ponta).
 *
 * Mesmo layout de mentira do `ConversationReading.spec`: cada filho da área
 * rolável tem 100px e a janela visível 300px.
 */

const ROW = 100;
const VIEW = 300;

const CONVERSATION: ConversationDetail = {
  id: 'c-1',
  patientId: 'p-1',
  patientName: 'Marina Alves',
  patientPhone: '(11) 98765-4321',
  patientEmail: null,
  assignedTo: 'u-1',
  assignedToName: 'Marina',
  channel: 'whatsapp',
  status: 'active',
  unreadCount: 0,
  lastMessagePreview: null,
  lastMessageAt: '2026-09-28T09:12:00Z',
  tags: [],
  pinned: false,
  customFields: {},
  createdAt: '2026-09-20T10:00:00Z',
};

function message(id: string): Message {
  return {
    id,
    conversationId: 'c-1',
    senderType: 'patient',
    senderId: null,
    senderName: 'Marina Alves',
    content: `mensagem ${id}`,
    messageType: 'text',
    attachmentUrl: null,
    status: 'read',
    readAt: null,
    createdAt: new Date(2026, 8, 28, 9, 0).toISOString(),
  };
}

function range(from: number, to: number): Message[] {
  const list: Message[] = [];
  for (let i = from; i <= to; i += 1) list.push(message(`m-${i}`));
  return list;
}

function props(messages: Message[], extra: Partial<Props> = {}): Props {
  return {
    conversation: CONVERSATION,
    messages,
    isLoading: false,
    isError: false,
    onRetry: vi.fn(),
    onSend: vi.fn(),
    sending: false,
    quickReplies: [],
    assignees: [],
    onAssign: vi.fn(),
    onCloseAttendance: vi.fn(),
    canCloseAttendance: true,
    onToggleContext: vi.fn(),
    onClose: vi.fn(),
    onSendAttachments: vi.fn(),
    contextOpen: false,
    hasOlderMessages: false,
    loadingOlder: false,
    onLoadOlder: vi.fn(),
    unreadAtOpen: 0,
    ...extra,
  };
}

function withClient(node: ReactElement): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

function scroller(): HTMLElement {
  return screen.getByTestId('message-scroll');
}

function jumpButton(): HTMLElement | null {
  return screen.queryByRole('button', { name: /Ir para a última mensagem/ });
}

const scrollIntoView = vi.fn();

beforeEach(() => {
  scrollIntoView.mockReset();
  searchInConversationMock.mockReset();
  const position = (element: HTMLElement): number => {
    const parent = element.parentElement;
    return parent ? Array.from(parent.children).indexOf(element) * ROW : 0;
  };
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return position(this);
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => ROW);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.dataset.testid === 'message-scroll' ? VIEW : ROW;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.dataset.testid === 'message-scroll' ? this.children.length * ROW : ROW;
  });
  HTMLElement.prototype.scrollTo = vi.fn(function (
    this: HTMLElement,
    options?: ScrollToOptions | number,
  ) {
    if (typeof options === 'object' && options.top !== undefined) this.scrollTop = options.top;
  }) as HTMLElement['scrollTo'];
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('abrir numa mensagem (D-230)', () => {
  it('rola até a mensagem da busca (salto imediato) e acende o destaque, sem faixa de não lidas', () => {
    render(
      withClient(
        <ConversationPanel
          {...props(range(1, 10), { focusMessageId: 'm-4', viewKey: 'c-1:m-4' })}
        />,
      ),
    );
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
    const bubble = scroller().querySelector<HTMLElement>('[data-message-id="m-4"]');
    expect(bubble?.dataset.highlighted).toBe('true');
    expect(screen.queryByTestId('unread-divider')).not.toBeInTheDocument();
  });

  it('com mais novas por carregar: ↓ aparece mesmo no fim e volta para a ponta', async () => {
    const user = userEvent.setup();
    const onJumpToLatest = vi.fn();
    render(
      withClient(
        <ConversationPanel
          {...props(range(1, 3), { hasNewerMessages: true, onJumpToLatest, viewKey: 'c-1:m-2' })}
        />,
      ),
    );
    const button = jumpButton();
    expect(button).not.toBeNull();
    await user.click(button as HTMLElement);
    expect(onJumpToLatest).toHaveBeenCalledTimes(1);
  });

  it('perto do fim pede as mais novas; a página que chega embaixo não desce a tela nem soma no ↓', () => {
    const onLoadNewer = vi.fn();
    const base = { hasNewerMessages: true, onLoadNewer, viewKey: 'c-1:m-5', focusMessageId: 'm-5' };
    const { rerender } = render(withClient(<ConversationPanel {...props(range(1, 10), base)} />));

    // Perto do fim (conteúdo: 10 mensagens + 1 separador de data).
    scroller().scrollTop = scroller().scrollHeight - VIEW - 50;
    fireEvent.scroll(scroller());
    expect(onLoadNewer).toHaveBeenCalled();

    const before = scroller().scrollTop;
    rerender(
      withClient(
        <ConversationPanel {...props(range(1, 15), { ...base, hasNewerMessages: false })} />,
      ),
    );
    expect(scroller().scrollTop).toBe(before);
    expect(screen.queryByText(/nova/)).not.toBeInTheDocument();
  });
});

describe('busca dentro da conversa (D-228)', () => {
  const hits: MessageSearchHit[] = ['m-9', 'm-old'].map((id) => ({
    messageId: id,
    conversationId: 'c-1',
    patientName: 'Marina Alves',
    patientPhone: '(11) 98765-4321',
    senderType: 'patient',
    senderName: 'Marina Alves',
    messageType: 'text',
    content: `o resultado da glicose ${id}`,
    createdAt: '2026-09-28T09:00:00Z',
  }));

  it('lupa abre a barra; ↑ vai da mais nova para a mais antiga; fora do carregado reabre com around', async () => {
    searchInConversationMock.mockResolvedValue({
      results: hits,
      pagination: { page: 1, limit: 100, total: 2, totalPages: 1 },
    });
    const user = userEvent.setup();
    const onOpenAround = vi.fn();
    render(withClient(<ConversationPanel {...props(range(1, 10), { onOpenAround })} />));

    await user.click(screen.getByRole('button', { name: 'Buscar nesta conversa' }));
    const bar = screen.getByRole('search', { name: 'Buscar nesta conversa' });
    await user.type(within(bar).getByRole('searchbox'), 'glicose');

    await waitFor(() =>
      expect(within(bar).getAllByTestId('conversation-search-result')).toHaveLength(2),
    );
    expect(searchInConversationMock).toHaveBeenCalledWith('c-1', { q: 'glicose', limit: 100 });
    expect(within(bar).getByTestId('conversation-search-counter')).toHaveTextContent('0 de 2');

    scrollIntoView.mockReset();
    await user.click(within(bar).getByRole('button', { name: /Ocorrência anterior/ }));
    // m-9 está carregada: só rola, não reabre.
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(onOpenAround).not.toHaveBeenCalled();
    expect(within(bar).getByTestId('conversation-search-counter')).toHaveTextContent('1 de 2');

    await user.click(within(bar).getByRole('button', { name: /Ocorrência anterior/ }));
    expect(onOpenAround).toHaveBeenCalledWith('m-old');
    expect(within(bar).getByTestId('conversation-search-counter')).toHaveTextContent('2 de 2');

    await user.click(within(bar).getByRole('button', { name: /Próxima ocorrência/ }));
    expect(within(bar).getByTestId('conversation-search-counter')).toHaveTextContent('1 de 2');

    // Clicar num resultado também vai até ele; Esc fecha a barra.
    await user.click(within(bar).getAllByTestId('conversation-search-result')[1] as HTMLElement);
    expect(onOpenAround).toHaveBeenCalledTimes(2);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('search', { name: 'Buscar nesta conversa' })).not.toBeInTheDocument();
  });

  it('sem `onOpenAround` não há lupa', () => {
    render(withClient(<ConversationPanel {...props(range(1, 3))} />));
    expect(screen.queryByRole('button', { name: 'Buscar nesta conversa' })).not.toBeInTheDocument();
  });
});
