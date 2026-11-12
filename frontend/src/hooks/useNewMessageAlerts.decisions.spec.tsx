import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ListConversationsResponse,
  OperationOverviewResponse,
  PendingDecisionItem,
  UserRole,
} from '@crm-lab/shared';
import type * as ApiModule from '@/api';

const listMock = vi.fn();
const channelsMock = vi.fn();
const overviewMock = vi.fn();
const playSoundMock = vi.fn();

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    operationApi: { ...actual.operationApi, overview: overviewMock },
    api: {
      ...actual.api,
      conversations: { ...actual.api.conversations, list: listMock },
      internalChat: { ...actual.api.internalChat, channels: channelsMock },
    },
  };
});

vi.mock('@/lib/notification-sound', () => ({ playNewMessageSound: playSoundMock }));

const { queryKeys } = await import('@/api');
const { useAuthStore } = await import('@/stores');
const { reloadMessageAlertPrefs } = await import('@/stores/message-alerts.store');
const { useNewMessageAlerts, detectNewApprovalRequests, approvalAlertBody, decidesApprovals } =
  await import('./useNewMessageAlerts');

/**
 * CRMLAB-146 (D-318) — o pedido de aprovação saiu do chat interno. Quem decide
 * (gestor/admin) é avisado quando aparece proposta nova nas decisões
 * pendentes; o clique abre a tela Decisões. Sem o conteúdo (D-240).
 */

const ME = 'u-1';
const CARLA = 'u-9';
const T0 = '2026-11-12T10:00:00Z';

function item(proposalId: string, createdBy = CARLA): PendingDecisionItem {
  return {
    proposalId,
    patientName: 'Juliana Prado',
    createdBy,
    createdByName: 'Carla',
    status: 'novo_contato',
    discountPercent: 25,
    totalPrice: 138,
    createdAt: T0,
    waitingSeconds: 60,
  };
}

function overview(items: PendingDecisionItem[]): OperationOverviewResponse {
  return {
    generatedAt: T0,
    queue: { unassigned: 0, waiting: 0, oldestWaitSeconds: null, items: [] },
    workload: [],
    pendingDecisions: {
      total: items.length,
      items,
      pagination: { page: 1, limit: 25, total: items.length, totalPages: 1 },
    },
  };
}

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static instances: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {
    FakeNotification.instances.push(this);
  }
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

function Harness() {
  useNewMessageAlerts();
  return <LocationProbe />;
}

let queryClient: QueryClient;

/** Linha de base das decisões e, depois, o retrato que chega pelo WS `approval.requested`. */
async function loadDecisionsThen(
  first: PendingDecisionItem[],
  next: PendingDecisionItem[],
): Promise<void> {
  overviewMock.mockResolvedValueOnce(overview(first));
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/proposals']}>
        <Harness />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(overviewMock).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(queryClient.getQueryData(queryKeys.operationOverview({}))).toBeDefined(),
  );
  overviewMock.mockResolvedValue(overview(next));
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.operationOverview({}) });
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function login(role: UserRole): void {
  useAuthStore.setState({
    user: { id: ME, email: 'a@lab.com', name: 'Ana', role, discountLimit: 15 },
    tenant: null,
    theme: null,
    tokens: { accessToken: 'a', expiresAt: Date.now() + 60_000 },
  });
}

beforeEach(() => {
  listMock.mockReset();
  channelsMock.mockReset();
  overviewMock.mockReset();
  playSoundMock.mockReset();
  const empty: ListConversationsResponse = {
    conversations: [],
    pagination: { page: 1, limit: 100, total: 0, totalPages: 1 },
    counts: { mine: 0, unassigned: 0 },
  };
  listMock.mockResolvedValue(empty);
  channelsMock.mockResolvedValue({ channels: [] });
  FakeNotification.instances = [];
  vi.stubGlobal('Notification', FakeNotification);
  vi.spyOn(document, 'hasFocus').mockImplementation(() => false);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  localStorage.clear();
  reloadMessageAlertPrefs();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('aviso de pedido de aprovação (CRMLAB-146)', () => {
  it('detecta só proposta nova e de outra pessoa', () => {
    const fresh = detectNewApprovalRequests(
      new Set(['p-velha']),
      [item('p-velha'), item('p-nova'), item('p-minha', ME)],
      ME,
    );
    expect(fresh.map((i) => i.proposalId)).toEqual(['p-nova']);
    expect(approvalAlertBody(1)).toBe('Novo pedido de aprovação');
    expect(approvalAlertBody(2)).toBe('2 novos pedidos de aprovação');
    expect(decidesApprovals('manager')).toBe(true);
    expect(decidesApprovals('admin')).toBe(true);
    expect(decidesApprovals('attendant')).toBe(false);
  });

  it('gestor: som e notificação "Decisões" sem o conteúdo; clique abre Decisões', async () => {
    login('manager');
    vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    await loadDecisionsThen([], [item('p-1')]);

    await waitFor(() => expect(FakeNotification.instances).toHaveLength(1));
    const [notification] = FakeNotification.instances;
    expect(notification?.title).toBe('Decisões');
    expect(notification?.options?.body).toBe('Novo pedido de aprovação');
    expect(JSON.stringify(notification)).not.toContain('Juliana');
    expect(playSoundMock).toHaveBeenCalledTimes(1);

    act(() => notification?.onclick?.());
    expect(screen.getByTestId('location')).toHaveTextContent('/decisions');
  });

  it('primeira carga é linha de base: pendência antiga não avisa', async () => {
    login('admin');
    await loadDecisionsThen([item('p-1')], [item('p-1')]);
    await settle();
    expect(playSoundMock).not.toHaveBeenCalled();
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('o próprio pedido do gestor não avisa (ele não pode aprovar, D-046)', async () => {
    login('manager');
    await loadDecisionsThen([], [item('p-1', ME)]);
    await settle();
    expect(playSoundMock).not.toHaveBeenCalled();
  });

  it('atendente nem busca as decisões', async () => {
    login('attendant');
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Harness />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await settle();
    expect(overviewMock).not.toHaveBeenCalled();
  });
});
