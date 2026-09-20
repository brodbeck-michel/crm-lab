import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Conversation,
  ListPatientsResponse,
  PatientListItem,
  GetConversationResponse,
  ListConversationsResponse,
  ListProposalsResponse,
  Message,
} from '@crm-lab/shared';
import type * as ApiModule from '@/api';

const listMock = vi.fn();
const getMock = vi.fn();
const sendMessageMock = vi.fn();
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
 * Atendimento — PAGES.md §2.
 * O que este teste protege: as contagens dos chips vêm do SERVIDOR, abrir a
 * conversa marca como lida, e nenhum dos três estados (carregando, vazio,
 * erro) deixa área em branco.
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
  };
}

const NO_PROPOSALS: ListProposalsResponse = {
  proposals: [],
  pagination: { page: 1, limit: 20, total: 0, totalPages: 1 },
};

function patient(overrides: Partial<PatientListItem> = {}): PatientListItem {
  return {
    id: 'p-1',
    phone: '(11) 98765-4321',
    name: 'Marina Alves',
    email: null,
    birthDate: null,
    document: null,
    notes: null,
    tags: [],
    customFields: {},
    anonymizedAt: null,
    inactivatedAt: null,
    inactivationReason: null,
    lastInteractionAt: '2026-08-23T09:12:00Z',
    createdAt: '2026-08-01T09:12:00Z',
    updatedAt: '2026-08-01T09:12:00Z',
    ...overrides,
  };
}

function patientsResponse(patients: PatientListItem[]): ListPatientsResponse {
  return {
    patients,
    pagination: { page: 1, limit: 5, total: patients.length, totalPages: 1 },
  };
}

const NO_PATIENTS: ListPatientsResponse = patientsResponse([]);

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

describe('Atendimento — lista de conversas', () => {
  it('mostra estado de carregando', () => {
    listMock.mockReturnValue(new Promise(() => undefined));
    renderScreen();

    expect(screen.getByText('Carregando conversas…')).toBeInTheDocument();
  });

  it('as contagens dos chips vêm do servidor, não da lista carregada', async () => {
    listMock.mockResolvedValue(listResponse([conversation()], { mine: 7, unassigned: 2 }));
    renderScreen();

    expect(await screen.findByRole('button', { name: 'Minhas 7' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Não atribuídas 2' })).toBeInTheDocument();
    // uma conversa carregada, sete no contador: a conta é do servidor.
    expect(screen.getAllByTestId('conversation-item')).toHaveLength(1);
  });

  it('chip filtra pelo scope e o filtro desligado volta a mostrar tudo', async () => {
    listMock.mockResolvedValue(listResponse([conversation()]));
    renderScreen();

    await screen.findByTestId('conversation-item');
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ scope: 'mine' }));

    await userEvent.click(screen.getByRole('button', { name: 'Não atribuídas 2' }));
    await waitFor(() => {
      expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ scope: 'unassigned' }));
    });

    await userEvent.click(screen.getByRole('button', { name: 'Não atribuídas 2' }));
    await waitFor(() => {
      expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ scope: 'all' }));
    });
  });

  it('lista vazia não deixa área em branco', async () => {
    listMock.mockResolvedValue(listResponse([], { mine: 0, unassigned: 0 }));
    renderScreen();

    expect(await screen.findByText('Nenhuma conversa por aqui')).toBeInTheDocument();
  });

  it('falha de rede mostra erro com ação de tentar de novo', async () => {
    listMock.mockRejectedValue(new Error('rede caiu'));
    renderScreen();

    expect(await screen.findByText('Não foi possível carregar as conversas')).toBeInTheDocument();

    listMock.mockResolvedValue(listResponse([conversation()]));
    await userEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));

    expect(await screen.findByTestId('conversation-item')).toBeInTheDocument();
  });
});

describe('Atendimento — abrir conversa', () => {
  it('abrir a conversa dispara markAsRead e refaz a listagem', async () => {
    listMock.mockResolvedValue(listResponse([conversation()]));
    getMock.mockResolvedValue(detailResponse());
    renderScreen();

    await userEvent.click(await screen.findByTestId('conversation-item'));

    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith('c-1', { limit: 50 });
    });
    // markAsRead invalida a listagem para o badge e as contagens caírem.
    await waitFor(() => {
      expect(listMock.mock.calls.length).toBeGreaterThan(1);
    });
  });

  it('renderiza a conversa aberta com header, bolhas e composer', async () => {
    listMock.mockResolvedValue(listResponse([conversation()]));
    getMock.mockResolvedValue(detailResponse());
    renderScreen();

    await userEvent.click(await screen.findByTestId('conversation-item'));

    expect(await screen.findByRole('button', { name: 'Novo Orçamento' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Arquivar' })).toBeInTheDocument();
    expect(screen.getByTestId('message-bubble')).toHaveAttribute('data-type', 'received');
    expect(screen.getByTestId('composer')).toBeInTheDocument();
  });

  it('conversa sem mensagem tem estado vazio próprio', async () => {
    listMock.mockResolvedValue(listResponse([conversation()]));
    getMock.mockResolvedValue(detailResponse([]));
    renderScreen();

    await userEvent.click(await screen.findByTestId('conversation-item'));

    expect(await screen.findByText('Nenhuma mensagem ainda')).toBeInTheDocument();
  });

  it('envia mensagem pelo composer', async () => {
    listMock.mockResolvedValue(listResponse([conversation()]));
    getMock.mockResolvedValue(detailResponse());
    sendMessageMock.mockResolvedValue(message({ id: 'm-2', senderType: 'agent' }));
    renderScreen();

    await userEvent.click(await screen.findByTestId('conversation-item'));
    const composer = await screen.findByTestId('composer');
    await userEvent.type(within(composer).getByLabelText('Mensagem'), 'Bom dia!');
    await userEvent.click(within(composer).getByRole('button', { name: 'Enviar' }));

    await waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith('c-1', {
        content: 'Bom dia!',
        messageType: 'text',
      });
    });
  });

  it('sem conversa selecionada, a coluna do meio orienta em vez de ficar em branco', async () => {
    listMock.mockResolvedValue(listResponse([conversation()]));
    renderScreen();

    expect(await screen.findByText('Selecione uma conversa')).toBeInTheDocument();
  });

  it('falha ao carregar a conversa mostra erro na coluna do meio', async () => {
    listMock.mockResolvedValue(listResponse([conversation()]));
    getMock.mockRejectedValue(new Error('rede caiu'));
    renderScreen();

    await userEvent.click(await screen.findByTestId('conversation-item'));

    expect(await screen.findByText('Não foi possível carregar a conversa')).toBeInTheDocument();
  });
});

/**
 * A porta de entrada da Ficha do Paciente (D-079).
 *
 * O defeito que estes testes fecham: a rota `/patients/:id` existia, tinha
 * permissão registrada e nenhum link no produto inteiro — só se chegava lá
 * digitando a URL. Por isso as asserções são sobre NAVEGAÇÃO REAL (o `<a>` e o
 * destino renderizado), não sobre o dado ter chegado na tela.
 */

/** Marcador da rota de destino: prova que o clique chegou à ficha certa. */
function PatientProfileStub() {
  const { id } = useParams<{ id: string }>();
  return <p data-testid="ficha-do-paciente">{`ficha:${id ?? ''}`}</p>;
}

function renderWithPatientRoute() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/attendance']}>
          <Routes>
            <Route path="/attendance" element={<Attendance />} />
            <Route path="/patients/:id" element={<PatientProfileStub />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Atendimento — porta de entrada da Ficha do Paciente (D-079)', () => {
  it('coluna 3: com patientId o link existe e leva à ficha DAQUELE paciente', async () => {
    listMock.mockResolvedValue(listResponse([conversation()]));
    getMock.mockResolvedValue(detailResponse());
    renderWithPatientRoute();

    await userEvent.click(await screen.findByTestId('conversation-item'));

    const link = await screen.findByTestId('patient-profile-link');
    expect(link).toHaveAttribute('href', '/patients/p-1');

    await userEvent.click(link);
    expect(await screen.findByTestId('ficha-do-paciente')).toHaveTextContent('ficha:p-1');
  });

  it('coluna 3: conversa anterior ao backfill (patientId null) NÃO mostra o link', async () => {
    listMock.mockResolvedValue(listResponse([conversation({ patientId: null })]));
    getMock.mockResolvedValue({
      ...detailResponse(),
      conversation: {
        ...detailResponse().conversation,
        patientId: null,
      },
    });
    renderWithPatientRoute();

    await userEvent.click(await screen.findByTestId('conversation-item'));

    // A coluna 3 carregou (o cadastro está lá) — o que falta é só o link.
    expect(await screen.findByText('Cadastro')).toBeInTheDocument();
    expect(screen.queryByTestId('patient-profile-link')).not.toBeInTheDocument();
  });

  it('a busca do inbox consulta GET /patients e cada resultado abre a ficha', async () => {
    listMock.mockResolvedValue(listResponse([conversation()]));
    listPatientsMock.mockResolvedValue(
      patientsResponse([patient({ id: 'p-9', name: 'Carla Dias' })]),
    );
    renderWithPatientRoute();

    await screen.findByTestId('conversation-item');
    await userEvent.type(
      screen.getByLabelText('Buscar paciente, telefone ou exame'),
      'Carla{Enter}',
    );

    await waitFor(() => {
      expect(listPatientsMock).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'Carla', limit: 5 }),
      );
    });

    const result = await screen.findByTestId('patient-result');
    expect(result).toHaveAttribute('href', '/patients/p-9');

    await userEvent.click(result);
    expect(await screen.findByTestId('ficha-do-paciente')).toHaveTextContent('ficha:p-9');
  });

  it('sem termo de busca a coluna 1 não pede pacientes nem mostra o bloco', async () => {
    listMock.mockResolvedValue(listResponse([conversation()]));
    renderWithPatientRoute();

    await screen.findByTestId('conversation-item');

    expect(listPatientsMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Pacientes encontrados' })).not.toBeInTheDocument();
  });
});
