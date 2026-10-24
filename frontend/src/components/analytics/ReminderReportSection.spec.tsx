import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProposalReminderReport } from '@crm-lab/shared';
import type * as ApiClientModule from '@/api/client';
import ReminderReportSection from './ReminderReportSection';

/**
 * Seção "Lembretes" de `/analytics` (CRMLAB-103, D-279). O `http.get` é falso
 * e guarda a URL pedida — o teste confere o período que chega ao servidor.
 */
const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('@/api/client');
  return { ...actual, http: { get: getMock } };
});

function report(): ProposalReminderReport {
  return {
    period: { startDate: '2026-09-01', endDate: '2026-09-30' },
    timezone: 'America/Sao_Paulo',
    today: '2026-09-20',
    rows: [
      { userId: 'u1', name: 'Ana', overdueOpen: 3, won: 2, lost: 1, rescheduled: 4, autoClosed: 0, resolved: 7 },
      { userId: null, name: 'Sem responsável', overdueOpen: 1, won: 0, lost: 0, rescheduled: 0, autoClosed: 2, resolved: 2 },
    ],
    total: { overdueOpen: 4, won: 2, lost: 1, rescheduled: 4, autoClosed: 2, resolved: 9 },
  };
}

function renderSection(startDate = '2026-09-01', endDate = '2026-09-30') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ReminderReportSection startDate={startDate} endDate={endDate} />
    </QueryClientProvider>,
  );
}

describe('ReminderReportSection', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('mostra uma linha por responsável, "Sem responsável" e o total, com o período do topo', async () => {
    getMock.mockResolvedValue(report());
    renderSection();

    const ana = (await screen.findByText('Ana')).closest('tr');
    expect(ana).not.toBeNull();
    const anaCells = within(ana as HTMLElement).getAllByRole('cell').map((c) => c.textContent);
    expect(anaCells).toEqual(['Ana', '3', '2', '1', '4', '0', '7']);

    expect(screen.getByText('Sem responsável')).toBeInTheDocument();
    const total = screen.getByText('Total do laboratório').closest('tr') as HTMLElement;
    expect(within(total).getAllByRole('cell').map((c) => c.textContent)).toEqual([
      'Total do laboratório', '4', '2', '1', '4', '2', '9',
    ]);
    expect(screen.getByRole('columnheader', { name: 'Encerrado automático' })).toBeInTheDocument();

    expect(getMock).toHaveBeenCalledWith('/analytics/reminders', { startDate: '2026-09-01', endDate: '2026-09-30' });
  });

  it('erro na busca mostra o estado de erro', async () => {
    getMock.mockRejectedValue(new Error('falhou'));
    renderSection();
    expect(await screen.findByText('Não foi possível carregar os lembretes.')).toBeInTheDocument();
  });

  it('período invertido não busca e avisa', () => {
    renderSection('2026-09-30', '2026-09-01');
    expect(screen.getByRole('alert')).toHaveTextContent('Data final anterior à inicial.');
    expect(getMock).not.toHaveBeenCalled();
  });
});
