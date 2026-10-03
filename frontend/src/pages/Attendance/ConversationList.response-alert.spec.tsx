import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BusinessHours, Conversation } from '@crm-lab/shared';
import { ToastProvider } from '@/components/ui';
import {
  ConversationList,
  RESPONSE_ALERT_TICK_MS,
  type ConversationListProps,
  type ConversationResponseAlert,
} from './ConversationList';

/**
 * Alerta de tempo de resposta na lista (CRMLAB-84, D-254): minutos ÚTEIS
 * calculados no navegador, relógio local a cada 30 s e o chip "Aguardando
 * resposta" que conta e filtra a página carregada.
 */

const HOURS: BusinessHours = {
  timezone: 'America/Sao_Paulo',
  days: {
    mon: { start: '08:00', end: '18:00' },
    tue: { start: '08:00', end: '18:00' },
    wed: { start: '08:00', end: '18:00' },
    thu: { start: '08:00', end: '18:00' },
    fri: { start: '08:00', end: '18:00' },
  },
};

/** Hora local de São Paulo (UTC-3) → ISO. */
function sp(local: string): string {
  return new Date(`${local}-03:00`).toISOString();
}

function conversation(id: string, name: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    patientId: null,
    patientName: name,
    patientPhone: '+5548999990000',
    assignedTo: null,
    assignedToName: null,
    channel: 'whatsapp',
    status: 'active',
    unreadCount: 0,
    lastMessagePreview: 'oi',
    lastMessageAt: sp('2026-10-01T10:00'),
    tags: [],
    pinned: false,
    createdAt: sp('2026-10-01T09:00'),
    awaitingReplySince: null,
    ...overrides,
  };
}

const ANA = conversation('c-ana', 'Ana', { awaitingReplySince: sp('2026-10-01T10:00') });
const BIA = conversation('c-bia', 'Bia', { awaitingReplySince: sp('2026-10-01T10:10') });
const CAIO = conversation('c-caio', 'Caio');

function alertOn(minutes = 15, customHolidays: string[] = []): ConversationResponseAlert {
  return {
    rule: { enabled: true, minutes },
    calendar: { businessHours: HOURS, customHolidays: new Set(customHolidays) },
  };
}

function renderList(props: Partial<ConversationListProps> = {}) {
  const base: ConversationListProps = {
    conversations: [ANA, BIA, CAIO],
    counts: { mine: 0, unassigned: 3 },
    scope: 'all',
    onScopeChange: vi.fn(),
    onSearch: vi.fn(),
    selectedId: null,
    onSelect: vi.fn(),
    isLoading: false,
    isError: false,
    onRetry: vi.fn(),
    searchTerm: '',
    onTogglePin: vi.fn(),
    patients: [],
    patientsLoading: false,
    patientsError: false,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <ConversationList {...base} {...props} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function item(name: string): HTMLElement {
  const found = screen
    .getAllByTestId('conversation-item')
    .find((el) => within(el).queryByText(name) !== null);
  if (!found) throw new Error(`item ${name} não está na lista`);
  return found;
}

describe('ConversationList — alerta de tempo de resposta', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('destaca só quem passou do limite em minutos úteis; o chip conta', () => {
    // Quinta 10:20: Ana espera 20 min, Bia 10 min, Caio foi respondido.
    renderList({ responseAlert: alertOn(15), now: new Date(sp('2026-10-01T10:20')) });
    expect(item('Ana')).toHaveAttribute('data-response-alert', 'true');
    expect(within(item('Ana')).getByTestId('conversation-response-alert')).toHaveTextContent('há 20 min');
    expect(item('Bia')).toHaveAttribute('data-response-alert', 'false');
    expect(item('Caio')).toHaveAttribute('data-response-alert', 'false');
    expect(screen.getByRole('button', { name: 'Aguardando resposta 1' })).toBeInTheDocument();
  });

  it('fora do expediente o relógio para; feriado do laboratório também', () => {
    // Ana escreveu quinta 17:55; sexta 08:05 = 10 min úteis.
    const late = conversation('c-ana', 'Ana', { awaitingReplySince: sp('2026-10-01T17:55') });
    const { unmount } = renderList({
      conversations: [late],
      responseAlert: alertOn(10),
      now: new Date(sp('2026-10-02T08:05')),
    });
    expect(item('Ana')).toHaveAttribute('data-response-alert', 'true');
    unmount();

    // Com a sexta como feriado do laboratório, só conta 5 min da quinta.
    renderList({
      conversations: [late],
      responseAlert: alertOn(10, ['2026-10-02']),
      now: new Date(sp('2026-10-02T08:05')),
    });
    expect(item('Ana')).toHaveAttribute('data-response-alert', 'false');
  });

  it('chip filtra a lista e, clicado de novo, volta a mostrar tudo', async () => {
    const user = userEvent.setup();
    renderList({ responseAlert: alertOn(5), now: new Date(sp('2026-10-01T10:20')) });
    const chip = screen.getByRole('button', { name: 'Aguardando resposta 2' });
    await user.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByTestId('conversation-item')).toHaveLength(2);
    expect(screen.queryByText('Caio')).not.toBeInTheDocument();
    await user.click(chip);
    expect(screen.getAllByTestId('conversation-item')).toHaveLength(3);
  });

  it('filtro ligado sem ninguém esperando mostra o vazio próprio', async () => {
    const user = userEvent.setup();
    renderList({ responseAlert: alertOn(60), now: new Date(sp('2026-10-01T10:20')) });
    await user.click(screen.getByRole('button', { name: 'Aguardando resposta 0' }));
    expect(screen.getByText('Ninguém aguardando resposta')).toBeInTheDocument();
  });

  it('regra desligada, calendário carregando ou lista de encerradas: sem chip nem destaque', () => {
    const now = new Date(sp('2026-10-01T10:20'));
    const { unmount } = renderList({
      responseAlert: { rule: { enabled: false, minutes: 15 }, calendar: alertOn().calendar },
      now,
    });
    expect(screen.queryByRole('button', { name: /aguardando resposta/i })).not.toBeInTheDocument();
    expect(item('Ana')).toHaveAttribute('data-response-alert', 'false');
    unmount();

    const loading = renderList({ responseAlert: { rule: { enabled: true, minutes: 15 }, calendar: null }, now });
    expect(screen.queryByRole('button', { name: /aguardando resposta/i })).not.toBeInTheDocument();
    loading.unmount();

    renderList({ responseAlert: alertOn(15), now, scope: 'closed' });
    expect(screen.queryByRole('button', { name: /aguardando resposta/i })).not.toBeInTheDocument();
  });

  it('o destaque acende sozinho com o relógio local, sem recarregar', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date(sp('2026-10-01T10:14')));
    renderList({ conversations: [ANA], responseAlert: alertOn(15) });
    expect(item('Ana')).toHaveAttribute('data-response-alert', 'false');

    act(() => {
      vi.advanceTimersByTime(RESPONSE_ALERT_TICK_MS * 2);
    });
    expect(item('Ana')).toHaveAttribute('data-response-alert', 'true');
    expect(screen.getByRole('button', { name: 'Aguardando resposta 1' })).toBeInTheDocument();
  });
});
