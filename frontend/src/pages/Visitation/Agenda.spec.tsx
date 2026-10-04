import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doctor, ListVisitsResponse, VisitDetail } from '@crm-lab/shared';
import { conversationsApi } from '@/api/conversations';
import { doctorsApi } from '@/api/doctors';
import { visitsApi } from '@/api/visits';
import { ToastProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth.store';
import Agenda from './Agenda';

/**
 * Agenda de visitas — `/visitation/agenda` (CRMLAB-87, D-256). A API é mockada
 * no nível de `visitsApi`, então o período e os filtros que a tela monta são os
 * que chegariam ao `GET /visits`. Datas montadas no fuso local (a tela usa o
 * do navegador), para o teste não depender do TZ da máquina.
 */
vi.mock('@/api/visits', () => ({
  visitsApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    reschedule: vi.fn(),
    cancel: vi.fn(),
    notReceived: vi.fn(),
  },
}));

vi.mock('@/api/doctors', () => ({
  doctorsApi: { list: vi.fn() },
}));

vi.mock('@/api/conversations', () => ({
  conversationsApi: { assignees: vi.fn() },
}));

const listMock = vi.mocked(visitsApi.list);
const getMock = vi.mocked(visitsApi.get);
const createMock = vi.mocked(visitsApi.create);
const cancelMock = vi.mocked(visitsApi.cancel);
const rescheduleMock = vi.mocked(visitsApi.reschedule);

/** Quarta, 07/10/2026 10:00 local. A semana vai de seg 05/10 a dom 11/10. */
const NOW = new Date(2026, 9, 7, 10, 0);
const MONDAY = new Date(2026, 9, 5);
const NEXT_MONDAY = new Date(2026, 9, 12);

const julia: Doctor = {
  id: 'doc-1',
  name: 'Dra. Júlia Costa',
  crm: '12345',
  crmUf: 'SC',
  specialty: 'Ginecologia',
  clinic: null,
  address: null,
  phone: null,
  email: null,
  contactName: null,
  visitPreference: null,
  notes: null,
  responsible: null,
  isActive: true,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
};

function visit(overrides: Partial<VisitDetail> = {}): VisitDetail {
  return {
    id: 'v-1',
    doctor: { id: 'doc-1', name: 'Dra. Júlia Costa', crm: '12345', crmUf: 'SC', specialty: 'Ginecologia', clinic: null, isActive: true },
    responsible: { id: 'u-bia', name: 'Bia Atendente' },
    scheduledAt: new Date(2026, 9, 6, 9, 30).toISOString(),
    type: 'presencial',
    agenda: 'Apresentar o painel de check-up',
    status: 'agendada',
    statusReason: null,
    statusChangedAt: null,
    statusChangedBy: null,
    rescheduleCount: 0,
    createdBy: { id: 'u-bia', name: 'Bia Atendente' },
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    reschedules: [],
    checkInAt: null,
    checkInBy: null,
    checkOutAt: null,
    checkOutBy: null,
    nextVisitDate: null,
    attachmentCount: 0,
    report: { presented: null, doctorFeedback: null, objections: null },
    attachments: [],
    ...overrides,
  };
}

function listResponse(visits: VisitDetail[] = [visit()]): ListVisitsResponse {
  return { visits, truncated: false };
}

function renderPage(path = '/visitation/agenda') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Agenda />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('Agenda (/visitation/agenda)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    mockMatchMedia(false);
    listMock.mockResolvedValue(listResponse());
    getMock.mockResolvedValue(visit());
    vi.mocked(doctorsApi.list).mockResolvedValue({
      doctors: [julia],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });
    vi.mocked(conversationsApi.assignees).mockResolvedValue({
      assignees: [
        { id: 'u-ana', name: 'Ana Gestora', role: 'manager' },
        { id: 'u-bia', name: 'Bia Atendente', role: 'attendant' },
      ],
    });
    useAuthStore.setState({
      user: { id: 'u-bia', email: 'bia@lab.test', name: 'Bia Atendente', role: 'attendant', discountLimit: 5 },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('abre na semana atual (segunda a segunda) com a visita na grade', async () => {
    renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(listMock).toHaveBeenLastCalledWith({ from: MONDAY.toISOString(), to: NEXT_MONDAY.toISOString() });

    const week = within(await screen.findByTestId('agenda-week'));
    expect(await week.findByRole('button', { name: /09:30 Dra\. Júlia Costa — Agendada/ })).toBeInTheDocument();
    expect(screen.getByTestId('week-label')).toHaveTextContent(/05 – 11 de out/);
  });

  it('anterior, próxima e hoje mudam o período do GET /visits', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: 'Próxima ›' }));
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({
        from: NEXT_MONDAY.toISOString(),
        to: new Date(2026, 9, 19).toISOString(),
      }),
    );
    await user.click(screen.getByRole('button', { name: '‹ Anterior' }));
    await user.click(screen.getByRole('button', { name: '‹ Anterior' }));
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({
        from: new Date(2026, 8, 28).toISOString(),
        to: MONDAY.toISOString(),
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Hoje' }));
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({ from: MONDAY.toISOString(), to: NEXT_MONDAY.toISOString() }),
    );
  });

  it('filtros de responsável, médico e status chegam ao GET /visits', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Ana Gestora' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByRole('option', { name: 'Dra. Júlia Costa' }).length).toBeGreaterThan(0));

    await user.selectOptions(screen.getByRole('combobox', { name: 'Filtrar por responsável' }), 'u-ana');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filtrar por médico' }), 'doc-1');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filtrar por status' }), 'cancelada');
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({
        from: MONDAY.toISOString(),
        to: NEXT_MONDAY.toISOString(),
        responsibleId: 'u-ana',
        doctorId: 'doc-1',
        status: 'cancelada',
      }),
    );
  });

  it('no celular a lista é a visão padrão, agrupada por dia', async () => {
    mockMatchMedia(true);
    renderPage();
    const list = within(await screen.findByTestId('agenda-list'));
    expect(list.getByText(/terça-feira, 06 de outubro/i)).toBeInTheDocument();
    expect(list.getByText('Dra. Júlia Costa')).toBeInTheDocument();
    expect(list.getByText(/Presencial · Bia Atendente/)).toBeInTheDocument();
    expect(screen.queryByTestId('agenda-week')).not.toBeInTheDocument();
  });

  it('clicar no horário da grade abre "Nova visita" naquele horário e agenda com o usuário como responsável', async () => {
    const user = userEvent.setup({ delay: null });
    createMock.mockResolvedValue(visit());
    renderPage();
    await screen.findByTestId('agenda-week');

    await user.click(screen.getByRole('button', { name: 'Agendar visita em qui 08 de out. às 14:00' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Nova visita' }));
    expect(dialog.getByLabelText('Data')).toHaveValue('2026-10-08');
    expect(dialog.getByLabelText('Hora')).toHaveValue('14:00');

    // Sem médico -> erro local, nada vai ao servidor.
    await user.click(dialog.getByRole('button', { name: 'Agendar' }));
    expect(await dialog.findByText('Escolha o médico')).toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();

    await user.selectOptions(dialog.getByLabelText('Médico'), 'doc-1');
    await user.selectOptions(dialog.getByLabelText('Tipo'), 'telefone');
    await user.type(dialog.getByLabelText('Objetivo/pauta'), 'Retorno do kit');
    await user.click(dialog.getByRole('button', { name: 'Agendar' }));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        doctorId: 'doc-1',
        responsibleId: 'u-bia',
        scheduledAt: new Date(2026, 9, 8, 14, 0).toISOString(),
        type: 'telefone',
        agenda: 'Retorno do kit',
      }),
    );
  });

  it('abrir a visita mostra o histórico de datas; reagendar manda a nova data', async () => {
    const user = userEvent.setup({ delay: null });
    getMock.mockResolvedValue(
      visit({
        rescheduleCount: 1,
        reschedules: [
          {
            id: 'r-1',
            previousScheduledAt: new Date(2026, 9, 5, 9, 30).toISOString(),
            newScheduledAt: new Date(2026, 9, 6, 9, 30).toISOString(),
            reason: 'Médico pediu',
            changedBy: { id: 'u-ana', name: 'Ana Gestora' },
            changedAt: '2026-10-04T12:00:00.000Z',
          },
        ],
      }),
    );
    rescheduleMock.mockResolvedValue(visit());
    renderPage();

    await user.click(await screen.findByRole('button', { name: /09:30 Dra\. Júlia Costa/ }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Visita' }));
    expect(await dialog.findByTestId('visit-reschedules')).toHaveTextContent(/Ana Gestora.*Médico pediu/);

    await user.click(dialog.getByRole('button', { name: 'Reagendar' }));
    const form = within(await screen.findByRole('dialog', { name: 'Reagendar visita' }));
    await user.clear(form.getByLabelText('Nova data'));
    await user.type(form.getByLabelText('Nova data'), '2026-10-09');
    await user.click(form.getByRole('button', { name: 'Confirmar' }));

    await waitFor(() =>
      expect(rescheduleMock).toHaveBeenCalledWith('v-1', {
        scheduledAt: new Date(2026, 9, 9, 9, 30).toISOString(),
        reason: null,
      }),
    );
  });

  it('cancelar exige motivo antes de chamar a API', async () => {
    const user = userEvent.setup({ delay: null });
    cancelMock.mockResolvedValue(visit({ status: 'cancelada', statusReason: 'Férias' }));
    renderPage();

    await user.click(await screen.findByRole('button', { name: /09:30 Dra\. Júlia Costa/ }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Visita' }));
    await user.click(await dialog.findByRole('button', { name: 'Cancelar visita' }));

    const form = within(await screen.findByRole('dialog', { name: 'Cancelar visita' }));
    await user.click(form.getByRole('button', { name: 'Confirmar' }));
    expect(await form.findByText('Informe o motivo')).toBeInTheDocument();
    expect(cancelMock).not.toHaveBeenCalled();

    await user.type(form.getByLabelText('Motivo'), 'Férias');
    await user.click(form.getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(cancelMock).toHaveBeenCalledWith('v-1', { reason: 'Férias' }));
  });

  it('visita encerrada abre só para leitura, com o motivo', async () => {
    const user = userEvent.setup({ delay: null });
    const closed = visit({
      status: 'nao_recebeu',
      statusReason: 'Consultório fechado',
      statusChangedAt: '2026-10-06T13:00:00.000Z',
      statusChangedBy: { id: 'u-ana', name: 'Ana Gestora' },
    });
    listMock.mockResolvedValue(listResponse([closed]));
    getMock.mockResolvedValue(closed);
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Médico não recebeu/ }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Visita' }));
    expect(await dialog.findByText(/Consultório fechado — Ana Gestora/)).toBeInTheDocument();
    expect(dialog.queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument();
    expect(dialog.queryByRole('button', { name: 'Reagendar' })).not.toBeInTheDocument();
    expect(dialog.queryByRole('button', { name: 'Cancelar visita' })).not.toBeInTheDocument();
  });

  it('?visit=<id> (o "Abrir visita" da ficha do médico) abre a visita direto', async () => {
    getMock.mockResolvedValue(visit({ id: 'v-9' }));
    renderPage('/visitation/agenda?visit=v-9');

    const dialog = within(await screen.findByRole('dialog', { name: 'Visita' }));
    expect(await dialog.findByText('Apresentar o painel de check-up')).toBeInTheDocument();
    expect(getMock).toHaveBeenCalledWith('v-9');
  });
});
