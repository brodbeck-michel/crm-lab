import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Doctor,
  DoctorInteraction,
  DoctorTimelineInteraction,
  DoctorTimelineResponse,
  DoctorTimelineVisit,
} from '@crm-lab/shared';
import { ApiError } from '@/api/client';
import { conversationsApi } from '@/api/conversations';
import { doctorsApi } from '@/api/doctors';
import { ToastProvider } from '@/components/ui';
import DoctorProfile from './DoctorProfile';

/**
 * Ficha do médico — `/visitation/doctors/:id` (CRMLAB-89, D-261). A API é
 * mockada no nível de `doctorsApi`, então o que a tela manda é o que chegaria
 * ao backend.
 */
vi.mock('@/api/doctors', () => ({
  doctorsApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    inactivate: vi.fn(),
    reactivate: vi.fn(),
    timeline: vi.fn(),
    createInteraction: vi.fn(),
    updateInteraction: vi.fn(),
    deleteInteraction: vi.fn(),
  },
}));

vi.mock('@/api/conversations', () => ({
  conversationsApi: { assignees: vi.fn() },
}));

const getMock = vi.mocked(doctorsApi.get);
const timelineMock = vi.mocked(doctorsApi.timeline);
const createInteractionMock = vi.mocked(doctorsApi.createInteraction);
const updateInteractionMock = vi.mocked(doctorsApi.updateInteraction);
const deleteInteractionMock = vi.mocked(doctorsApi.deleteInteraction);
const assigneesMock = vi.mocked(conversationsApi.assignees);

const julia: Doctor = {
  id: 'doc-1',
  name: 'Dra. Júlia Costa',
  crm: '12345',
  crmUf: 'SC',
  specialty: 'Ginecologia',
  clinic: 'Clínica Vida',
  address: 'Rua das Flores, 10',
  phone: '(48) 99999-0000',
  email: 'julia@clinica.com',
  contactName: 'Marta',
  visitPreference: 'Terças à tarde',
  notes: 'Prefere material impresso',
  responsible: { id: 'u-ana', name: 'Ana Gestora' },
  isActive: true,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
};

const visita: DoctorTimelineVisit = {
  kind: 'visit',
  id: 'visit-1',
  occurredAt: '2026-09-10T13:20:00.000Z',
  status: 'realizada',
  type: 'presencial',
  scheduledAt: '2026-09-10T13:00:00.000Z',
  checkInAt: '2026-09-10T13:20:00.000Z',
  checkOutAt: '2026-09-10T13:55:00.000Z',
  responsible: { id: 'u-bia', name: 'Bia Atendente' },
  statusReason: null,
  reportExcerpt: 'Apresentei o painel de tireoide',
  attachmentCount: 2,
};

const ligacao: DoctorTimelineInteraction = {
  kind: 'interaction',
  id: 'int-1',
  doctorId: 'doc-1',
  type: 'ligacao',
  occurredAt: '2026-09-12T18:00:00.000Z',
  description: 'Confirmou interesse no convênio',
  createdBy: { id: 'u-bia', name: 'Bia Atendente' },
  updatedBy: null,
  createdAt: '2026-09-12T18:05:00.000Z',
  updatedAt: '2026-09-12T18:05:00.000Z',
};

function page(items: DoctorTimelineResponse['items'], nextCursor: string | null = null): DoctorTimelineResponse {
  return { items, nextCursor };
}

function renderPage(path = '/visitation/doctors/doc-1') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/visitation/doctors/:id" element={<DoctorProfile />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function timeline() {
  return within(screen.getByTestId('doctor-timeline'));
}

describe('DoctorProfile (/visitation/doctors/:id)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMock.mockResolvedValue(julia);
    timelineMock.mockResolvedValue(page([ligacao, visita]));
    assigneesMock.mockResolvedValue({ assignees: [{ id: 'u-ana', name: 'Ana Gestora', role: 'manager' }] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mostra os dados do cadastro', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Dra. Júlia Costa' })).toBeInTheDocument();
    expect(screen.getByText('CRM 12345/SC · Ginecologia')).toBeInTheDocument();
    expect(screen.getByText('Clínica Vida')).toBeInTheDocument();
    expect(screen.getByText('Terças à tarde')).toBeInTheDocument();
    expect(screen.getByText('Ana Gestora')).toBeInTheDocument();
    expect(screen.getByText('Prefere material impresso')).toBeInTheDocument();
    expect(getMock).toHaveBeenCalledWith('doc-1');
  });

  it('linha do tempo com visita e registro manual, na ordem do servidor', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('doctor-timeline')).toBeInTheDocument());
    expect(timelineMock).toHaveBeenCalledWith('doc-1', { limit: 20 });

    const itens = timeline().getAllByRole('listitem');
    expect(itens).toHaveLength(2);
    expect(within(itens[0] as HTMLElement).getByText('Ligação')).toBeInTheDocument();
    expect(within(itens[0] as HTMLElement).getByText('Confirmou interesse no convênio')).toBeInTheDocument();
    expect(within(itens[0] as HTMLElement).getByText('Registrado por Bia Atendente')).toBeInTheDocument();

    const visitaItem = within(itens[1] as HTMLElement);
    expect(visitaItem.getByText('Visita')).toBeInTheDocument();
    expect(visitaItem.getByText('Realizada')).toBeInTheDocument();
    expect(visitaItem.getByText('Presencial · com Bia Atendente · 35 min · 2 anexos')).toBeInTheDocument();
    expect(visitaItem.getByText('Apresentei o painel de tireoide')).toBeInTheDocument();
    expect(visitaItem.getByRole('link', { name: 'Abrir visita' })).toHaveAttribute(
      'href',
      '/visitation/agenda?visit=visit-1',
    );
  });

  it('"Carregar mais" pede a próxima página pelo cursor e acumula', async () => {
    const outra: DoctorTimelineInteraction = { ...ligacao, id: 'int-2', type: 'email', description: 'Mandou o folder' };
    timelineMock
      .mockResolvedValueOnce(page([ligacao], 'cursor-1'))
      .mockResolvedValueOnce(page([outra]));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Carregar mais' }));

    await waitFor(() => expect(timeline().getAllByRole('listitem')).toHaveLength(2));
    expect(timelineMock).toHaveBeenLastCalledWith('doc-1', { limit: 20, cursor: 'cursor-1' });
    expect(timeline().getByText('Mandou o folder')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).not.toBeInTheDocument();
  });

  it('sem nada: estado vazio explica de onde vêm os itens', async () => {
    timelineMock.mockResolvedValue(page([]));
    renderPage();
    expect(await screen.findByText('Nenhuma interação ainda')).toBeInTheDocument();
  });

  it('registra interação: tipo, data/hora local em ISO e descrição sem espaço', async () => {
    const created: DoctorInteraction = { ...ligacao, id: 'int-9', type: 'whatsapp' };
    createInteractionMock.mockResolvedValue(created);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '+ Registrar interação' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.selectOptions(dialog.getByLabelText('Tipo'), 'whatsapp');
    await user.clear(dialog.getByLabelText('Data'));
    await user.type(dialog.getByLabelText('Data'), '2026-10-02');
    await user.clear(dialog.getByLabelText('Hora'));
    await user.type(dialog.getByLabelText('Hora'), '14:30');
    await user.type(dialog.getByLabelText('Descrição'), '  Mandou a tabela de exames  ');
    await user.click(dialog.getByRole('button', { name: 'Registrar' }));

    await waitFor(() => expect(createInteractionMock).toHaveBeenCalledTimes(1));
    expect(createInteractionMock).toHaveBeenCalledWith('doc-1', {
      type: 'whatsapp',
      occurredAt: new Date('2026-10-02T14:30:00').toISOString(),
      description: 'Mandou a tabela de exames',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('descrição vazia não sai da tela', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '+ Registrar interação' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.click(dialog.getByRole('button', { name: 'Registrar' }));

    expect(await dialog.findByText('Descreva a interação')).toBeInTheDocument();
    expect(createInteractionMock).not.toHaveBeenCalled();
  });

  it('erro de campo do servidor aparece no campo (data no futuro)', async () => {
    createInteractionMock.mockRejectedValue(
      new ApiError('VALIDATION_ERROR', 'Dados inválidos', 400, {
        fields: { occurredAt: 'A data não pode ser no futuro' },
      }),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '+ Registrar interação' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Descrição'), 'Ligação');
    await user.click(dialog.getByRole('button', { name: 'Registrar' }));

    expect(await dialog.findByText('A data não pode ser no futuro')).toBeInTheDocument();
  });

  it('edita um registro já preenchido', async () => {
    updateInteractionMock.mockResolvedValue({ ...ligacao, description: 'Texto novo' });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Editar registro de Ligação' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Editar registro' }));
    expect(dialog.getByLabelText('Descrição')).toHaveValue('Confirmou interesse no convênio');
    await user.clear(dialog.getByLabelText('Descrição'));
    await user.type(dialog.getByLabelText('Descrição'), 'Texto novo');
    await user.click(dialog.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(updateInteractionMock).toHaveBeenCalledTimes(1));
    expect(updateInteractionMock).toHaveBeenCalledWith('doc-1', 'int-1', {
      type: 'ligacao',
      occurredAt: '2026-09-12T18:00:00.000Z',
      description: 'Texto novo',
    });
  });

  it('exclui só depois de confirmar', async () => {
    deleteInteractionMock.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const user = userEvent.setup();
    renderPage();

    const excluir = await screen.findByRole('button', { name: 'Excluir registro de Ligação' });
    await user.click(excluir);
    expect(deleteInteractionMock).not.toHaveBeenCalled();

    await user.click(excluir);
    await waitFor(() => expect(deleteInteractionMock).toHaveBeenCalledWith('doc-1', 'int-1'));
    expect(confirmSpy).toHaveBeenCalledTimes(2);
  });

  it('médico de outro laboratório: "não encontrado", sem linha do tempo', async () => {
    getMock.mockRejectedValue(new ApiError('NOT_FOUND', 'Não encontrado', 404));
    renderPage();

    expect(await screen.findByText('Médico não encontrado')).toBeInTheDocument();
    expect(timelineMock).not.toHaveBeenCalled();
  });
});
