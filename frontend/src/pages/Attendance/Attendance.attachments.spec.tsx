import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Conversation,
  ListPatientsResponse,
  GetConversationResponse,
  ListConversationsResponse,
  ListProposalsResponse,
  Message,
} from '@crm-lab/shared';
import type * as ApiModule from '@/api';

const listMock = vi.fn();
const getMock = vi.fn();
const sendMessageMock = vi.fn();
const sendAttachmentMock = vi.fn();
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
        sendMessage: sendMessageMock,
        sendAttachment: sendAttachmentMock,
      },
      proposals: { ...actual.api.proposals, list: listProposalsMock },
      patients: { ...actual.api.patients, list: listPatientsMock },
    },
  };
});

const { ToastProvider } = await import('@/components/ui');
const { useAuthStore, useUIStore } = await import('@/stores');
const { Attendance } = await import('./index');

/**
 * Atendimento — anexos com prévia (CRMLAB-69, D-233): um POST por arquivo, em
 * sequência e na ordem; erro de um não para os outros; só o primeiro cita.
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
    unreadCount: 3,
    lastMessagePreview: 'Quanto fica hemograma?',
    lastMessageAt: '2026-08-23T09:12:00Z',
    pinned: false,
    tags: ['Orçamento'],
    createdAt: '2026-08-20T10:00:00Z',
    ...overrides,
  };
}

function listResponse(
  conversations: Conversation[],
  counts = { mine: 7, unassigned: 2 },
): ListConversationsResponse {
  return {
    conversations,
    counts,
    pagination: { page: 1, limit: 20, total: conversations.length, totalPages: 1 },
  };
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm-1',
    conversationId: 'c-1',
    senderType: 'patient',
    senderId: null,
    senderName: 'Marina Alves',
    content: 'Quanto fica hemograma?',
    messageType: 'text',
    attachmentUrl: null,
    status: 'read',
    readAt: null,
    createdAt: '2026-08-23T09:12:00Z',
    ...overrides,
  };
}

function detailResponse(messages: Message[] = [message()]): GetConversationResponse {
  return {
    conversation: {
      ...conversation({ unreadCount: 0 }),
      patientEmail: 'marina@email.com',
      customFields: { documento: '123.456.789-00' },
    },
    messages,
    pagination: { page: 1, limit: 50, total: messages.length, totalPages: 1 },

    cursors: { before: null, after: null },
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

beforeEach(() => {
  listMock.mockReset();
  getMock.mockReset();
  sendMessageMock.mockReset();
  sendAttachmentMock.mockReset();
  URL.createObjectURL = vi.fn(() => 'blob:img');
  URL.revokeObjectURL = vi.fn();
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

async function openConversationAndPick(files: File[]): Promise<HTMLElement> {
  listMock.mockResolvedValue(listResponse([conversation()]));
  getMock.mockResolvedValue(detailResponse());
  renderScreen();
  await userEvent.click(await screen.findByTestId('conversation-item'));
  await screen.findByTestId('composer');
  await userEvent.upload(screen.getByTestId('attach-document-input'), files);
  return screen.getByRole('dialog', { name: 'Prévia do anexo' });
}

describe('Atendimento — anexos com prévia (CRMLAB-69)', () => {
  it('escolher uma imagem abre a prévia; enviar com legenda manda `caption`', async () => {
    sendAttachmentMock.mockResolvedValue(message({ id: 'm-2', senderType: 'agent' }));
    const print = new File(['png'], 'print.png', { type: 'image/png' });
    const preview = await openConversationAndPick([print]);
    expect(sendAttachmentMock).not.toHaveBeenCalled();

    await userEvent.type(within(preview).getByLabelText('Adicionar legenda'), 'Seu pedido{Enter}');

    await waitFor(() =>
      expect(sendAttachmentMock).toHaveBeenCalledWith('c-1', {
        fileName: 'print.png',
        mimeType: 'image/png',
        contentBase64: btoa('png'),
        caption: 'Seu pedido',
      }),
    );
  });

  it('3 arquivos, remove 1: sobem 2, um de cada vez e na ordem da faixa', async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    sendAttachmentMock.mockImplementation(
      (_id: string, body: { fileName: string }) =>
        new Promise((resolve) => {
          order.push(body.fileName);
          release = () => resolve(message({ id: `m-${body.fileName}`, senderType: 'agent' }));
        }),
    );
    const preview = await openConversationAndPick([
      new File(['a'], 'a.pdf', { type: 'application/pdf' }),
      new File(['b'], 'b.pdf', { type: 'application/pdf' }),
      new File(['c'], 'c.pdf', { type: 'application/pdf' }),
    ]);
    await userEvent.click(within(preview).getByRole('button', { name: 'Remover b.pdf' }));
    await userEvent.click(within(preview).getByRole('button', { name: 'Enviar' }));

    await waitFor(() => expect(order).toEqual(['a.pdf']));
    // O segundo só sai depois que o primeiro respondeu.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['a.pdf']);
    release?.();
    await waitFor(() => expect(order).toEqual(['a.pdf', 'c.pdf']));
    release?.();
  });

  it('erro de um arquivo avisa com o nome dele e os seguintes continuam', async () => {
    const { ApiError } = await import('@/api');
    sendAttachmentMock
      .mockRejectedValueOnce(new ApiError('MEDIA_TOO_LARGE', 'Arquivo acima do limite', 413))
      .mockResolvedValueOnce(message({ id: 'm-3', senderType: 'agent' }));
    const preview = await openConversationAndPick([
      new File(['a'], 'a.pdf', { type: 'application/pdf' }),
      new File(['b'], 'b.pdf', { type: 'application/pdf' }),
    ]);
    await userEvent.click(within(preview).getByRole('button', { name: 'Enviar' }));

    await waitFor(() => expect(sendAttachmentMock).toHaveBeenCalledTimes(2));
    expect(sendAttachmentMock.mock.calls[1]?.[1]).toMatchObject({ fileName: 'b.pdf' });
    expect(await screen.findByText(/Não foi possível enviar "a\.pdf"/)).toBeInTheDocument();
  });

  it('respondendo citando com 2 arquivos: só o PRIMEIRO leva o quotedMessageId', async () => {
    sendAttachmentMock.mockResolvedValue(message({ id: 'm-9', senderType: 'agent' }));
    listMock.mockResolvedValue(listResponse([conversation()]));
    getMock.mockResolvedValue(detailResponse());
    renderScreen();
    await userEvent.click(await screen.findByTestId('conversation-item'));
    const scroll = await screen.findByTestId('message-scroll');
    const bubble = (await within(scroll).findByText('Quanto fica hemograma?')).closest(
      '[data-testid="message-bubble"]',
    ) as HTMLElement;
    await userEvent.click(within(bubble).getByRole('button', { name: 'Ações da mensagem' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Responder' }));
    await userEvent.upload(screen.getByTestId('attach-document-input'), [
      new File(['a'], 'a.pdf', { type: 'application/pdf' }),
      new File(['b'], 'b.pdf', { type: 'application/pdf' }),
    ]);
    const preview = screen.getByRole('dialog', { name: 'Prévia do anexo' });
    await userEvent.click(within(preview).getByRole('button', { name: 'Enviar' }));

    await waitFor(() => expect(sendAttachmentMock).toHaveBeenCalledTimes(2));
    expect(sendAttachmentMock.mock.calls[0]?.[1]).toMatchObject({ quotedMessageId: 'm-1' });
    expect(sendAttachmentMock.mock.calls[1]?.[1]).not.toHaveProperty('quotedMessageId');
  });

  it('× descarta sem enviar nada', async () => {
    const preview = await openConversationAndPick([
      new File(['a'], 'a.pdf', { type: 'application/pdf' }),
    ]);
    await userEvent.click(within(preview).getByRole('button', { name: 'Descartar anexos' }));
    expect(screen.queryByRole('dialog', { name: 'Prévia do anexo' })).not.toBeInTheDocument();
    expect(sendAttachmentMock).not.toHaveBeenCalled();
  });
});
