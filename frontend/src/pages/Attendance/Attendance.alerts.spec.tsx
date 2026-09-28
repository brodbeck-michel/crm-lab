import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Conversation,
  GetConversationResponse,
  ListConversationsResponse,
  ListProposalsResponse,
} from '@crm-lab/shared';
import type * as ApiModule from '@/api';

const listMock = vi.fn();
const getMock = vi.fn();
const listProposalsMock = vi.fn();

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      conversations: { ...actual.api.conversations, list: listMock, get: getMock },
      proposals: { ...actual.api.proposals, list: listProposalsMock },
    },
  };
});

const { ToastProvider } = await import('@/components/ui');
const { useAuthStore, useMessageAlertsStore } = await import('@/stores');
const { Attendance } = await import('./index');

/**
 * CRMLAB-72 — a parte do aviso que mora no Atendimento:
 *  - clicar na notificação navega para `?conversationId=` e a tela abre a
 *    conversa MESMO já montada (D-240);
 *  - a tela publica a conversa aberta para o hook (D-241 item 3);
 *  - o aviso "Ativar notificações" aparece no topo da fila (D-241 item 5).
 */

function conversation(id: string): Conversation {
  return {
    id,
    patientId: 'p-1',
    patientName: `Paciente ${id}`,
    patientPhone: '+5548999990001',
    assignedTo: 'u-1',
    assignedToName: 'Ana',
    channel: 'whatsapp',
    status: 'active',
    unreadCount: 0,
    lastMessagePreview: null,
    lastMessageAt: '2026-09-28T10:00:00Z',
    tags: [],
    pinned: false,
    createdAt: '2026-09-20T10:00:00Z',
  };
}

function detail(id: string): GetConversationResponse {
  return {
    conversation: { ...conversation(id), patientEmail: null, customFields: {} },
    messages: [],
    pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
    cursors: { before: null, after: null },
  };
}

const LIST: ListConversationsResponse = {
  conversations: [conversation('c-1'), conversation('c-2')],
  pagination: { page: 1, limit: 20, total: 2, totalPages: 1 },
  counts: { mine: 2, unassigned: 0 },
};

const NO_PROPOSALS: ListProposalsResponse = {
  proposals: [],
  pagination: { page: 1, limit: 20, total: 0, totalPages: 1 },
};

/** Faz o papel do `onclick` da notificação: navega com a tela já montada. */
function NotificationClick() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/attendance?conversationId=c-2')}>
      simular clique
    </button>
  );
}

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/attendance']}>
          <NotificationClick />
          <Attendance />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listMock.mockReset().mockResolvedValue(LIST);
  getMock.mockReset().mockImplementation((id: string) => Promise.resolve(detail(id)));
  listProposalsMock.mockReset().mockResolvedValue(NO_PROPOSALS);
  vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn() });
  useMessageAlertsStore.setState({ openConversationId: null, notificationsEnabled: true });
  useAuthStore.setState({
    user: { id: 'u-1', email: 'a@lab.com', name: 'Ana', role: 'attendant', discountLimit: 15 },
    tenant: null,
    theme: null,
    tokens: { accessToken: 'a', expiresAt: Date.now() + 60_000 },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Atendimento — aviso de mensagem nova (CRMLAB-72)', () => {
  it('clicar na notificação com a tela aberta abre a conversa certa e a publica como aberta', async () => {
    renderScreen();
    await screen.findByText('Paciente c-1');
    expect(useMessageAlertsStore.getState().openConversationId).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'simular clique' }));

    await waitFor(() => expect(getMock).toHaveBeenCalledWith('c-2', expect.anything()));
    await waitFor(() => expect(useMessageAlertsStore.getState().openConversationId).toBe('c-2'));
  });

  it('sair da tela limpa a conversa aberta', async () => {
    const view = renderScreen();
    await userEvent.click(screen.getByRole('button', { name: 'simular clique' }));
    await waitFor(() => expect(useMessageAlertsStore.getState().openConversationId).toBe('c-2'));
    view.unmount();
    expect(useMessageAlertsStore.getState().openConversationId).toBeNull();
  });

  it('mostra "Ativar notificações" no topo da fila enquanto a permissão não foi decidida', async () => {
    renderScreen();
    const list = await screen.findByTestId('inbox-list');
    expect(list.firstElementChild).toHaveTextContent('Ativar notificações');
  });
});
