import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Conversation,
  GetConversationResponse,
  ListConversationsResponse,
  ListPatientsResponse,
  ListProposalsResponse,
  Message,
} from '@crm-lab/shared';
import type * as ApiModule from '@/api';

const listMock = vi.fn();
const getMock = vi.fn();
const editMessageMock = vi.fn();
const deleteMessageMock = vi.fn();
const listProposalsMock = vi.fn();
const listPatientsMock = vi.fn();
const sendPresenceMock = vi.fn();

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
        editMessage: editMessageMock,
        deleteMessage: deleteMessageMock,
        sendPresence: sendPresenceMock,
      },
      proposals: { ...actual.api.proposals, list: listProposalsMock },
      patients: { ...actual.api.patients, list: listPatientsMock },
    },
  };
});

const { ApiError } = await import('@/api');
const { ToastProvider } = await import('@/components/ui');
const { useAuthStore, useUIStore } = await import('@/stores');
const { Attendance } = await import('./index');

/**
 * Atendimento — editar e apagar para todos pela autora (CRMLAB-105, D-280):
 * os itens obedecem ao `canEditMessages` do canal e chamam a API; gateway
 * recusou = toast "Nada foi alterado".
 */

const CONVERSATION: Conversation = {
  id: 'c-1',
  patientId: 'p-1',
  patientName: 'Marina Alves',
  patientPhone: '(11) 98765-4321',
  assignedTo: 'u-1',
  assignedToName: 'Ana',
  channel: 'whatsapp',
  status: 'active',
  unreadCount: 0,
  lastMessagePreview: 'Prévia da lista',
  lastMessageAt: new Date().toISOString(),
  pinned: false,
  tags: [],
  createdAt: '2026-08-20T10:00:00Z',
};

const MINE: Message = {
  id: 'm-1',
  conversationId: 'c-1',
  senderType: 'agent',
  senderId: 'u-1',
  senderName: 'Ana',
  content: 'O exame custa R$ 98,90',
  messageType: 'text',
  attachmentUrl: null,
  status: 'delivered',
  readAt: null,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  editedAt: null,
  deletedAt: null,
};

function detail(canEditMessages: boolean): GetConversationResponse {
  return {
    conversation: { ...CONVERSATION, patientEmail: null, customFields: {} },
    messages: [MINE],
    pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
    cursors: { before: null, after: null },
    canEditMessages,
  };
}

const LIST: ListConversationsResponse = {
  conversations: [CONVERSATION],
  counts: { mine: 1, unassigned: 0 },
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
};
const NO_PROPOSALS: ListProposalsResponse = {
  proposals: [],
  pagination: { page: 1, limit: 20, total: 0, totalPages: 1 },
};
const NO_PATIENTS: ListPatientsResponse = {
  patients: [],
  pagination: { page: 1, limit: 5, total: 0, totalPages: 1 },
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

async function openMenu(): Promise<HTMLElement> {
  await userEvent.click(await screen.findByTestId('conversation-item'));
  const bubble = await screen.findByText('O exame custa R$ 98,90');
  const shell = bubble.closest('[data-testid="message-bubble"]') as HTMLElement;
  await userEvent.click(within(shell).getByRole('button', { name: 'Ações da mensagem' }));
  return screen.getByRole('menu');
}

beforeEach(() => {
  vi.restoreAllMocks();
  for (const mock of [listMock, getMock, editMessageMock, deleteMessageMock]) mock.mockReset();
  listMock.mockResolvedValue(LIST);
  sendPresenceMock.mockResolvedValue(undefined);
  listProposalsMock.mockResolvedValue(NO_PROPOSALS);
  listPatientsMock.mockResolvedValue(NO_PATIENTS);
  localStorage.clear();
  useUIStore.setState({ sidebarCollapsed: true, contextPanelOpen: false, activeModal: null });
  useAuthStore.setState({
    user: { id: 'u-1', email: 'ana@lab.com', name: 'Ana', role: 'attendant', discountLimit: 15 },
    tenant: null,
    theme: null,
    tokens: { accessToken: 'a', expiresAt: Date.now() + 60_000 },
  });
});

describe('Atendimento — editar/apagar para todos (D-280)', () => {
  it('canal sem suporte (Cloud API): Editar e Apagar não aparecem', async () => {
    getMock.mockResolvedValue(detail(false));
    renderScreen();
    const menu = await openMenu();
    expect(within(menu).queryByRole('menuitem', { name: 'Editar' })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: 'Apagar para todos' })).toBeNull();
  });

  it('Editar chama PATCH com o texto novo', async () => {
    getMock.mockResolvedValue(detail(true));
    editMessageMock.mockResolvedValue({ ...MINE, content: 'O exame custa R$ 89,90' });
    renderScreen();
    const menu = await openMenu();
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Editar' }));
    const box = screen.getByLabelText('Editar mensagem');
    await userEvent.clear(box);
    await userEvent.type(box, 'O exame custa R$ 89,90{Enter}');

    await waitFor(() =>
      expect(editMessageMock).toHaveBeenCalledWith('c-1', 'm-1', { content: 'O exame custa R$ 89,90' }),
    );
  });

  it('Apagar para todos confirma e chama DELETE; gateway recusou -> toast', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    getMock.mockResolvedValue(detail(true));
    deleteMessageMock.mockRejectedValue(
      new ApiError('MESSAGE_SEND_FAILED', 'Falha ao enviar a mensagem pelo canal', 502, { messageId: 'm-1' }),
    );
    renderScreen();
    const menu = await openMenu();
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Apagar para todos' }));

    await waitFor(() => expect(deleteMessageMock).toHaveBeenCalledWith('c-1', 'm-1'));
    expect(
      await screen.findByText('Não foi possível apagar a mensagem no WhatsApp. Nada foi alterado.'),
    ).toBeInTheDocument();
  });
});
