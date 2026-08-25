import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationOverviewResponse, UserRole } from '@crm-lab/shared';
import { operationApi } from '@/api/operation';
import { formatDurationSeconds } from '@/lib/format';
import { useAuthStore, useUIStore } from '@/stores';
import OperationSettings from './Operation';

vi.mock('@/api/operation', () => ({
  operationApi: { overview: vi.fn() },
}));

const overviewMock = vi.mocked(operationApi.overview);

/** Shape EXATO de docs/api/API_CONTRACTS.md §7 — sem `as any`. */
const overview: OperationOverviewResponse = {
  generatedAt: new Date().toISOString(),
  queue: {
    unassigned: 7,
    waiting: 3,
    // Da fila INTEIRA: maior que a maior espera dos itens listados abaixo.
    oldestWaitSeconds: 93_600,
    items: [
      {
        conversationId: 'conv-1',
        patientId: 'patient-1',
        patientName: 'João Santos',
        channel: 'whatsapp',
        reason: 'unassigned',
        assignedTo: null,
        assignedToName: null,
        unreadCount: 2,
        waitingSeconds: 5400,
        lastMessageAt: '2026-08-24T16:02:10.000Z',
      },
      {
        conversationId: 'conv-2',
        patientId: null,
        patientName: 'Ana Lima',
        channel: 'whatsapp',
        reason: 'waiting',
        assignedTo: 'user-1',
        assignedToName: 'Maria Souza',
        unreadCount: 1,
        waitingSeconds: 780,
        lastMessageAt: '2026-08-24T17:19:10.000Z',
      },
    ],
  },
  workload: [
    {
      userId: 'user-1',
      name: 'Maria Souza',
      role: 'attendant',
      activeConversations: 12,
      unreadMessages: 4,
      openProposals: 5,
      pendingApprovals: 1,
    },
    {
      userId: 'user-2',
      name: 'Zezinho Sem Carga',
      role: 'attendant',
      activeConversations: 0,
      unreadMessages: 0,
      openProposals: 0,
      pendingApprovals: 0,
    },
  ],
  pendingDecisions: {
    total: 1,
    items: [
      {
        proposalId: 'proposal-1',
        patientName: 'João Santos',
        createdBy: 'user-1',
        createdByName: 'Maria Souza',
        status: 'orcamento_enviado',
        discountPercent: 25,
        totalPrice: 150,
        createdAt: '2026-08-24T14:40:00.000Z',
        waitingSeconds: 10_330,
      },
    ],
    pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
  },
};

const emptyOverview: OperationOverviewResponse = {
  generatedAt: new Date().toISOString(),
  queue: { unassigned: 0, waiting: 0, oldestWaitSeconds: null, items: [] },
  workload: [],
  pendingDecisions: {
    total: 0,
    items: [],
    pagination: { page: 1, limit: 25, total: 0, totalPages: 0 },
  },
};

function signIn(role: UserRole) {
  useAuthStore.setState({
    user: { id: 'user-9', email: 'quem@lab.com.br', name: 'Quem', role, discountLimit: 10 },
  });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OperationSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('OperationSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    overviewMock.mockResolvedValue(overview);
    useUIStore.setState({ activeModal: null });
  });

  afterEach(() => {
    useAuthStore.setState({ user: null });
    useUIStore.setState({ activeModal: null });
  });

  it('gestor vê fila, carga e decisões pendentes de UMA chamada só', async () => {
    signIn('manager');
    renderPage();

    // "João Santos" aparece na fila E no cartão de decisão — é o mesmo retrato.
    expect((await screen.findAllByText('João Santos')).length).toBeGreaterThan(0);
    expect(screen.getByText('Ana Lima')).toBeInTheDocument();

    // D-067: um endpoint, um retrato — não três chamadas.
    expect(overviewMock).toHaveBeenCalledTimes(1);
  });

  it('formata espera em segundos como texto humano — nunca subtrai datas', async () => {
    signIn('manager');
    renderPage();

    // 5400s = 1h30 · 780s = 13 min · 10330s = 2h52
    expect(await screen.findByText('1h30')).toBeInTheDocument();
    expect(screen.getByText('13 min')).toBeInTheDocument();
    expect(screen.getByText(/esperando há 2h52/i)).toBeInTheDocument();
  });

  it('rotula a maior espera como sendo da FILA INTEIRA, não dos itens listados', async () => {
    signIn('manager');
    renderPage();

    // 93600s = 26h = 1d 2h — maior do que qualquer item da amostra exibida.
    expect(await screen.findByText('1d 2h')).toBeInTheDocument();
    expect(screen.getByText('Maior espera da fila')).toBeInTheDocument();
    expect(
      screen.getByText('Considera a fila inteira, não apenas os itens listados.'),
    ).toBeInTheDocument();
  });

  it('atendente sem carga aparece zerado, não some da tabela', async () => {
    signIn('manager');
    renderPage();

    const row = (await screen.findByText('Zezinho Sem Carga')).closest('tr');
    expect(row).not.toBeNull();
    if (!row) return;
    // 4 colunas numéricas zeradas + a coluna de nome.
    expect(within(row).getAllByText('0')).toHaveLength(4);
  });

  /**
   * RELÓGIO CONGELADO, e não `new Date()` no carregamento do módulo.
   *
   * A versão anterior montava `generatedAt: new Date().toISOString()` uma vez,
   * quando o arquivo era importado, e esperava /Atualizado agora/ — que só vale
   * enquanto a diferença for menor que 60s (`formatRelativeDate`). Numa máquina
   * lenta o arquivo inteiro leva mais que isso e o teste fica vermelho sem
   * nenhuma regressão. `Operation.tsx` não repassa o `now` injetável de
   * `formatRelativeDate`, então quem congela o relógio aqui é o teste.
   */
  it('mostra de quando é o retrato, a partir de generatedAt', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const agora = new Date('2026-08-25T12:00:00.000Z');
      vi.setSystemTime(agora);
      overviewMock.mockResolvedValue({ ...overview, generatedAt: agora.toISOString() });

      signIn('manager');
      renderPage();

      expect(await screen.findByRole('status')).toHaveTextContent(/Atualizado agora/i);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Controle positivo do teste acima: sem ele, "Atualizado agora" passaria
   * também se a tela imprimisse a palavra fixa e ignorasse `generatedAt`.
   */
  it('o carimbo SAI de generatedAt: retrato de 5 min atrás não diz "agora"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const agora = new Date('2026-08-25T12:00:00.000Z');
      vi.setSystemTime(agora);
      overviewMock.mockResolvedValue({
        ...overview,
        generatedAt: new Date(agora.getTime() - 5 * 60_000).toISOString(),
      });

      signIn('manager');
      renderPage();

      expect(await screen.findByRole('status')).toHaveTextContent(/Atualizado há 5 min/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cartão de decisão pendente abre o Modal da Proposta', async () => {
    const user = userEvent.setup();
    signIn('manager');
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Abrir proposta de João Santos/i }));

    expect(useUIStore.getState().activeModal).toEqual({ kind: 'proposal', id: 'proposal-1' });
  });

  it('fila vazia mostra estado vazio e traço na maior espera', async () => {
    overviewMock.mockResolvedValue(emptyOverview);
    signIn('admin');
    renderPage();

    expect(
      await screen.findByText('Nenhuma conversa esperando — a fila está limpa'),
    ).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('Nenhuma decisão pendente')).toBeInTheDocument();
  });

  it('atendente é barrado SEM disparar request', async () => {
    signIn('attendant');
    renderPage();

    expect(
      await screen.findByText('Acesso restrito a gestor e administrador'),
    ).toBeInTheDocument();
    expect(overviewMock).not.toHaveBeenCalled();
  });

  it('operador da plataforma é barrado SEM disparar request', async () => {
    signIn('platform_operator');
    renderPage();

    expect(
      await screen.findByText('Acesso restrito a gestor e administrador'),
    ).toBeInTheDocument();
    expect(overviewMock).not.toHaveBeenCalled();
  });

  it('erro da API vira estado de erro com nova tentativa', async () => {
    const { ApiError } = await import('@/api/client');
    overviewMock.mockRejectedValue(new ApiError('INTERNAL_ERROR', 'Falhou', 500));
    signIn('manager');
    renderPage();

    expect(await screen.findByText('Não foi possível carregar a operação')).toBeInTheDocument();

    overviewMock.mockResolvedValue(overview);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(screen.getAllByText('João Santos').length).toBeGreaterThan(0));
  });
});

describe('formatDurationSeconds', () => {
  it('traduz segundos em faixas legíveis', () => {
    expect(formatDurationSeconds(0)).toBe('menos de 1 min');
    expect(formatDurationSeconds(59)).toBe('menos de 1 min');
    expect(formatDurationSeconds(60)).toBe('1 min');
    expect(formatDurationSeconds(780)).toBe('13 min');
    expect(formatDurationSeconds(3600)).toBe('1h');
    expect(formatDurationSeconds(5400)).toBe('1h30');
    expect(formatDurationSeconds(10_330)).toBe('2h52');
    expect(formatDurationSeconds(86_400)).toBe('1d');
    expect(formatDurationSeconds(93_600)).toBe('1d 2h');
  });

  it('não exibe espera negativa quando o relógio discorda', () => {
    expect(formatDurationSeconds(-30)).toBe('menos de 1 min');
    expect(formatDurationSeconds(Number.NaN)).toBe('menos de 1 min');
  });
});
