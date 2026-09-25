import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  StartWhatsAppConversationResponse,
} from '@crm-lab/shared';
import type * as ApiModule from '@/api';

const listMock = vi.fn();
const getMock = vi.fn();
const startWhatsAppMock = vi.fn();
const listProposalsMock = vi.fn();
const listPatientsMock = vi.fn();

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
        startWhatsApp: startWhatsAppMock,
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
 * "Nova conversa" (CRMLAB-50, D-175) — PAGES.md §2, coluna 1.
 * O que este teste protege: o botão existe no topo da lista, o telefone é
 * validado ANTES de ir ao servidor, o envio manda o número já normalizado e a
 * conversa (nova ou reaproveitada) termina aberta — inclusive quando o canal
 * falha e a conversa foi criada mesmo assim.
 */

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c-new',
    patientId: 'p-1',
    patientName: null,
    patientPhone: '+5548999991234',
    assignedTo: 'u-1',
    assignedToName: 'Marina',
    channel: 'whatsapp',
    status: 'active',
    unreadCount: 0,
    lastMessagePreview: 'Olá!',
    lastMessageAt: '2026-09-25T09:12:00Z',
    pinned: false,
    tags: [],
    createdAt: '2026-09-25T09:12:00Z',
    ...overrides,
  };
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm-1',
    conversationId: 'c-new',
    senderType: 'agent',
    senderId: 'u-1',
    senderName: 'Marina',
    content: 'Olá!',
    messageType: 'text',
    attachmentUrl: null,
    status: 'sent',
    readAt: null,
    createdAt: '2026-09-25T09:12:00Z',
    ...overrides,
  };
}

const EMPTY_LIST: ListConversationsResponse = {
  conversations: [],
  counts: { mine: 0, unassigned: 0 },
  pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
};

function detail(): GetConversationResponse {
  return {
    conversation: { ...conversation(), patientEmail: null, customFields: {} },
    messages: [message()],
    pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
  };
}

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

async function openModal() {
  await userEvent.click(await screen.findByRole('button', { name: 'Nova conversa' }));
  return screen.findByRole('dialog', { name: 'Nova conversa' });
}

beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue(EMPTY_LIST);
  getMock.mockReset();
  getMock.mockResolvedValue(detail());
  startWhatsAppMock.mockReset();
  listProposalsMock.mockReset();
  listProposalsMock.mockResolvedValue(NO_PROPOSALS);
  listPatientsMock.mockReset();
  listPatientsMock.mockResolvedValue(NO_PATIENTS);
  localStorage.clear();
  useUIStore.setState({ sidebarCollapsed: true, contextPanelOpen: true, activeModal: null });
  useAuthStore.setState({
    user: {
      id: 'u-1',
      email: 'a@lab.com',
      name: 'Marina Alves',
      role: 'attendant',
      discountLimit: 15,
    },
    tenant: null,
    theme: null,
    tokens: { accessToken: 'a', expiresAt: Date.now() + 60_000 },
  });
});

describe('Atendimento — Nova conversa (CRMLAB-50)', () => {
  it('o botão fica no topo da lista, com tooltip "Nova conversa"', async () => {
    renderScreen();

    const button = await screen.findByRole('button', { name: 'Nova conversa' });
    await userEvent.hover(button);

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Nova conversa');
  });

  it('telefone inválido não vai ao servidor e mostra o motivo', async () => {
    renderScreen();
    const dialog = await openModal();

    await userEvent.type(within(dialog).getByLabelText('Telefone (WhatsApp)'), '99999-1234');
    await userEvent.type(within(dialog).getByLabelText('Mensagem'), 'Olá!');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(await within(dialog).findByText(/Telefone inválido/)).toBeInTheDocument();
    expect(startWhatsAppMock).not.toHaveBeenCalled();
  });

  it('mensagem vazia não vai ao servidor', async () => {
    renderScreen();
    const dialog = await openModal();

    await userEvent.type(within(dialog).getByLabelText('Telefone (WhatsApp)'), '(48) 99999-1234');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(await within(dialog).findByText('Escreva a primeira mensagem')).toBeInTheDocument();
    expect(startWhatsAppMock).not.toHaveBeenCalled();
  });

  it('envia com o telefone normalizado e deixa a conversa aberta e selecionada', async () => {
    const response: StartWhatsAppConversationResponse = {
      conversation: { ...conversation(), patientEmail: null, customFields: {} },
      message: message(),
    };
    startWhatsAppMock.mockResolvedValue(response);
    renderScreen();
    const dialog = await openModal();

    await userEvent.type(within(dialog).getByLabelText('Telefone (WhatsApp)'), '(48) 99999-1234');
    await userEvent.type(within(dialog).getByLabelText('Mensagem'), '  Olá!  ');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    await waitFor(() => {
      expect(startWhatsAppMock).toHaveBeenCalledWith({
        phone: '+5548999991234',
        content: 'Olá!',
      });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Abrir = GET do detalhe da conversa devolvida (e marcar como lida).
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('c-new', expect.anything()));
    expect(await screen.findByText('Mensagem enviada.')).toBeInTheDocument();
    expect(await screen.findByTestId('composer')).toBeInTheDocument();
  });

  it('canal fora do ar: abre a conversa criada mesmo assim e avisa que não enviou', async () => {
    startWhatsAppMock.mockRejectedValue(
      new ApiError('MESSAGE_SEND_FAILED', 'Falha ao enviar a mensagem pelo canal', 502, {
        messageId: 'm-1',
        conversationId: 'c-new',
      }),
    );
    renderScreen();
    const dialog = await openModal();

    await userEvent.type(within(dialog).getByLabelText('Telefone (WhatsApp)'), '48999991234');
    await userEvent.type(within(dialog).getByLabelText('Mensagem'), 'Olá!');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(await screen.findByText(/o WhatsApp não enviou a mensagem/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('c-new', expect.anything()));
  });

  it('número em atendimento com outra pessoa: erro dentro do modal, com o nome', async () => {
    startWhatsAppMock.mockRejectedValue(
      new ApiError('CONVERSATION_ALREADY_ASSIGNED', 'Conversa ja atribuida', 409, {
        assignedTo: 'u-2',
        assignedToName: 'Bia',
      }),
    );
    renderScreen();
    const dialog = await openModal();

    await userEvent.type(within(dialog).getByLabelText('Telefone (WhatsApp)'), '48999991234');
    await userEvent.type(within(dialog).getByLabelText('Mensagem'), 'Olá!');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(
      await within(dialog).findByText('Este número já está em atendimento com Bia.'),
    ).toBeInTheDocument();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('Enter repetido no telefone enquanto envia não manda a mensagem duas vezes', async () => {
    let resolveStart: (value: StartWhatsAppConversationResponse) => void = () => undefined;
    startWhatsAppMock.mockImplementation(
      () =>
        new Promise<StartWhatsAppConversationResponse>((resolve) => {
          resolveStart = resolve;
        }),
    );
    renderScreen();
    const dialog = await openModal();

    await userEvent.type(within(dialog).getByLabelText('Mensagem'), 'Olá!');
    const phoneInput = within(dialog).getByLabelText('Telefone (WhatsApp)');
    await userEvent.type(phoneInput, '(48) 99999-1234{Enter}');
    await waitFor(() => expect(startWhatsAppMock).toHaveBeenCalledTimes(1));
    await userEvent.type(phoneInput, '{Enter}{Enter}');

    expect(startWhatsAppMock).toHaveBeenCalledTimes(1);
    resolveStart({
      conversation: { ...conversation(), patientEmail: null, customFields: {} },
      message: message(),
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('Ctrl+Alt+N abre o modal', async () => {
    renderScreen();
    await screen.findByRole('button', { name: 'Nova conversa' });

    fireEvent.keyDown(document, { key: 'n', code: 'KeyN', ctrlKey: true, altKey: true });

    expect(await screen.findByRole('dialog', { name: 'Nova conversa' })).toBeInTheDocument();
  });

  it('Cancelar fecha sem enviar', async () => {
    renderScreen();
    await openModal();

    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(startWhatsAppMock).not.toHaveBeenCalled();
  });
});
