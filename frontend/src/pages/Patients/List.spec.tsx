import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListPatientsResponse } from '@crm-lab/shared';
import { ApiError } from '@/api/client';
import { patientsApi } from '@/api/patients';
import PatientsList from './List';

vi.mock('@/api/patients', () => ({
  patientsApi: {
    list: vi.fn(),
  },
}));

const listMock = vi.mocked(patientsApi.list);

const listResponse: ListPatientsResponse = {
  patients: [
    {
      id: 'patient-1',
      phone: '(11) 98765-4321',
      name: 'João Santos',
      email: null,
      birthDate: null,
      document: '12345678900',
      notes: null,
      tags: [],
      customFields: {},
      anonymizedAt: null,
      inactivatedAt: null,
      inactivationReason: null,
      lastInteractionAt: '2026-08-23T14:30:00.000Z',
      createdAt: '2026-06-02T10:00:00.000Z',
      updatedAt: '2026-08-20T09:15:00.000Z',
    },
  ],
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PatientsList />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PatientsList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue(listResponse);
  });

  it('lista pacientes com nome, telefone, CPF formatado e última interação', async () => {
    renderPage();

    expect(await screen.findByText('João Santos')).toBeInTheDocument();

    const table = within(screen.getByRole('table'));
    expect(table.getByText('(11) 98765-4321')).toBeInTheDocument();
    expect(table.getByText('123.456.789-00')).toBeInTheDocument();
  });

  it('consome GET /patients com página e limite do contrato, sem termo por padrão', async () => {
    renderPage();

    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(listMock).toHaveBeenCalledWith({ page: 1, limit: 20 }, { signal: expect.any(AbortSignal) });
  });

  it('busca por nome, CPF ou telefone no mesmo campo (debounce da SearchInput)', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await screen.findByText('João Santos');

    await user.type(screen.getByLabelText('Buscar contato'), '48999991234');

    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1, search: '48999991234' }),
        { signal: expect.any(AbortSignal) },
      ),
    );
  });

  /* ── Busca por pedaço do nome (CRMLAB-125, D-296) ──────────────────── */

  it('só busca a partir de 2 caracteres, depois do debounce', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await screen.findByText('João Santos');
    const field = screen.getByLabelText('Buscar paciente');

    await user.type(field, 'm');
    // Passa do debounce de 300 ms: 1 letra não vira busca.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(listMock.mock.calls.some(([query]) => query?.search !== undefined)).toBe(false);

    await user.type(field, 'a');
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: 'ma' }),
        { signal: expect.any(AbortSignal) },
      ),
    );
  });

  it('o termo novo cancela o pedido do termo anterior', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await screen.findByText('João Santos');
    // O pedido de "ma" fica pendurado: só o cancelamento o encerra.
    listMock.mockImplementation((query, options) =>
      query?.search === 'ma'
        ? new Promise<ListPatientsResponse>((_, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
        : Promise.resolve(listResponse),
    );
    const field = screen.getByLabelText('Buscar paciente');

    await user.type(field, 'ma');
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'ma' }), {
        signal: expect.any(AbortSignal),
      }),
    );
    const pending = listMock.mock.calls.at(-1)?.[1]?.signal;

    await user.type(field, 'r');
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'mar' }), {
        signal: expect.any(AbortSignal),
      }),
    );
    await waitFor(() => expect(pending?.aborted).toBe(true));
    expect(await screen.findByText('João Santos')).toBeInTheDocument();
  });

  it('mostra o estado vazio quando não há pacientes', async () => {
    listMock.mockResolvedValue({
      patients: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });

    renderPage();

    expect(await screen.findByText('Nenhum contato encontrado')).toBeInTheDocument();
  });

  it('mostra o estado de erro quando a busca falha', async () => {
    listMock.mockRejectedValue(new ApiError('INTERNAL_ERROR', 'boom', 500));

    renderPage();

    expect(await screen.findByText('Não foi possível carregar os contatos')).toBeInTheDocument();
  });

  /* ── Filtro de inativos (D-132, CRMLAB-11) ─────────────────────────── */

  it('esconde paciente inativo por padrão e mostra o status "Ativo" na coluna', async () => {
    renderPage();

    await screen.findByText('João Santos');
    expect(listMock).toHaveBeenLastCalledWith({ page: 1, limit: 20 }, { signal: expect.any(AbortSignal) });
    expect(within(screen.getByRole('table')).getByText('Ativo')).toBeInTheDocument();
  });

  it('marca o checkbox "Mostrar inativos" e pede includeInactive=true ao servidor', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('João Santos');

    await user.click(screen.getByLabelText('Mostrar inativos'));

    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(
        { page: 1, limit: 20, includeInactive: true },
        { signal: expect.any(AbortSignal) },
      ),
    );
  });

  it('mostra o status "Inativo" quando o paciente tem inactivatedAt', async () => {
    listMock.mockResolvedValue({
      patients: [
        {
          ...listResponse.patients[0]!,
          inactivatedAt: '2026-09-15T12:00:00.000Z',
          inactivationReason: 'Mudou de laboratorio',
        },
      ],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });

    renderPage();

    expect(within(await screen.findByRole('table')).getByText('Inativo')).toBeInTheDocument();
  });
});
