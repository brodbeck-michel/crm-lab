import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ListPatientTimelineResponse,
  ListProposalsResponse,
  PatientDetail,
  PatientExport,
  UserRole,
} from '@crm-lab/shared';
import { ApiError } from '@/api/client';
import { patientsApi } from '@/api/patients';
import type * as ProposalsApiModule from '@/api/proposals';
import { proposalsApi } from '@/api/proposals';
import { ToastProvider } from '@/components/ui';
import { useAuthStore } from '@/stores';
import { useUIStore } from '@/stores/ui.store';
import PatientProfile from './Profile';

/**
 * Os mocks devolvem o shape EXATO de `shared/types` — as constantes abaixo são
 * anotadas com o tipo do contrato, então um campo faltando ou um campo a mais
 * quebra o typecheck aqui, e não em produção. Sem `as any` em lugar nenhum
 * (pendência D1 da Onda 5).
 */

vi.mock('@/api/patients', () => ({
  patientsApi: {
    list: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    timeline: vi.fn(),
    export: vi.fn(),
    anonymize: vi.fn(),
  },
}));

vi.mock('@/api/proposals', async () => {
  const actual = await vi.importActual<typeof ProposalsApiModule>('@/api/proposals');
  return { ...actual, proposalsApi: { ...actual.proposalsApi, list: vi.fn() } };
});

const getMock = vi.mocked(patientsApi.get);
const updateMock = vi.mocked(patientsApi.update);
const timelineMock = vi.mocked(patientsApi.timeline);
const exportMock = vi.mocked(patientsApi.export);
const anonymizeMock = vi.mocked(patientsApi.anonymize);
const listProposalsMock = vi.mocked(proposalsApi.list);

const PATIENT_ID = '3f1c9b0e-2d54-4a7b-9c11-8e2a6d5f4b30';

const patient: PatientDetail = {
  id: PATIENT_ID,
  phone: '(11) 98765-4321',
  name: 'João Santos',
  email: 'joao@email.com',
  birthDate: '1984-03-12',
  document: '12345678900',
  notes: 'Prefere coleta pela manhã.',
  tags: ['convênio'],
  customFields: { convenio: 'Unimed' },
  anonymizedAt: null,
  conversationCount: 4,
  proposalCount: 2,
  lastInteractionAt: '2026-08-23T14:30:00.000Z',
  createdAt: '2026-06-02T10:00:00.000Z',
  updatedAt: '2026-08-20T09:15:00.000Z',
};

/** As QUATRO espécies da união discriminada, numa página só. */
const timelinePage1: ListPatientTimelineResponse = {
  entries: [
    {
      id: 'proposal_stage_changed:8c2e1f77-0b13-4a3d-9d54-1f0e6b7a2c19',
      kind: 'proposal_stage_changed',
      at: '2026-08-23T15:00:00.000Z',
      proposalId: '6d9a4c2b-71e5-4f18-8b0a-3c5d2e9f1a44',
      from: 'orcamento_enviado',
      to: 'follow_up',
      changedByName: 'Maria Souza',
    },
    {
      id: 'proposal_created:6d9a4c2b-71e5-4f18-8b0a-3c5d2e9f1a44',
      kind: 'proposal_created',
      at: '2026-08-23T14:40:00.000Z',
      proposalId: '6d9a4c2b-71e5-4f18-8b0a-3c5d2e9f1a44',
      status: 'orcamento_enviado',
      discountPercent: 10,
      totalPrice: 179.8,
      createdByName: 'Maria Souza',
    },
    {
      id: 'message:b1d4e7a9-5c62-4e30-9f81-2a7c8b3d6e05',
      kind: 'message',
      at: '2026-08-23T14:25:00.000Z',
      conversationId: 'a7f3c2d1-4e58-49b6-8c02-7d1e5f9a3b64',
      senderType: 'patient',
      senderName: 'João Santos',
      messageType: 'text',
      preview: 'Olá, quanto custa um hemograma?',
    },
    {
      id: 'conversation_started:a7f3c2d1-4e58-49b6-8c02-7d1e5f9a3b64',
      kind: 'conversation_started',
      at: '2026-08-20T10:00:00.000Z',
      conversationId: 'a7f3c2d1-4e58-49b6-8c02-7d1e5f9a3b64',
      channel: 'whatsapp',
    },
  ],
  pagination: { page: 1, limit: 20, total: 24, totalPages: 2 },
};

const timelinePage2: ListPatientTimelineResponse = {
  entries: [
    {
      id: 'message:0d0a4c2b-71e5-4f18-8b0a-3c5d2e9f1a99',
      kind: 'message',
      at: '2026-08-19T09:00:00.000Z',
      conversationId: 'a7f3c2d1-4e58-49b6-8c02-7d1e5f9a3b64',
      senderType: 'agent',
      senderName: 'Maria Souza',
      messageType: 'text',
      preview: 'Bom dia! Como posso ajudar?',
    },
  ],
  pagination: { page: 2, limit: 20, total: 24, totalPages: 2 },
};

const proposalsResponse: ListProposalsResponse = {
  proposals: [
    {
      id: '6d9a4c2b-71e5-4f18-8b0a-3c5d2e9f1a44',
      proposalNumber: 1,
      conversationId: 'a7f3c2d1-4e58-49b6-8c02-7d1e5f9a3b64',
      patientName: 'João Santos',
      status: 'orcamento_enviado',
      discountPercent: 10,
      totalPrice: 179.8,
      createdBy: 'user-2',
      createdByName: 'Maria Souza',
      approvalStatus: 'none',
      reasonLost: null,
      createdAt: '2026-08-23T14:40:00.000Z',
      updatedAt: '2026-08-23T15:00:00.000Z',
      closedAt: null,
      insuranceId: null,
    },
  ],
  pagination: { page: 1, limit: 12, total: 1, totalPages: 1 },
};

const exportResponse: PatientExport = {
  generatedAt: '2026-08-24T12:00:00.000Z',
  patient: {
    id: patient.id,
    phone: patient.phone,
    name: patient.name,
    email: patient.email,
    birthDate: patient.birthDate,
    document: patient.document,
    notes: patient.notes,
    tags: patient.tags,
    customFields: patient.customFields,
    anonymizedAt: null,
    createdAt: patient.createdAt,
    updatedAt: patient.updatedAt,
  },
  conversations: [],
  proposals: [],
};

function signIn(role: UserRole) {
  useAuthStore.setState({
    user: { id: 'user-1', email: 'a@lab.com.br', name: 'Ana', role, discountLimit: 10 },
  });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/patients/${PATIENT_ID}`]}>
          <Routes>
            <Route path="/patients/:id" element={<PatientProfile />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Ficha do Paciente', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signIn('manager');
    getMock.mockResolvedValue(patient);
    timelineMock.mockResolvedValue(timelinePage1);
    listProposalsMock.mockResolvedValue(proposalsResponse);
    updateMock.mockResolvedValue(patient);
    exportMock.mockResolvedValue(exportResponse);
    useUIStore.setState({ activeModal: null });
  });

  afterEach(() => {
    useAuthStore.setState({ user: null });
  });

  /* ── Bloco 1: cadastro e contadores ─────────────────────────────────── */

  it('renderiza cadastro, contadores e telefone do contrato', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'João Santos' })).toBeInTheDocument();
    expect(screen.getByLabelText('Nome')).toHaveValue('João Santos');
    expect(screen.getByLabelText('E-mail')).toHaveValue('joao@email.com');
    expect(screen.getByLabelText('CPF')).toHaveValue('12345678900');
    expect(screen.getByLabelText('Anotações internas')).toHaveValue('Prefere coleta pela manhã.');

    const summary = within(screen.getByLabelText('Resumo da ficha'));
    expect(summary.getByText('4')).toBeInTheDocument();
    expect(summary.getByText('2')).toBeInTheDocument();
  });

  it('faz as TRÊS chamadas da ficha — cadastro, timeline e /proposals?patientId', async () => {
    renderPage();

    await waitFor(() => expect(listProposalsMock).toHaveBeenCalled());
    expect(getMock).toHaveBeenCalledWith(PATIENT_ID);
    expect(timelineMock).toHaveBeenCalledWith(
      PATIENT_ID,
      expect.objectContaining({ page: 1, limit: 20, order: 'desc' }),
    );
    expect(listProposalsMock).toHaveBeenCalledWith(
      expect.objectContaining({ patientId: PATIENT_ID, page: 1 }),
    );
  });

  it('D-106: telefone é editável e entra no PATCH quando muda', async () => {
    const user = userEvent.setup();
    updateMock.mockResolvedValue({ ...patient, phone: '+5548987654321' });
    renderPage();

    const phone = await screen.findByLabelText('Telefone');
    expect(phone).not.toBeDisabled();
    expect(phone).toHaveValue('(11) 98765-4321');

    await user.clear(phone);
    await user.type(phone, '(48) 98765-4321');
    await user.click(screen.getByRole('button', { name: 'Salvar cadastro' }));

    await waitFor(() => {
      expect(updateMock).toHaveBeenCalledWith(
        PATIENT_ID,
        expect.objectContaining({ phone: '(48) 98765-4321' }),
      );
    });
  });

  it('D-106: telefone já usado por outro paciente mostra erro no campo, não trava a tela', async () => {
    const user = userEvent.setup();
    updateMock.mockRejectedValue(
      new ApiError('CONFLICT', 'Conflito', 409, { reason: 'phone_already_in_use' }),
    );
    renderPage();

    const phone = await screen.findByLabelText('Telefone');
    await user.clear(phone);
    await user.type(phone, '(48) 99999-8888');
    await user.click(screen.getByRole('button', { name: 'Salvar cadastro' }));

    expect(
      await screen.findByText('Este telefone já pertence a outro paciente.'),
    ).toBeInTheDocument();
  });

  it('mostra "não encontrado" (não "sem permissão") quando a API responde 404', async () => {
    getMock.mockRejectedValue(new ApiError('NOT_FOUND', 'Paciente não encontrado', 404));

    renderPage();

    expect(await screen.findByText('Paciente não encontrado')).toBeInTheDocument();
    expect(screen.queryByText(/permiss/i)).not.toBeInTheDocument();
  });

  /* ── PATCH parcial ──────────────────────────────────────────────────── */

  it('envia no PATCH apenas o campo alterado', async () => {
    const user = userEvent.setup();
    renderPage();

    const name = await screen.findByLabelText('Nome');
    await user.clear(name);
    await user.type(name, 'João S. Santos');
    await user.click(screen.getByRole('button', { name: 'Salvar cadastro' }));

    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    expect(updateMock).toHaveBeenCalledWith(PATIENT_ID, { name: 'João S. Santos' });
  });

  it('envia `null` para o campo esvaziado — `null` apaga, ausente preserva', async () => {
    const user = userEvent.setup();
    renderPage();

    const email = await screen.findByLabelText('E-mail');
    await user.clear(email);
    await user.click(screen.getByRole('button', { name: 'Salvar cadastro' }));

    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    const [, body] = updateMock.mock.calls[0] ?? [];
    expect(body).toEqual({ email: null });
    // Os campos intocados NÃO viajam: enviá-los seria apagá-los sem querer.
    expect(body).not.toHaveProperty('name');
    expect(body).not.toHaveProperty('notes');
    expect(body).not.toHaveProperty('phone');
  });

  it('não permite salvar quando nada mudou', async () => {
    renderPage();

    expect(await screen.findByRole('button', { name: 'Salvar cadastro' })).toBeDisabled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('marca o campo com o motivo de VALIDATION_ERROR do backend', async () => {
    const user = userEvent.setup();
    updateMock.mockRejectedValue(
      new ApiError('VALIDATION_ERROR', 'Dados inválidos', 400, {
        fields: { document: 'CPF inválido' },
      }),
    );

    renderPage();

    const cpf = await screen.findByLabelText('CPF');
    await user.clear(cpf);
    await user.type(cpf, '11111111111');
    await user.click(screen.getByRole('button', { name: 'Salvar cadastro' }));

    expect(await screen.findByText('CPF inválido')).toBeInTheDocument();
  });

  it('bloqueia a edição de cadastro já anonimizado', async () => {
    getMock.mockResolvedValue({
      ...patient,
      name: null,
      email: null,
      birthDate: null,
      document: null,
      notes: null,
      tags: [],
      customFields: {},
      anonymizedAt: '2026-08-24T12:05:00.000Z',
    });

    renderPage();

    expect(await screen.findByText(/Cadastro anonimizado a pedido do titular/)).toBeInTheDocument();
    expect(screen.getByLabelText('Nome')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Salvar cadastro' })).not.toBeInTheDocument();
  });

  /* ── Bloco 2: timeline ──────────────────────────────────────────────── */

  it('renderiza as quatro espécies da timeline, cada uma do seu jeito', async () => {
    renderPage();

    await screen.findByText('Conversa iniciada');
    const timeline = within(screen.getByLabelText('Histórico de interações'));

    expect(timeline.getByText('Conversa iniciada')).toBeInTheDocument();
    expect(timeline.getByText('WhatsApp')).toBeInTheDocument();

    expect(timeline.getByText('Mensagem · Paciente')).toBeInTheDocument();
    expect(timeline.getByText('Olá, quanto custa um hemograma?')).toBeInTheDocument();

    expect(timeline.getByText('Orçamento criado')).toBeInTheDocument();
    expect(timeline.getByText('R$ 179,80')).toBeInTheDocument();

    expect(timeline.getByText('Mudança de estágio')).toBeInTheDocument();
    expect(timeline.getByText('Orçamento enviado → Follow-up')).toBeInTheDocument();
  });

  it('avança a paginação da timeline pedindo a página 2 ao servidor', async () => {
    const user = userEvent.setup();
    timelineMock.mockImplementation((_id, query) =>
      Promise.resolve(query?.page === 2 ? timelinePage2 : timelinePage1),
    );

    renderPage();

    expect(await screen.findByText(/página 1 de 2/)).toBeInTheDocument();

    const timeline = within(screen.getByLabelText('Histórico de interações'));
    await user.click(timeline.getByRole('button', { name: 'Próxima' }));

    expect(await screen.findByText('Bom dia! Como posso ajudar?')).toBeInTheDocument();
    expect(screen.getByText(/página 2 de 2/)).toBeInTheDocument();
    expect(timelineMock).toHaveBeenCalledWith(PATIENT_ID, expect.objectContaining({ page: 2 }));
    expect(screen.queryByText('Olá, quanto custa um hemograma?')).not.toBeInTheDocument();
  });

  it('mostra o estado vazio da timeline sem inventar linhas', async () => {
    timelineMock.mockResolvedValue({
      entries: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });

    renderPage();

    expect(await screen.findByText('Nenhuma interação registrada')).toBeInTheDocument();
  });

  /* ── Bloco 3: propostas ─────────────────────────────────────────────── */

  it('abre o Modal da Proposta pelo cartão do orçamento', async () => {
    const user = userEvent.setup();
    renderPage();

    const section = within(await screen.findByLabelText('Orçamentos do paciente'));
    await user.click(await section.findByRole('button', { name: /João Santos/ }));

    expect(useUIStore.getState().activeModal).toEqual({
      kind: 'proposal',
      id: '6d9a4c2b-71e5-4f18-8b0a-3c5d2e9f1a44',
    });
  });

  /* ── Bloco 4: LGPD ──────────────────────────────────────────────────── */

  it('esconde a seção LGPD de quem não é admin E não dispara requisição', async () => {
    signIn('manager');
    renderPage();

    await screen.findByRole('heading', { name: 'João Santos' });

    expect(screen.queryByText('Dados pessoais (LGPD)')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Exportar dados do paciente' }),
    ).not.toBeInTheDocument();
    expect(exportMock).not.toHaveBeenCalled();
    expect(anonymizeMock).not.toHaveBeenCalled();
  });

  it('mostra a seção LGPD para admin', async () => {
    signIn('admin');
    renderPage();

    expect(await screen.findByText('Dados pessoais (LGPD)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exportar dados do paciente' })).toBeInTheDocument();
  });

  it('exporta os dados do titular só quando o admin pede', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;

    signIn('admin');
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Exportar dados do paciente' }));

    await waitFor(() => expect(exportMock).toHaveBeenCalledWith(PATIENT_ID));
    expect(createObjectURL).toHaveBeenCalled();
  });

  it('exige motivo E aceite explícito antes de anonimizar', async () => {
    const user = userEvent.setup();
    anonymizeMock.mockResolvedValue({
      patient: {
        ...exportResponse.patient,
        phone: 'anon-3f1c9b0e',
        name: null,
        email: null,
        birthDate: null,
        document: null,
        notes: null,
        tags: [],
        customFields: {},
        anonymizedAt: '2026-08-24T12:05:00.000Z',
      },
      conversationsAffected: 4,
    });

    signIn('admin');
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Anonimizar cadastro' }));

    const dialog = within(screen.getByRole('dialog'));
    const confirm = dialog.getByRole('button', { name: 'Confirmar anonimização' });

    // Sem motivo e sem aceite: o confirmar não existe como caminho.
    expect(confirm).toBeDisabled();

    await user.type(dialog.getByLabelText(/Motivo do pedido do titular/), 'Pedido por e-mail');
    expect(confirm).toBeDisabled(); // motivo sozinho não basta

    await user.click(dialog.getByRole('checkbox'));
    expect(confirm).toBeEnabled();

    await user.click(confirm);

    await waitFor(() =>
      expect(anonymizeMock).toHaveBeenCalledWith(PATIENT_ID, { reason: 'Pedido por e-mail' }),
    );
    expect(await screen.findByText(/4 conversa\(s\) atualizada\(s\)/)).toBeInTheDocument();
  });

  it('escreve na tela a consequência irreversível antes de confirmar', async () => {
    const user = userEvent.setup();
    signIn('admin');
    renderPage();

    expect(await screen.findByText(/Depois disso o cadastro não pode mais ser editado/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Anonimizar cadastro' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('irreversível')).toBeInTheDocument();
  });

  it('não dispara a anonimização se o admin cancelar', async () => {
    const user = userEvent.setup();
    signIn('admin');
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Anonimizar cadastro' }));
    const dialog = within(screen.getByRole('dialog'));
    await user.click(dialog.getByRole('button', { name: 'Cancelar' }));

    expect(anonymizeMock).not.toHaveBeenCalled();
  });
});
