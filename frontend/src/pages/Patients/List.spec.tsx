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
    expect(listMock).toHaveBeenCalledWith({ page: 1, limit: 20 });
  });

  it('busca por nome, CPF ou telefone no mesmo campo (debounce da SearchInput)', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await screen.findByText('João Santos');

    await user.type(screen.getByLabelText('Buscar paciente'), '48999991234');

    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1, search: '48999991234' }),
      ),
    );
  });

  it('mostra o estado vazio quando não há pacientes', async () => {
    listMock.mockResolvedValue({
      patients: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });

    renderPage();

    expect(await screen.findByText('Nenhum paciente encontrado')).toBeInTheDocument();
  });

  it('mostra o estado de erro quando a busca falha', async () => {
    listMock.mockRejectedValue(new ApiError('INTERNAL_ERROR', 'boom', 500));

    renderPage();

    expect(await screen.findByText('Não foi possível carregar os pacientes')).toBeInTheDocument();
  });
});
