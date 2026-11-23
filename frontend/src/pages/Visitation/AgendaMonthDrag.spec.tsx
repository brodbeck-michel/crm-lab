import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doctor, ListVisitsResponse, VisitDetail, VisitPurpose } from '@crm-lab/shared';
import { conversationsApi } from '@/api/conversations';
import { doctorsApi } from '@/api/doctors';
import { visitPurposesApi } from '@/api/visit-purposes';
import { visitsApi } from '@/api/visits';
import { ApiError } from '@/api/client';
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
const rescheduleMock = vi.mocked(visitsApi.reschedule);

/** Quarta, 07/10/2026 10:00 local. */
const NOW = new Date(2026, 9, 7, 10, 0);

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
function purpose(
  overrides: Partial<VisitPurpose> & Pick<VisitPurpose, 'id' | 'name' | 'color'>,
): VisitPurpose {
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
  purpose({
    id: 'p-antiga',
    name: 'Finalidade antiga',
    color: 'rosa',
    sortOrder: 3,
    isActive: false,
  }),
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

/**
 * `DataTransfer` não existe no jsdom. O dublê reproduz o MODO PROTEGIDO do
 * navegador (no `dragover` só `types` é legível; `getData()` devolve `''`) —
 * mesma regra do teste do funil (`Proposals.spec`). `clientY` vai direto no
 * evento porque o jsdom não tem `DragEvent`.
 */
function drag(card: HTMLElement, target: HTMLElement, { grabY = 0, dropY = 0 } = {}) {
  const store = new Map<string, string>();
  let protectedMode = false;
  const dataTransfer = {
    get types() {
      return [...store.keys()];
    },
    setData: (type: string, value: string) => store.set(type.toLowerCase(), value),
    getData: (type: string) => (protectedMode ? '' : (store.get(type.toLowerCase()) ?? '')),
    effectAllowed: 'none',
    dropEffect: 'none',
  };
  const fire = (el: HTMLElement, factory: typeof createEvent.dragStart, clientY: number) => {
    const event = factory(el, { dataTransfer });
    Object.defineProperty(event, 'clientY', { value: clientY });
    fireEvent(el, event);
  };
  fire(card, createEvent.dragStart, grabY);
  protectedMode = true;
  fire(target, createEvent.dragOver, dropY);
  protectedMode = false;
  fire(target, createEvent.drop, dropY);
}

function monthDay(day: Date): HTMLElement {
  const cell = screen
    .getAllByTestId('month-day')
    .find((el) => el.getAttribute('data-day') === day.toISOString());
  if (!cell) throw new Error(`dia ${day.toISOString()} fora da grade`);
  return cell;
}

function weekColumn(day: Date): HTMLElement {
  const column = screen
    .getAllByTestId('agenda-day')
    .find((el) => el.getAttribute('data-day') === day.toISOString());
  if (!column) throw new Error(`dia ${day.toISOString()} fora da semana`);
  return column;
}

/** Outubro/2026: 1º é quinta, 31 é sábado → grade de seg 28/09 a dom 01/11 (5 semanas). */
const GRID_START = new Date(2026, 8, 28);
const GRID_END = new Date(2026, 10, 2);

describe('Agenda — visão Mês e arrastar para reagendar (CRMLAB-191, D-331)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
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
    useAuthStore.setState({
      user: {
        id: 'u-ana',
        email: 'ana@lab.test',
        name: 'Ana Gestora',
        role: 'manager',
        discountLimit: 30,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function openMonth(user: ReturnType<typeof userEvent.setup>) {
    renderPage();
    await screen.findByTestId('agenda-week');
    await user.click(screen.getByRole('tab', { name: 'Mês' }));
    return within(await screen.findByTestId('agenda-month'));
  }

  describe('visão Mês', () => {
    it('grade seg–dom com as semanas de borda numa consulta só, e o cartão no dia', async () => {
      const user = userEvent.setup({ delay: null });
      mockViewport(1440); // com a coluna de resumo
      const month = await openMonth(user);

      await waitFor(() =>
        expect(listMock).toHaveBeenLastCalledWith({
          from: GRID_START.toISOString(),
          to: GRID_END.toISOString(),
        }),
      );
      // 35 dias: cabe nos 62 do GET /visits.
      expect(month.getAllByTestId('month-day')).toHaveLength(35);
      expect(monthDay(GRID_START)).toHaveAttribute('data-in-month', 'false');
      expect(screen.getByTestId('week-label')).toHaveTextContent('outubro de 2026');

      const card = await within(monthDay(new Date(2026, 9, 6))).findByRole('button', {
        name: /09:30 Dra\. Júlia Costa — Agendada · Visita/,
      });
      expect(card).toHaveAttribute('data-purpose-color', 'azul');
      expect(within(card).getByTestId('visit-status-icon')).toHaveAttribute(
        'data-status',
        'agendada',
      );
      expect(screen.getByTestId('week-summary')).toHaveTextContent('Resumo do mês');
    });

    it('com 4+ visitas no dia mostra 2 e "+N", que leva para a Semana daquele dia', async () => {
      const user = userEvent.setup({ delay: null });
      const many = [9, 10, 11, 15].map((hour, i) =>
        visit({ id: `v-${i}`, scheduledAt: new Date(2026, 9, 22, hour, 0).toISOString() }),
      );
      listMock.mockResolvedValue(listResponse(many));
      await openMonth(user);

      const cell = within(monthDay(new Date(2026, 9, 22)));
      await cell.findByRole('button', { name: /09:00 Dra\. Júlia Costa/ });
      expect(cell.getAllByTestId('month-card')).toHaveLength(2);
      const more = cell.getByTestId('month-more');
      expect(more).toHaveTextContent('+2');

      await user.click(more);
      expect(await screen.findByTestId('agenda-week')).toBeInTheDocument();
      expect(screen.getByTestId('week-label')).toHaveTextContent(/19 – 25 de out/);
      await waitFor(() =>
        expect(listMock).toHaveBeenLastCalledWith({
          from: new Date(2026, 9, 19).toISOString(),
          to: new Date(2026, 9, 26).toISOString(),
        }),
      );
    });

    it('até 3 visitas cabem sem "+N"', async () => {
      const user = userEvent.setup({ delay: null });
      const three = [9, 10, 11].map((hour, i) =>
        visit({ id: `v-${i}`, scheduledAt: new Date(2026, 9, 22, hour, 0).toISOString() }),
      );
      listMock.mockResolvedValue(listResponse(three));
      await openMonth(user);
      const cell = within(monthDay(new Date(2026, 9, 22)));
      await cell.findByRole('button', { name: /11:00 Dra\. Júlia Costa/ });
      expect(cell.getAllByTestId('month-card')).toHaveLength(3);
      expect(cell.queryByTestId('month-more')).not.toBeInTheDocument();
    });

    it('mês anterior, próximo e hoje mudam o período (semanas de borda incluídas)', async () => {
      const user = userEvent.setup({ delay: null });
      await openMonth(user);

      await user.click(screen.getByRole('button', { name: 'Próximo mês' }));
      // Novembro/2026: 1º é domingo (semana de 26/10); 30 é segunda (semana até 06/12).
      await waitFor(() =>
        expect(listMock).toHaveBeenLastCalledWith({
          from: new Date(2026, 9, 26).toISOString(),
          to: new Date(2026, 11, 7).toISOString(),
        }),
      );
      expect(screen.getByTestId('week-label')).toHaveTextContent('novembro de 2026');

      await user.click(screen.getByRole('button', { name: 'Mês anterior' }));
      await user.click(screen.getByRole('button', { name: 'Mês anterior' }));
      await waitFor(() =>
        expect(listMock).toHaveBeenLastCalledWith({
          from: new Date(2026, 7, 31).toISOString(),
          to: new Date(2026, 9, 5).toISOString(),
        }),
      );

      await user.click(screen.getByRole('button', { name: 'Hoje' }));
      await waitFor(() =>
        expect(listMock).toHaveBeenLastCalledWith({
          from: GRID_START.toISOString(),
          to: GRID_END.toISOString(),
        }),
      );
    });

    it('filtros de status, finalidade, responsável e médico valem na Mês', async () => {
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
        purpose: { id: 'p-patrocinio', name: 'Solicitação de patrocínio', color: 'verde' },
        scheduledAt: new Date(2026, 9, 20, 15, 0).toISOString(),
        status: 'cancelada',
        statusReason: 'Férias',
      });
      listMock.mockResolvedValue(listResponse([visit(), paulo]));
      const month = await openMonth(user);
      await month.findByRole('button', { name: /Dr\. Paulo Lima — Cancelada/ });
      const filters = within(screen.getByTestId('agenda-filters'));

      await user.click(filters.getByRole('button', { name: /^Cancelada\s*1$/ }));
      expect(month.queryByRole('button', { name: /Dr\. Paulo Lima/ })).not.toBeInTheDocument();
      await user.click(filters.getByRole('button', { name: /^Cancelada\s*1$/ }));

      await user.click(filters.getByRole('button', { name: /^Solicitação de patrocínio\s*1$/ }));
      expect(month.queryByRole('button', { name: /Dr\. Paulo Lima/ })).not.toBeInTheDocument();
      await user.click(filters.getByRole('button', { name: /^Solicitação de patrocínio\s*1$/ }));

      await user.click(await filters.findByRole('button', { name: 'Bia' }));
      expect(month.queryByRole('button', { name: /Dr\. Paulo Lima/ })).not.toBeInTheDocument();
      expect(month.getByRole('button', { name: /Dra\. Júlia Costa/ })).toBeInTheDocument();
      await user.click(filters.getByRole('button', { name: 'Bia' }));

      await waitFor(() =>
        expect(screen.getAllByRole('option', { name: 'Dra. Júlia Costa' }).length).toBeGreaterThan(
          0,
        ),
      );
      await user.selectOptions(
        filters.getByRole('combobox', { name: 'Filtrar por médico' }),
        'doc-1',
      );
      expect(month.queryByRole('button', { name: /Dr\. Paulo Lima/ })).not.toBeInTheDocument();
      expect(month.getByRole('button', { name: /Dra\. Júlia Costa/ })).toBeInTheDocument();
    });
  });

  describe('arrastar e soltar', () => {
    it('na Mês, soltar em outro dia mantém a hora; o toast tem Desfazer, que reagenda de volta', async () => {
      const user = userEvent.setup({ delay: null });
      const original = visit();
      const moved = new Date(2026, 9, 9, 9, 30);
      let resolveFirst: (value: VisitDetail) => void = () => undefined;
      rescheduleMock.mockReturnValueOnce(
        new Promise<VisitDetail>((resolve) => {
          resolveFirst = resolve;
        }),
      );
      rescheduleMock.mockResolvedValueOnce(visit({ rescheduleCount: 2 }));
      await openMonth(user);
      const card = await within(monthDay(new Date(2026, 9, 6))).findByRole('button', {
        name: /09:30 Dra\. Júlia Costa/,
      });
      expect(card).toHaveAttribute('draggable', 'true');

      drag(card, monthDay(new Date(2026, 9, 9)));
      expect(rescheduleMock).toHaveBeenCalledWith('v-1', {
        scheduledAt: moved.toISOString(),
        reason: null,
      });
      // Otimista: com a resposta ainda pendente, o cartão já está no dia novo.
      expect(
        await within(monthDay(new Date(2026, 9, 9))).findByRole('button', {
          name: /Dra\. Júlia Costa/,
        }),
      ).toBeInTheDocument();
      resolveFirst(visit({ scheduledAt: moved.toISOString(), rescheduleCount: 1 }));
      expect(
        await screen.findByText('Visita reagendada para Sex, 09/10 às 09:30'),
      ).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Desfazer' }));
      await waitFor(() => expect(rescheduleMock).toHaveBeenCalledTimes(2));
      expect(rescheduleMock).toHaveBeenLastCalledWith('v-1', {
        scheduledAt: original.scheduledAt,
        reason: null,
      });
      expect(await screen.findByText('Reagendamento desfeito')).toBeInTheDocument();
    });

    it('soltar no mesmo dia não chama a API', async () => {
      const user = userEvent.setup({ delay: null });
      await openMonth(user);
      const day = monthDay(new Date(2026, 9, 6));
      const card = await within(day).findByRole('button', { name: /Dra\. Júlia Costa/ });
      drag(card, day);
      expect(rescheduleMock).not.toHaveBeenCalled();
    });

    it('na Semana, soltar troca dia e hora com encaixe de 30 min pelo topo do cartão', async () => {
      renderPage();
      const week = within(await screen.findByTestId('agenda-week'));
      const block = await week.findByRole('button', { name: /09:30 Dra\. Júlia Costa/ });
      rescheduleMock.mockResolvedValue(visit());

      // 1 h = 64px a partir das 07:00. Topo em 448px + 10 → 14:00 (meia hora mais próxima).
      drag(block, weekColumn(new Date(2026, 9, 8)), { dropY: 458 });
      await waitFor(() =>
        expect(rescheduleMock).toHaveBeenLastCalledWith('v-1', {
          scheduledAt: new Date(2026, 9, 8, 14, 0).toISOString(),
          reason: null,
        }),
      );

      // Pegou o cartão 20px abaixo do topo: o topo cai em 485 - 20 = 465 → 14:30.
      const again = await week.findByRole('button', { name: /Dra\. Júlia Costa/ });
      drag(again, weekColumn(new Date(2026, 9, 9)), { grabY: 20, dropY: 485 });
      await waitFor(() =>
        expect(rescheduleMock).toHaveBeenLastCalledWith('v-1', {
          scheduledAt: new Date(2026, 9, 9, 14, 30).toISOString(),
          reason: null,
        }),
      );
    });

    it('realizada, cancelada, não recebeu e com check-in não ficam arrastáveis', async () => {
      const user = userEvent.setup({ delay: null });
      const at = (day: number) => new Date(2026, 9, day, 10, 0).toISOString();
      listMock.mockResolvedValue(
        listResponse([
          visit({ id: 'v-ok', scheduledAt: at(12) }),
          visit({ id: 'v-done', scheduledAt: at(13), status: 'realizada' }),
          visit({ id: 'v-cancel', scheduledAt: at(14), status: 'cancelada' }),
          visit({ id: 'v-nr', scheduledAt: at(15), status: 'nao_recebeu' }),
          visit({ id: 'v-in', scheduledAt: at(16), checkInAt: at(16) }),
        ]),
      );
      await openMonth(user);
      const card = (day: number) =>
        within(monthDay(new Date(2026, 9, day))).getByTestId('month-card');
      await waitFor(() => expect(card(12)).toHaveAttribute('draggable', 'true'));
      for (const day of [13, 14, 15, 16]) expect(card(day)).toHaveAttribute('draggable', 'false');

      // Mesmo que um drop chegue com uma delas, nada vai à API.
      drag(card(16), monthDay(new Date(2026, 9, 20)));
      expect(rescheduleMock).not.toHaveBeenCalled();
    });

    it('representante só arrasta a visita em que é o responsável', async () => {
      const user = userEvent.setup({ delay: null });
      useAuthStore.setState({
        user: {
          id: 'u-bia',
          email: 'bia@lab.test',
          name: 'Bia Atendente',
          role: 'representative',
          discountLimit: 0,
        },
      });
      listMock.mockResolvedValue(
        listResponse([
          visit({ id: 'v-mine', scheduledAt: new Date(2026, 9, 12, 10, 0).toISOString() }),
          visit({
            id: 'v-other',
            scheduledAt: new Date(2026, 9, 13, 10, 0).toISOString(),
            responsible: { id: 'u-ana', name: 'Ana Gestora' },
          }),
        ]),
      );
      await openMonth(user);
      const card = (day: number) =>
        within(monthDay(new Date(2026, 9, day))).getByTestId('month-card');
      await waitFor(() => expect(card(12)).toHaveAttribute('draggable', 'true'));
      expect(card(13)).toHaveAttribute('draggable', 'false');
    });

    it('409 (check-in/encerrada) mostra o aviso e devolve o cartão ao lugar', async () => {
      const user = userEvent.setup({ delay: null });
      rescheduleMock.mockRejectedValue(
        new ApiError('VISIT_ALREADY_CHECKED_IN', 'Visita já tem check-in', 409, {
          checkInAt: '2026-10-06T12:35:00.000Z',
        }),
      );
      await openMonth(user);
      const card = await within(monthDay(new Date(2026, 9, 6))).findByRole('button', {
        name: /Dra\. Júlia Costa/,
      });
      drag(card, monthDay(new Date(2026, 9, 9)));

      expect(
        await screen.findByText(
          'Esta visita não pode mais ser reagendada (já tem check-in ou foi encerrada).',
        ),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(
          within(monthDay(new Date(2026, 9, 6))).getByRole('button', { name: /Dra\. Júlia Costa/ }),
        ).toBeInTheDocument(),
      );
      expect(
        within(monthDay(new Date(2026, 9, 9))).queryByRole('button', { name: /Dra\. Júlia Costa/ }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Desfazer' })).not.toBeInTheDocument();
    });

    it('erro de rede também devolve o cartão', async () => {
      const user = userEvent.setup({ delay: null });
      rescheduleMock.mockRejectedValue(new TypeError('Failed to fetch'));
      await openMonth(user);
      const card = await within(monthDay(new Date(2026, 9, 6))).findByRole('button', {
        name: /Dra\. Júlia Costa/,
      });
      drag(card, monthDay(new Date(2026, 9, 9)));
      await waitFor(() => expect(rescheduleMock).toHaveBeenCalled());
      await waitFor(() =>
        expect(
          within(monthDay(new Date(2026, 9, 6))).getByRole('button', { name: /Dra\. Júlia Costa/ }),
        ).toBeInTheDocument(),
      );
    });
  });

  describe('celular', () => {
    it('Mês mostra um ponto por dia com visita e, ao tocar, a lista do dia; sem arrastar', async () => {
      const user = userEvent.setup({ delay: null });
      mockViewport(390);
      renderPage();
      await screen.findByTestId('agenda-mobile');
      await user.click(screen.getByRole('tab', { name: 'Mês' }));
      const grid = within(await screen.findByTestId('agenda-mobile-month'));
      await waitFor(() =>
        expect(listMock).toHaveBeenLastCalledWith({
          from: GRID_START.toISOString(),
          to: GRID_END.toISOString(),
        }),
      );
      expect(grid.getAllByTestId('mobile-month-day')).toHaveLength(35);
      const withVisit = await grid.findByRole('button', {
        name: /Terça, 06 de out\., com visitas/,
      });
      expect(within(withVisit).getByTestId('mobile-month-dot')).toBeInTheDocument();
      expect(grid.getAllByTestId('mobile-month-dot')).toHaveLength(1);

      await user.click(withVisit);
      const list = within(await screen.findByTestId('agenda-day-list'));
      const card = list.getByTestId('visit-card');
      expect(card).toHaveTextContent('Dra. Júlia Costa');
      expect(card).not.toHaveAttribute('draggable', 'true');

      await user.click(grid.getByRole('button', { name: 'Próximo mês' }));
      await waitFor(() =>
        expect(listMock).toHaveBeenLastCalledWith({
          from: new Date(2026, 9, 26).toISOString(),
          to: new Date(2026, 11, 7).toISOString(),
        }),
      );
    });
  });
});
