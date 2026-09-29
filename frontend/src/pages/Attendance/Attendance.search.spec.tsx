import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Conversation,
  GetConversationResponse,
  ListConversationsResponse,
  MessageSearchHit,
  SearchMessagesResponse,
} from '@crm-lab/shared';
import type * as ApiModule from '@/api';

const listMock = vi.fn();
const getMock = vi.fn();
const searchMessagesMock = vi.fn();
const markUnreadMock = vi.fn();

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      conversations: {
        ...actual.api.conversations,
        list: listMock,
        get: getMock,
        searchMessages: searchMessagesMock,
        markUnread: markUnreadMock,
        assignees: vi.fn().mockResolvedValue({ assignees: [] }),
      },
      proposals: {
        ...actual.api.proposals,
        list: vi.fn().mockResolvedValue({
          proposals: [],
          pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
        }),
      },
      patients: {
        ...actual.api.patients,
        list: vi.fn().mockResolvedValue({
          patients: [],
          pagination: { page: 1, limit: 5, total: 0, totalPages: 0 },
        }),
      },
    },
  };
});

const { ToastProvider } = await import('@/components/ui');
const { useAuthStore, useUIStore } = await import('@/stores');
const { Attendance } = await import('./index');

/**
 * Atendimento — CRMLAB-68 (D-228/D-229/D-230): chip "Não lidas", bloco
 * "Mensagens" da busca abrindo a conversa NA mensagem (`around`) e "Marcar
 * como não lida".
 */

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c-1',
    patientId: 'p-1',
    patientName: 'Marina Alves',
    patientPhone: '(11) 98765-4321',
    assignedTo: 'u-1',
    assignedToName: 'Marina',
    channel: 'whatsapp',
    status: 'active',
    unreadCount: 0,
    lastMessagePreview: 'Oi',
    lastMessageAt: '2026-09-28T09:12:00Z',
    pinned: false,
    tags: [],
    createdAt: '2026-09-20T10:00:00Z',
    ...overrides,
  };
}

function listResponse(conversations: Conversation[]): ListConversationsResponse {
  return {
    conversations,
    counts: { mine: 3, unassigned: 1, unread: 2 },
    pagination: { page: 1, limit: 20, total: conversations.length, totalPages: 1 },
  };
}

function detail(id = 'c-1'): GetConversationResponse {
  return {
    conversation: { ...conversation({ id }), patientEmail: null, customFields: {} },
    messages: [
      {
        id: 'm-old',
        conversationId: id,
        senderType: 'patient',
        senderId: null,
        senderName: 'Marina Alves',
        content: 'Preciso do orçamento do hemograma',
        messageType: 'text',
        attachmentUrl: null,
        status: 'read',
        readAt: null,
        createdAt: '2026-09-01T09:00:00Z',
      },
    ],
    pagination: { page: 1, limit: 50, total: 80, totalPages: 2 },
    cursors: { before: null, after: 'm-old' },
  };
}

const HIT: MessageSearchHit = {
  messageId: 'm-old',
  conversationId: 'c-9',
  patientName: 'Pedro Lima',
  patientPhone: '+5511900000000',
  senderType: 'patient',
  senderName: 'Pedro Lima',
  messageType: 'text',
  content: 'Olá! Preciso do orçamento do hemograma completo, por favor',
  createdAt: '2026-09-01T09:00:00Z',
};

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/attendance']}>
          <Attendance />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listMock.mockReset();
  getMock.mockReset();
  searchMessagesMock.mockReset();
  markUnreadMock.mockReset();
  markUnreadMock.mockResolvedValue(undefined);
  getMock.mockImplementation((id: string) => Promise.resolve(detail(id)));
  useUIStore.setState({ sidebarCollapsed: true, contextPanelOpen: false, activeModal: null });
  useAuthStore.setState({
    user: { id: 'u-1', email: 'a@lab.com', name: 'Marina', role: 'attendant', discountLimit: 15 },
    tenant: null,
    theme: null,
    tokens: { accessToken: 'a', expiresAt: Date.now() + 60_000 },
  });
});

describe('Atendimento — "Não lidas" (D-229)', () => {
  it('o chip mostra counts.unread e, ligado, pede ?unread=true sobre as ativas', async () => {
    listMock.mockResolvedValue(listResponse([conversation()]));
    const user = userEvent.setup();
    renderScreen();

    const chip = await screen.findByRole('button', { name: 'Não lidas 2' });
    await user.click(chip);
    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'active', scope: 'all', unread: true }),
      ),
    );
  });

  it('"Marcar como não lida" pelo menu chama POST /unread e fecha a conversa aberta', async () => {
    listMock.mockResolvedValue(listResponse([conversation()]));
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByTestId('conversation-item'));
    expect(await screen.findByRole('button', { name: 'Fechar conversa' })).toBeInTheDocument();

    // Clique direito no item abre o menu.
    fireEvent.contextMenu(screen.getByTestId('conversation-item'));
    await user.click(screen.getByRole('menuitem', { name: 'Marcar como não lida' }));

    await waitFor(() => expect(markUnreadMock).toHaveBeenCalledWith('c-1'));
    expect(screen.getByText('Selecione uma conversa')).toBeInTheDocument();
  });
});

describe('Atendimento — busca nas mensagens (D-228/D-230)', () => {
  it('mostra o bloco "Mensagens" com o trecho em destaque e abre a conversa em volta da mensagem', async () => {
    listMock.mockResolvedValue(listResponse([]));
    const response: SearchMessagesResponse = {
      results: [HIT],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    };
    searchMessagesMock.mockResolvedValue(response);
    const user = userEvent.setup();
    renderScreen();

    await user.type(
      screen.getByRole('searchbox', { name: 'Buscar paciente, telefone ou exame' }),
      'orcamento',
    );

    const block = await screen.findByRole('region', { name: 'Mensagens encontradas' });
    expect(searchMessagesMock).toHaveBeenCalledWith({ q: 'orcamento', limit: 20 });
    const result = await within(block).findByTestId('message-result');
    expect(result).toHaveTextContent('Pedro Lima');
    // Sem acento na busca, destaque na palavra acentuada.
    expect(within(result).getByTestId('search-highlight')).toHaveTextContent('orçamento');
    // Sem conversa por nome, o vazio grande não aparece: há mensagem achada.
    expect(screen.queryByText('Nenhuma conversa por aqui')).not.toBeInTheDocument();

    await user.click(result);
    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith('c-9', { messageLimit: 50, around: 'm-old' }),
    );
    // Abrir pela busca não mostra a faixa de não lidas; há mais novas: ↓ visível.
    expect(
      await screen.findByRole('button', { name: /Ir para a última mensagem/ }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('unread-divider')).not.toBeInTheDocument();
  });
});
