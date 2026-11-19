import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Conversation,
  ListPatientsResponse,
  GetConversationResponse,
  ListConversationsResponse,
  ListProposalsResponse,
  Message,
  Scan,
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

const { ApiError } = await import('@/api');
const { ToastProvider } = await import('@/components/ui');
const { useAuthStore, useUIStore } = await import('@/stores');
const { Attendance } = await import('./index');
const { SCAN_GONE_MESSAGE } = await import('./ScanPicker');

/**
 * Atendimento — clipe "Digitalizações" (CRMLAB-184, D-326): o `ScanPicker`
 * lista a fila (`GET /scans`, fetch mockado), "Usar" leva as fotos para a
 * mesma prévia e o envio manda `scanId` em vez do arquivo.
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


/* ── fetch da fila: GET /scans, GET /scans/:id/content, DELETE /scans/:id ── */

const now = Date.now();
function scan(id: string, minutesAgo: number): Scan {
  return {
    id,
    deviceId: 'd-1',
    deviceName: 'Celular recepção',
    fileName: `digitalizacao-${id}.jpg`,
    mimeType: 'image/jpeg',
    byteSize: 1000,
    contentUrl: `/api/v1/scans/${id}/content`,
    createdAt: new Date(now - minutesAgo * 60_000).toISOString(),
    expiresAt: new Date(now + 86_400_000).toISOString(),
  };
}

let queue: Scan[] = [];
const fetchCalls: Array<{ url: string; method: string }> = [];

function fakeResponse(status: number, body?: unknown, blob?: Blob): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body)),
    blob: () => Promise.resolve(blob ?? new Blob()),
  } as unknown as Response;
}

const fetchMock = vi.fn((input: string, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  fetchCalls.push({ url, method });
  const content = /\/scans\/([^/]+)\/content$/.exec(url);
  if (content) return Promise.resolve(fakeResponse(200, undefined, new Blob(['jpg'], { type: 'image/jpeg' })));
  const one = /\/scans\/([^/?]+)$/.exec(url);
  if (one && method === 'DELETE') {
    queue = queue.filter((item) => item.id !== one[1]);
    return Promise.resolve(fakeResponse(204));
  }
  if (/\/scans(\?|$)/.test(url)) {
    return Promise.resolve(
      fakeResponse(200, {
        scans: queue,
        pagination: { page: 1, limit: 50, total: queue.length, totalPages: 1 },
      }),
    );
  }
  return Promise.resolve(fakeResponse(404, { error: { code: 'NOT_FOUND', message: 'x', statusCode: 404 } }));
});

beforeEach(() => {
  queue = [scan('s-1', 12), scan('s-2', 3)];
  fetchCalls.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openScanPicker(): Promise<HTMLElement> {
  listMock.mockResolvedValue(listResponse([conversation()]));
  getMock.mockResolvedValue(detailResponse());
  renderScreen();
  await userEvent.click(await screen.findByTestId('conversation-item'));
  await screen.findByTestId('composer');
  await userEvent.click(screen.getByRole('button', { name: 'Anexar arquivo' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Digitalizações' }));
  return screen.findByRole('dialog', { name: 'Digitalizações' });
}

describe('Atendimento — clipe Digitalizações (CRMLAB-184)', () => {
  it('lista a fila com "há X min · dispositivo"; Usar → prévia → envio com scanId', async () => {
    sendAttachmentMock.mockResolvedValue(message({ id: 'm-2', senderType: 'agent' }));
    const picker = await openScanPicker();

    expect(await within(picker).findAllByTestId('scan-tile')).toHaveLength(2);
    expect(within(picker).getByText('há 12 min · Celular recepção')).toBeInTheDocument();
    const use = within(picker).getByRole('button', { name: 'Usar (0)' });
    expect(use).toBeDisabled();

    await userEvent.click(within(picker).getByRole('button', { name: /Selecionar foto de há 12 min/ }));
    await userEvent.click(within(picker).getByRole('button', { name: /Selecionar foto de há 3 min/ }));
    await userEvent.click(within(picker).getByRole('button', { name: 'Usar (2)' }));

    const preview = await screen.findByRole('dialog', { name: 'Prévia do anexo' });
    expect(screen.queryByRole('dialog', { name: 'Digitalizações' })).not.toBeInTheDocument();
    expect(within(preview).getAllByTestId('attachment-thumb')).toHaveLength(2);
    expect(sendAttachmentMock).not.toHaveBeenCalled();

    await userEvent.type(within(preview).getByLabelText('Adicionar legenda'), 'Seu pedido{Enter}');

    await waitFor(() => expect(sendAttachmentMock).toHaveBeenCalledTimes(2));
    // Ordem da grade (mais nova primeiro: s-1 veio do servidor antes de s-2).
    expect(sendAttachmentMock.mock.calls[0]).toEqual(['c-1', { scanId: 's-1', caption: 'Seu pedido' }]);
    expect(sendAttachmentMock.mock.calls[1]).toEqual(['c-1', { scanId: 's-2' }]);
  });

  it('scan_not_found: toast "Essa foto já foi usada ou venceu" e a outra segue', async () => {
    sendAttachmentMock
      .mockRejectedValueOnce(
        new ApiError('NOT_FOUND', 'Não encontrado', 404, { reason: 'scan_not_found' }),
      )
      .mockResolvedValueOnce(message({ id: 'm-3', senderType: 'agent' }));
    const picker = await openScanPicker();
    await within(picker).findAllByTestId('scan-tile');
    await userEvent.click(within(picker).getByRole('button', { name: /Selecionar foto de há 12 min/ }));
    await userEvent.click(within(picker).getByRole('button', { name: /Selecionar foto de há 3 min/ }));
    await userEvent.click(within(picker).getByRole('button', { name: 'Usar (2)' }));
    const preview = await screen.findByRole('dialog', { name: 'Prévia do anexo' });
    await userEvent.click(within(preview).getByRole('button', { name: 'Enviar' }));

    await waitFor(() => expect(sendAttachmentMock).toHaveBeenCalledTimes(2));
    expect(sendAttachmentMock.mock.calls[1]?.[1]).toEqual({ scanId: 's-2' });
    expect(await screen.findByText(SCAN_GONE_MESSAGE)).toBeInTheDocument();
  });

  it('fila vazia mostra o caminho para o celular', async () => {
    queue = [];
    const picker = await openScanPicker();
    expect(
      await within(picker).findByText('Nenhuma foto. Tire pelo atalho Digitalizar no celular.'),
    ).toBeInTheDocument();
  });

  it('lixeira pede confirmação e faz DELETE /scans/:id', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const picker = await openScanPicker();
    await within(picker).findAllByTestId('scan-tile');

    await userEvent.click(within(picker).getByRole('button', { name: 'Descartar foto de há 12 min' }));
    expect(fetchCalls.some((call) => call.method === 'DELETE')).toBe(false);

    await userEvent.click(within(picker).getByRole('button', { name: 'Descartar foto de há 12 min' }));
    await waitFor(() =>
      expect(fetchCalls).toContainEqual({ url: expect.stringMatching(/\/scans\/s-1$/), method: 'DELETE' }),
    );
    await waitFor(() => expect(within(picker).getAllByTestId('scan-tile')).toHaveLength(1));
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('reabrir o seletor reconsulta a fila', async () => {
    const picker = await openScanPicker();
    await within(picker).findAllByTestId('scan-tile');
    await userEvent.click(within(picker).getByRole('button', { name: 'Cancelar' }));
    const before = fetchCalls.filter((call) => /\/scans$/.test(call.url)).length;
    await userEvent.click(screen.getByRole('button', { name: 'Anexar arquivo' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Digitalizações' }));
    await screen.findByRole('dialog', { name: 'Digitalizações' });
    await waitFor(() =>
      expect(fetchCalls.filter((call) => /\/scans$/.test(call.url)).length).toBe(before + 1),
    );
  });
});
