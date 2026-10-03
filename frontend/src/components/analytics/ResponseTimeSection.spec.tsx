import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ResponseTimeReport, ResponseTimeResponder } from '@crm-lab/shared';
import type * as ApiClientModule from '@/api/client';
import { ToastProvider } from '@/components/ui';
import ResponseTimeSection from './ResponseTimeSection';

/**
 * Seção "Tempo de resposta" de `/analytics` (CRMLAB-83, D-257). O `http.get`
 * é falso e guarda a URL pedida — o teste do filtro confere o período que
 * chega ao servidor. O gráfico é dublê (Recharts não mede nada no jsdom) e a
 * exportação também: o que se prova é QUAL recorte vai para o Excel.
 */
const { getMock, exportMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  exportMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('@/api/client');
  return { ...actual, http: { get: getMock } };
});

vi.mock('@/lib/excel/response-time-report', () => ({
  generateResponseTimeExcel: exportMock,
}));

vi.mock('@/components/analytics/ResponseTimeDailyChart', () => ({
  default: ({ days }: { days: Array<{ date: string }> }) => (
    <div data-testid="daily-chart">{days.length} dias</div>
  ),
}));

const buckets = { upTo5: 1, upTo15: 1, upTo60: 0, over60: 0 };

function responder(over: Partial<ResponseTimeResponder>): ResponseTimeResponder {
  return {
    responderId: 'u1',
    name: 'Ana',
    kind: 'user',
    answered: 2,
    averageMinutes: 6.5,
    medianMinutes: 6.5,
    buckets,
    firstResponse: { answered: 1, averageMinutes: 10, medianMinutes: 10 },
    daily: [{ date: '2026-09-15', answered: 2, averageMinutes: 6.5, medianMinutes: 6.5 }],
    ...over,
  };
}

function report(): ResponseTimeReport {
  return {
    period: { startDate: '2026-09-01', endDate: '2026-09-30' },
    timezone: 'America/Sao_Paulo',
    total: {
      answered: 3,
      averageMinutes: 11,
      medianMinutes: 10,
      buckets: { upTo5: 1, upTo15: 1, upTo60: 1, over60: 0 },
      firstResponse: { answered: 2, averageMinutes: 15, medianMinutes: 15 },
      unanswered: { waiting: 2, closed: 1, conversations: 3 },
      daily: [
        { date: '2026-09-15', answered: 3, averageMinutes: 11, medianMinutes: 10, unanswered: 3 },
        { date: '2026-09-16', answered: 0, averageMinutes: null, medianMinutes: null, unanswered: 0 },
      ],
    },
    responders: [
      responder({}),
      responder({
        responderId: 'phone',
        name: 'Celular',
        kind: 'phone',
        answered: 1,
        averageMinutes: 20,
        medianMinutes: 20,
        buckets: { upTo5: 0, upTo15: 0, upTo60: 1, over60: 0 },
        firstResponse: { answered: 1, averageMinutes: 20, medianMinutes: 20 },
      }),
    ],
  };
}

let queryClient: QueryClient;

function renderSection(startDate = '2026-09-01', endDate = '2026-09-30') {
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ResponseTimeSection startDate={startDate} endDate={endDate} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** O `MetricTile` cujo rótulo é `label` (o `div` do cartão). */
function tile(label: string): HTMLElement {
  const node = screen.getByText(label, { selector: 'p' }).parentElement;
  if (!node) throw new Error(`cartão ${label} não encontrado`);
  return node;
}

describe('ResponseTimeSection', () => {
  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getMock.mockReset();
    getMock.mockResolvedValue(report());
    exportMock.mockClear();
  });

  it('pede o período do topo e mostra os indicadores do laboratório', async () => {
    renderSection();
    await screen.findByRole('heading', { name: 'Tempo de resposta no WhatsApp' });

    expect(getMock).toHaveBeenCalledWith('/analytics/response-time', {
      startDate: '2026-09-01',
      endDate: '2026-09-30',
    });
    expect(tile('Mediana')).toHaveTextContent('10 min');
    expect(tile('Média')).toHaveTextContent('11 min');
    expect(tile('1ª resposta (mediana)')).toHaveTextContent('15 min');
    expect(tile('Sem resposta')).toHaveTextContent('3');
    expect(tile('Sem resposta')).toHaveTextContent('2 aguardando · 1 encerrados · 3 conversas');
    expect(screen.getByTestId('daily-chart')).toHaveTextContent('2 dias');
  });

  it('ranking com a linha "Celular" e o total do laboratório', async () => {
    renderSection();
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    // cabeçalho + Ana + Celular + total
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent('Ana');
    expect(rows[2]).toHaveTextContent('Celular');
    expect(rows[2]).toHaveTextContent('20 min');
    expect(rows[3]).toHaveTextContent('Total do laboratório');
  });

  it('filtro de atendente troca os indicadores sem nova busca; sem resposta só no total', async () => {
    renderSection();
    await screen.findByRole('table');

    await userEvent.selectOptions(screen.getByLabelText('Atendente'), 'phone');

    expect(tile('Mediana')).toHaveTextContent('20 min');
    expect(tile('Sem resposta')).toHaveTextContent('Só no total');
    expect(screen.getByTestId('daily-chart')).toHaveTextContent('1 dias');
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('exporta o Excel com o recorte escolhido', async () => {
    renderSection();
    await screen.findByRole('table');

    await userEvent.click(screen.getByRole('button', { name: 'Exportar Excel' }));
    expect(exportMock).toHaveBeenLastCalledWith(report(), null);

    await userEvent.selectOptions(screen.getByLabelText('Atendente'), 'u1');
    await userEvent.click(screen.getByRole('button', { name: 'Exportar Excel' }));
    expect(exportMock).toHaveBeenLastCalledWith(report(), 'u1');
  });

  it('período acima de 93 dias avisa e não busca', async () => {
    renderSection('2026-06-01', '2026-09-30');
    expect(await screen.findByRole('alert')).toHaveTextContent('até 93 dias');
    expect(getMock).not.toHaveBeenCalled();
  });
});
