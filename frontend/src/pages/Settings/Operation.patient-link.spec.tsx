import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationOverviewResponse } from '@crm-lab/shared';
import { operationApi } from '@/api/operation';
import { useAuthStore, useUIStore } from '@/stores';
import OperationSettings from './Operation';

vi.mock('@/api/operation', () => ({
  operationApi: { overview: vi.fn() },
}));

const overviewMock = vi.mocked(operationApi.overview);

/**
 * Gestão da Operação — a fila como PORTA DE ENTRADA da Ficha do Paciente
 * (D-079, API_CONTRACTS.md §7: "a tela só linka para a ficha quando ele
 * existe").
 *
 * `QueueItem.patientId` já vinha na resposta e era descartado pela tela. Este
 * arquivo é separado de `Operation.spec.tsx` de propósito: aquele cobre o
 * retrato único (D-067), este cobre a navegação.
 */

const overview: OperationOverviewResponse = {
  generatedAt: '2026-08-25T12:00:00.000Z',
  queue: {
    unassigned: 1,
    waiting: 1,
    oldestWaitSeconds: 5400,
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
        // Conversa anterior ao backfill da migração 003 (D-072): sem cadastro.
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
  workload: [],
  pendingDecisions: {
    total: 0,
    items: [],
    pagination: { page: 1, limit: 25, total: 0, totalPages: 0 },
  },
};

function PatientProfileStub() {
  const { id } = useParams<{ id: string }>();
  return <p data-testid="ficha-do-paciente">{`ficha:${id ?? ''}`}</p>;
}

function AttendanceStub() {
  return <p data-testid="atendimento">atendimento</p>;
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings/operation']}>
        <Routes>
          <Route path="/settings/operation" element={<OperationSettings />} />
          <Route path="/patients/:id" element={<PatientProfileStub />} />
          <Route path="/attendance" element={<AttendanceStub />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Gestão da Operação — link para a ficha (D-079)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    overviewMock.mockResolvedValue(overview);
    useUIStore.setState({ activeModal: null });
    useAuthStore.setState({
      user: {
        id: 'user-9',
        email: 'gestor@lab.com.br',
        name: 'Gestor',
        role: 'manager',
        discountLimit: 10,
      },
    });
  });

  afterEach(() => {
    useAuthStore.setState({ user: null });
  });

  it('item com patientId vira link para a ficha daquele paciente', async () => {
    renderPage();

    const link = await screen.findByRole('link', { name: 'João Santos' });
    expect(link).toHaveAttribute('href', '/patients/patient-1');

    // O clique abre a FICHA, não o Atendimento da linha (stopPropagation).
    await userEvent.click(link);
    expect(await screen.findByTestId('ficha-do-paciente')).toHaveTextContent('ficha:patient-1');
  });

  it('item com patientId null continua texto — nenhum link quebrado', async () => {
    renderPage();

    expect(await screen.findByText('Ana Lima')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ana Lima' })).not.toBeInTheDocument();
  });

  it('o resto da linha continua levando ao Atendimento', async () => {
    renderPage();

    // Nome sem link (patientId null): o clique cai na linha, não num âncora.
    await userEvent.click(await screen.findByText('Ana Lima'));

    expect(await screen.findByTestId('atendimento')).toBeInTheDocument();
  });
});
