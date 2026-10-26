import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListPatientsResponse, PatientDetail } from '@crm-lab/shared';
import { ApiError } from '@/api/client';
import { patientsApi } from '@/api/patients';
import { ToastProvider } from '@/components/ui';
import PatientsList from './List';

vi.mock('@/api/patients', () => ({
  patientsApi: {
    list: vi.fn(),
    create: vi.fn(),
  },
}));

const listMock = vi.mocked(patientsApi.list);
const createMock = vi.mocked(patientsApi.create);

const EMPTY: ListPatientsResponse = {
  patients: [],
  pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
};

const CREATED: PatientDetail = {
  id: 'p-new',
  phone: '+5548999991234',
  name: 'Maria Souza',
  email: null,
  birthDate: null,
  document: null,
  notes: null,
  tags: [],
  customFields: {},
  anonymizedAt: null,
  inactivatedAt: null,
  inactivationReason: null,
  createdAt: '2026-10-26T12:00:00Z',
  updatedAt: '2026-10-26T12:00:00Z',
  lastInteractionAt: null,
  conversationCount: 0,
  proposalCount: 0,
  canEdit: true,
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/patients']}>
          <Routes>
            <Route path="/patients" element={<PatientsList />} />
            <Route path="/patients/:id" element={<p>Ficha aberta</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function openModal() {
  await userEvent.click(await screen.findByRole('button', { name: 'Novo contato' }));
  return screen.findByRole('dialog', { name: 'Novo contato' });
}

/**
 * "Novo contato" (CRMLAB-121, D-287): cadastra nome + telefone antes da
 * primeira mensagem, valida o telefone antes de ir ao servidor, sugere o nono
 * dígito e, em telefone já cadastrado, aponta a ficha existente.
 */
describe('Pacientes — Novo contato (CRMLAB-121)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue(EMPTY);
  });

  it('cadastra com nome e telefone normalizado e abre a ficha', async () => {
    createMock.mockResolvedValue(CREATED);
    renderPage();
    const dialog = await openModal();

    await userEvent.type(within(dialog).getByLabelText('Nome'), 'Maria Souza');
    await userEvent.type(within(dialog).getByLabelText('Telefone (WhatsApp)'), '(48) 99999-1234');
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({ name: 'Maria Souza', phone: '+5548999991234' }),
    );
    expect(await screen.findByText('Ficha aberta')).toBeInTheDocument();
  });

  it('sem nome ou com telefone inválido não vai ao servidor', async () => {
    renderPage();
    const dialog = await openModal();

    await userEvent.type(within(dialog).getByLabelText('Telefone (WhatsApp)'), '1234');
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));

    expect(await within(dialog).findByText('Informe o nome')).toBeInTheDocument();
    expect(within(dialog).getByText(/Telefone inválido/)).toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('sugere o nono dígito no celular de 8 dígitos', async () => {
    renderPage();
    const dialog = await openModal();
    const field = within(dialog).getByLabelText('Telefone (WhatsApp)');

    await userEvent.type(field, '48 9999-1234');
    expect(within(dialog).getByRole('status')).toHaveTextContent(
      'Celular sem o 9? Sugestão: (48) 99999-1234',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Usar' }));
    expect(field).toHaveValue('(48) 99999-1234');
  });

  it('telefone já cadastrado: avisa e oferece abrir o contato existente', async () => {
    createMock.mockRejectedValue(
      new ApiError('CONFLICT', 'Conflito', 409, {
        reason: 'phone_already_in_use',
        patientId: 'p-old',
      }),
    );
    renderPage();
    const dialog = await openModal();

    await userEvent.type(within(dialog).getByLabelText('Nome'), 'Maria');
    await userEvent.type(within(dialog).getByLabelText('Telefone (WhatsApp)'), '48999991234');
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Este telefone já está cadastrado.',
    );
    expect(within(dialog).getByRole('link', { name: 'Abrir o contato' })).toHaveAttribute(
      'href',
      '/patients/p-old',
    );
  });
});
