import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doctor, ListVisitsResponse, VisitDetail, VisitPurpose } from '@crm-lab/shared';
import { conversationsApi } from '@/api/conversations';
import { doctorsApi } from '@/api/doctors';
import { visitPurposesApi } from '@/api/visit-purposes';
import { visitsApi } from '@/api/visits';
import { ToastProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth.store';
import Agenda from './Agenda';
import { buildDoctor } from '@/test/doctor-fixtures';

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

const julia: Doctor = buildDoctor({
  id: 'doc-1',
  name: 'Dra. Júlia Costa',
  crm: '12345',
  crmUf: 'SC',
  specialty: 'Ginecologia',
  clinic: null,
  address: null,
  phone: null,
  email: null,
  secretaryName: null,
  contactName: null,
  visitPreference: null,
  notes: null,
  responsible: null,
  isActive: true,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
});

function visit(overrides: Partial<VisitDetail> = {}): VisitDetail {
  return {
    id: 'v-1',
    doctor: {
      id: 'doc-1',
      name: 'Dra. Júlia Costa',
      crm: '12345',
      crmUf: 'SC',
      specialty: 'Ginecologia',
      clinic: null,
      isActive: true,
    },
    responsible: { id: 'u-bia', name: 'Bia Atendente' },
    scheduledAt: new Date(2026, 9, 6, 9, 30).toISOString(),
    type: 'presencial',
    purpose: { id: 'p-visita', name: 'Visita', color: 'azul' },
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

/** Cadastro de finalidades (CRMLAB-190): duas ativas e uma inativa. */
function purpose(overrides: Partial<VisitPurpose> & Pick<VisitPurpose, 'id' | 'name' | 'color'>): VisitPurpose {
  return {
    isActive: true,
    sortOrder: 0,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

const PURPOSES: VisitPurpose[] = [
  purpose({ id: 'p-visita', name: 'Visita', color: 'azul', sortOrder: 1 }),
  purpose({ id: 'p-patrocinio', name: 'Solicitação de patrocínio', color: 'verde', sortOrder: 2 }),
  purpose({ id: 'p-antiga', name: 'Finalidade antiga', color: 'rosa', sortOrder: 3, isActive: false }),
];

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

/** Largura da tela: as media queries da página (`max-width`/`min-width`) respondem a ela. */
function mockViewport(width: number) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const max = /max-width:\s*(\d+)px/.exec(query);
      const min = /min-width:\s*(\d+)px/.exec(query);
      return {
        matches: (!max || width <= Number(max[1])) && (!min || width >= Number(min[1])),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
}

describe('Agenda (/visitation/agenda)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    // Tablet/notebook: grade sem a coluna de resumo — clicar abre o modal.
    mockViewport(1024);
    listMock.mockResolvedValue(listResponse());
    getMock.mockResolvedValue(visit());
    vi.spyOn(visitPurposesApi, 'list').mockResolvedValue({ purposes: PURPOSES });
    vi.mocked(doctorsApi.list).mockResolvedValue({
      doctors: [julia],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });
    vi.mocked(conversationsApi.assignees).mockResolvedValue({
      assignees: [
        { id: 'u-ana', name: 'Ana Gestora', role: 'manager' },
        { id: 'u-bia', name: 'Bia Atendente', role: 'representative' },
      ],
    });
    // Gestor vê a Visitação inteira e o filtro por responsável (D-329).
    useAuthStore.setState({
      user: { id: 'u-ana', email: 'ana@lab.test', name: 'Ana Gestora', role: 'manager', discountLimit: 30 },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('abre na semana atual (segunda a segunda) com a visita na grade', async () => {
    renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(listMock).toHaveBeenLastCalledWith({
      from: MONDAY.toISOString(),
      to: NEXT_MONDAY.toISOString(),
    });

    const week = within(await screen.findByTestId('agenda-week'));
    expect(
      await week.findByRole('button', { name: /09:30 Dra\. Júlia Costa — Agendada/ }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('week-label')).toHaveTextContent(/05 – 11 de out/);
  });

  it('anterior, próxima e hoje mudam o período do GET /visits', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: 'Próxima semana' }));
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({
        from: NEXT_MONDAY.toISOString(),
        to: new Date(2026, 9, 19).toISOString(),
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Semana anterior' }));
    await user.click(screen.getByRole('button', { name: 'Semana anterior' }));
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({
        from: new Date(2026, 8, 28).toISOString(),
        to: MONDAY.toISOString(),
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Hoje' }));
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({
        from: MONDAY.toISOString(),
        to: NEXT_MONDAY.toISOString(),
      }),
    );
  });

  it('filtros valem na tela (a semana vem inteira) e os chips contam a semana toda', async () => {
    const user = userEvent.setup({ delay: null });
    const paulo = visit({
      id: 'v-2',
      doctor: {
        id: 'doc-2',
        name: 'Dr. Paulo Lima',
        crm: null,
        crmUf: null,
        specialty: null,
        clinic: null,
        isActive: true,
      },
      responsible: { id: 'u-ana', name: 'Ana Gestora' },
      scheduledAt: new Date(2026, 9, 8, 15, 0).toISOString(),
      status: 'cancelada',
      statusReason: 'Férias',
    });
    listMock.mockResolvedValue(listResponse([visit(), paulo]));
    renderPage();
    const week = within(await screen.findByTestId('agenda-week'));
    await week.findByRole('button', { name: /Dr\. Paulo Lima — Cancelada/ });

    const filters = within(screen.getByTestId('agenda-filters'));
    expect(filters.getByRole('button', { name: /^Agendada\s*1$/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(filters.getByRole('button', { name: /^Cancelada\s*1$/ }));
    expect(week.queryByRole('button', { name: /Dr\. Paulo Lima/ })).not.toBeInTheDocument();
    expect(filters.getByRole('button', { name: /^Cancelada\s*1$/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    await user.click(filters.getByRole('button', { name: /^Cancelada\s*1$/ }));
    await user.click(await filters.findByRole('button', { name: 'Bia' }));
    expect(week.queryByRole('button', { name: /Dr\. Paulo Lima/ })).not.toBeInTheDocument();
    expect(week.getByRole('button', { name: /Dra\. Júlia Costa/ })).toBeInTheDocument();

    await user.click(filters.getByRole('button', { name: 'Bia' }));
    await waitFor(() =>
      expect(screen.getAllByRole('option', { name: 'Dra. Júlia Costa' }).length).toBeGreaterThan(0),
    );
    await user.selectOptions(
      filters.getByRole('combobox', { name: 'Filtrar por médico' }),
      'doc-1',
    );
    expect(week.queryByRole('button', { name: /Dr\. Paulo Lima/ })).not.toBeInTheDocument();

    // Nenhum filtro vai ao servidor: a semana é buscada inteira.
    expect(listMock).toHaveBeenLastCalledWith({
      from: MONDAY.toISOString(),
      to: NEXT_MONDAY.toISOString(),
    });
  });

  it('no celular a tela mostra um dia por vez, começando por hoje', async () => {
    const user = userEvent.setup({ delay: null });
    mockViewport(390);
    renderPage();
    await screen.findByTestId('agenda-mobile');
    expect(screen.queryByTestId('agenda-week')).not.toBeInTheDocument();
    expect(await screen.findByText('Nenhuma visita neste dia.')).toBeInTheDocument();

    await user.click(await screen.findByRole('tab', { name: /Terça, 06 de out\., com visitas/ }));
    const day = within(await screen.findByTestId('agenda-day-list'));
    expect(day.getByText('Dra. Júlia Costa')).toBeInTheDocument();
    expect(day.getByText('Ginecologia · Presencial')).toBeInTheDocument();
    expect(day.getByText('Bia Atendente')).toBeInTheDocument();
  });

  it('clicar no horário da grade abre "Nova visita" naquele horário e agenda com o usuário como responsável', async () => {
    const user = userEvent.setup({ delay: null });
    createMock.mockResolvedValue(visit());
    renderPage();
    await screen.findByTestId('agenda-week');

    await user.click(
      screen.getByRole('button', { name: 'Agendar visita em Quinta, 08 de out. às 14:00' }),
    );
    const dialog = within(await screen.findByRole('dialog', { name: 'Nova visita' }));
    expect(dialog.getByLabelText('Data')).toHaveValue('2026-10-08');
    expect(dialog.getByLabelText('Hora')).toHaveValue('14:00');

    // Sem médico -> erro local, nada vai ao servidor.
    await user.click(dialog.getByRole('button', { name: 'Agendar' }));
    expect(await dialog.findByText('Escolha o médico')).toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();

    expect(await dialog.findByText('Escolha a finalidade')).toBeInTheDocument();

    await user.selectOptions(dialog.getByLabelText('Médico'), 'doc-1');
    // Finalidade obrigatória (CRMLAB-190): só as ativas são oferecidas.
    const purposeSelect = dialog.getByLabelText('Finalidade');
    await waitFor(() =>
      expect(within(purposeSelect).getByRole('option', { name: 'Solicitação de patrocínio' })).toBeInTheDocument(),
    );
    expect(within(purposeSelect).queryByRole('option', { name: /Finalidade antiga/ })).not.toBeInTheDocument();
    await user.selectOptions(purposeSelect, 'p-patrocinio');
    await user.selectOptions(dialog.getByLabelText('Tipo'), 'telefone');
    await user.type(dialog.getByLabelText('Objetivo/pauta'), 'Retorno do kit');
    await user.click(dialog.getByRole('button', { name: 'Agendar' }));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        doctorId: 'doc-1',
        responsibleId: 'u-ana',
        scheduledAt: new Date(2026, 9, 8, 14, 0).toISOString(),
        type: 'telefone',
        purposeId: 'p-patrocinio',
        agenda: 'Retorno do kit',
      }),
    );
  });

  it('bloco na cor da finalidade, com o nome dela e o status em ícone (CRMLAB-190)', async () => {
    const patrocinio = visit({
      id: 'v-2',
      scheduledAt: new Date(2026, 9, 8, 15, 0).toISOString(),
      purpose: { id: 'p-patrocinio', name: 'Solicitação de patrocínio', color: 'verde' },
      status: 'realizada',
    });
    const cancelada = visit({
      id: 'v-3',
      scheduledAt: new Date(2026, 9, 9, 11, 0).toISOString(),
      status: 'cancelada',
      statusReason: 'Férias',
    });
    listMock.mockResolvedValue(listResponse([visit(), patrocinio, cancelada]));
    renderPage();
    const week = within(await screen.findByTestId('agenda-week'));

    const first = await week.findByRole('button', { name: /09:30 Dra\. Júlia Costa — Agendada · Visita/ });
    expect(first).toHaveAttribute('data-purpose-color', 'azul');
    expect(first.className).toContain('bg-purpose-azul-bg');
    expect(within(first).getByText('Visita')).toBeInTheDocument();
    expect(within(first).getByTestId('visit-status-icon')).toHaveAttribute('data-status', 'agendada');

    const second = week.getByRole('button', { name: /15:00 Dra\. Júlia Costa — Realizada · Solicitação de patrocínio/ });
    expect(second).toHaveAttribute('data-purpose-color', 'verde');
    expect(second.className).toContain('bg-purpose-verde-bg');
    expect(within(second).getByTestId('visit-status-icon')).toHaveAttribute('data-status', 'realizada');
    expect(within(second).getByText('Realizada')).toHaveClass('sr-only');

    const third = week.getByRole('button', { name: /11:00 Dra\. Júlia Costa — Cancelada/ });
    expect(third.className).toContain('opacity-60');
    expect(within(third).getByText('Dra. Júlia Costa')).toHaveClass('line-through');
  });

  it('chips de finalidade filtram na tela e contam a semana; a inativa só aparece se tiver visita', async () => {
    const user = userEvent.setup({ delay: null });
    const patrocinio = visit({
      id: 'v-2',
      scheduledAt: new Date(2026, 9, 8, 15, 0).toISOString(),
      purpose: { id: 'p-patrocinio', name: 'Solicitação de patrocínio', color: 'verde' },
    });
    listMock.mockResolvedValue(listResponse([visit(), patrocinio]));
    renderPage();
    const week = within(await screen.findByTestId('agenda-week'));
    await week.findByRole('button', { name: /15:00 .* Solicitação de patrocínio/ });

    const filters = within(screen.getByTestId('agenda-filters'));
    const group = within(await filters.findByRole('group', { name: 'Finalidade' }));
    const chip = group.getByRole('button', { name: /^Solicitação de patrocínio\s*1$/ });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(group.getByRole('button', { name: /^Visita\s*1$/ })).toBeInTheDocument();
    expect(group.queryByRole('button', { name: /Finalidade antiga/ })).not.toBeInTheDocument();

    await user.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(week.queryByRole('button', { name: /Solicitação de patrocínio/ })).not.toBeInTheDocument();
    expect(week.getByRole('button', { name: /09:30 .* Visita/ })).toBeInTheDocument();

    await user.click(chip);
    expect(week.getByRole('button', { name: /Solicitação de patrocínio/ })).toBeInTheDocument();
    // O filtro é local: a semana continua vindo inteira.
    expect(listMock).toHaveBeenLastCalledWith({
      from: MONDAY.toISOString(),
      to: NEXT_MONDAY.toISOString(),
    });
  });

  it('visita com finalidade inativa: chip aparece e a edição a mantém como "(inativa)"', async () => {
    const user = userEvent.setup({ delay: null });
    const antiga = visit({ purpose: { id: 'p-antiga', name: 'Finalidade antiga', color: 'rosa' } });
    listMock.mockResolvedValue(listResponse([antiga]));
    getMock.mockResolvedValue(antiga);
    renderPage();
    const filters = within(await screen.findByTestId('agenda-filters'));
    expect(
      await filters.findByRole('button', { name: /^Finalidade antiga\s*1$/ }),
    ).toBeInTheDocument();

    const week = within(screen.getByTestId('agenda-week'));
    await user.click(await week.findByRole('button', { name: /Finalidade antiga/ }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Visita' }));
    expect(dialog.getByTestId('visit-purpose')).toHaveTextContent('Finalidade antiga');
    await user.click(dialog.getByRole('button', { name: 'Editar' }));
    const edit = within(await screen.findByRole('dialog', { name: 'Editar visita' }));
    expect(edit.getByLabelText('Finalidade')).toHaveValue('p-antiga');
    expect(edit.getByRole('option', { name: 'Finalidade antiga (inativa)' })).toBeInTheDocument();
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
    expect(await dialog.findByTestId('visit-reschedules')).toHaveTextContent(
      /Ana Gestora.*Médico pediu/,
    );

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

  describe('com a coluna de resumo (tela larga)', () => {
    beforeEach(() => mockViewport(1440));

    it('resumo da semana e "Hoje"; clicar abre o detalhe com as ações da visita agendada', async () => {
      const user = userEvent.setup({ delay: null });
      const today = visit({ id: 'v-2', scheduledAt: new Date(2026, 9, 7, 14, 0).toISOString() });
      listMock.mockResolvedValue(listResponse([visit(), today]));
      getMock.mockResolvedValue(today);
      cancelMock.mockResolvedValue(
        visit({ id: 'v-2', status: 'cancelada', statusReason: 'Agenda' }),
      );
      renderPage();

      const rail = within(await screen.findByTestId('agenda-rail'));
      expect(await within(rail.getByTestId('week-summary')).findByText('2')).toBeInTheDocument();
      const todayPanel = within(rail.getByTestId('today-panel'));
      await user.click(await todayPanel.findByRole('button', { name: /14:00.*Dra\. Júlia Costa/ }));

      const detail = within(await rail.findByTestId('visit-detail-panel'));
      expect(detail.getByRole('button', { name: 'Cheguei' })).toBeInTheDocument();
      expect(detail.getByRole('button', { name: 'Reagendar' })).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      await user.click(detail.getByRole('button', { name: 'Cancelar' }));
      const form = within(await screen.findByRole('dialog', { name: 'Cancelar visita' }));
      await user.type(form.getByLabelText('Motivo'), 'Agenda');
      await user.click(form.getByRole('button', { name: 'Confirmar' }));
      await waitFor(() => expect(cancelMock).toHaveBeenCalledWith('v-2', { reason: 'Agenda' }));

      await user.click(detail.getByRole('button', { name: 'Fechar detalhes' }));
      expect(await rail.findByTestId('today-panel')).toBeInTheDocument();
    });

    it('visita realizada não tem "Cheguei" nem cancelar — só o relato', async () => {
      const user = userEvent.setup({ delay: null });
      const done = visit({
        status: 'realizada',
        checkInAt: new Date(2026, 9, 6, 9, 35).toISOString(),
        checkOutAt: new Date(2026, 9, 6, 10, 20).toISOString(),
      });
      listMock.mockResolvedValue(listResponse([done]));
      getMock.mockResolvedValue(done);
      renderPage();

      await user.click(
        await screen.findByRole('button', { name: /09:30 Dra\. Júlia Costa — Realizada/ }),
      );
      const detail = within(await screen.findByTestId('visit-detail-panel'));
      expect(await detail.findByText(/Cheguei 09:35 · Saí 10:20/)).toBeInTheDocument();
      expect(detail.queryByRole('button', { name: 'Cheguei' })).not.toBeInTheDocument();
      expect(detail.queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument();
      await user.click(detail.getByRole('button', { name: 'Registrar relato' }));
      expect(await screen.findByRole('dialog', { name: 'Visita' })).toBeInTheDocument();
    });

    it('?visit=<id> seleciona a visita no painel, sem modal', async () => {
      getMock.mockResolvedValue(visit({ id: 'v-9' }));
      listMock.mockResolvedValue(listResponse([visit({ id: 'v-9' })]));
      renderPage('/visitation/agenda?visit=v-9');

      const detail = within(await screen.findByTestId('visit-detail-panel'));
      expect(detail.getByText('Dra. Júlia Costa')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('semana vazia avisa sobre a grade', async () => {
      listMock.mockResolvedValue(listResponse([]));
      renderPage();
      expect(await screen.findByText('Nenhuma visita nesta semana')).toBeInTheDocument();
      expect(
        within(screen.getByTestId('agenda-rail')).getByText('Sem visitas hoje.'),
      ).toBeInTheDocument();
    });
  });
});
