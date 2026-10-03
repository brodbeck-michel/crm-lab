import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doctor, ListDoctorsResponse } from '@crm-lab/shared';
import { ApiError } from '@/api/client';
import { conversationsApi } from '@/api/conversations';
import { doctorsApi } from '@/api/doctors';
import { ToastProvider } from '@/components/ui';
import Doctors from './Doctors';

/**
 * Médicos — `/visitation/doctors` (CRMLAB-86, D-255). A API é mockada no nível
 * de `doctorsApi` (não dos hooks), então os filtros que a tela monta são os que
 * chegariam ao `GET /doctors`.
 */
vi.mock('@/api/doctors', () => ({
  doctorsApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    inactivate: vi.fn(),
    reactivate: vi.fn(),
  },
}));

vi.mock('@/api/conversations', () => ({
  conversationsApi: { assignees: vi.fn() },
}));

const listMock = vi.mocked(doctorsApi.list);
const createMock = vi.mocked(doctorsApi.create);
const updateMock = vi.mocked(doctorsApi.update);
const inactivateMock = vi.mocked(doctorsApi.inactivate);
const assigneesMock = vi.mocked(conversationsApi.assignees);

const julia: Doctor = {
  id: 'doc-1',
  name: 'Dra. Júlia Costa',
  crm: '12345',
  crmUf: 'SC',
  specialty: 'Ginecologia',
  clinic: 'Clínica Vida',
  address: null,
  phone: '(48) 99999-0000',
  email: null,
  contactName: 'Marta',
  visitPreference: 'Terças à tarde',
  notes: null,
  responsible: { id: 'u-ana', name: 'Ana Gestora' },
  isActive: true,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
};

function listResponse(doctors: Doctor[] = [julia]): ListDoctorsResponse {
  return { doctors, pagination: { page: 1, limit: 20, total: doctors.length, totalPages: 1 } };
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <Doctors />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function table() {
  return within(screen.getByTestId('doctors-table'));
}

describe('Doctors (/visitation/doctors)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue(listResponse());
    assigneesMock.mockResolvedValue({
      assignees: [
        { id: 'u-ana', name: 'Ana Gestora', role: 'manager' },
        { id: 'u-bia', name: 'Bia Atendente', role: 'attendant' },
      ],
    });
  });

  it('lista com CRM/UF, clínica, responsável e status; cartões para o celular', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('doctors-table')).toBeInTheDocument());
    expect(table().getByText('Dra. Júlia Costa')).toBeInTheDocument();
    expect(table().getByText('12345/SC')).toBeInTheDocument();
    expect(table().getByText('Clínica Vida')).toBeInTheDocument();
    expect(table().getByText('Ana Gestora')).toBeInTheDocument();
    expect(table().getByText('Ativo')).toBeInTheDocument();

    const cards = within(screen.getByTestId('doctors-cards'));
    expect(cards.getByText('Dra. Júlia Costa')).toBeInTheDocument();
    expect(cards.getByText('CRM 12345/SC · Ginecologia')).toBeInTheDocument();
  });

  it('abre mostrando só ativos, página 1', async () => {
    renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(listMock).toHaveBeenLastCalledWith({ page: 1, limit: 20, active: true });
  });

  it('busca por nome/CRM, filtro de responsável e Inativos/Todos chegam ao GET /doctors', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    await user.type(screen.getByLabelText('Buscar médico'), '12345');
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({ page: 1, limit: 20, active: true, search: '12345' }),
    );

    await waitFor(() => expect(screen.getByRole('option', { name: 'Bia Atendente' })).toBeInTheDocument());
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filtrar por responsável' }), 'u-bia');
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({
        page: 1,
        limit: 20,
        active: true,
        search: '12345',
        responsibleId: 'u-bia',
      }),
    );

    await user.click(screen.getByRole('tab', { name: 'Todos' }));
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({ page: 1, limit: 20, search: '12345', responsibleId: 'u-bia' }),
    );

    await user.click(screen.getByRole('tab', { name: 'Inativos' }));
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({
        page: 1,
        limit: 20,
        active: false,
        search: '12345',
        responsibleId: 'u-bia',
      }),
    );
  });

  it('lista vazia mostra o estado vazio', async () => {
    listMock.mockResolvedValue(listResponse([]));
    renderPage();
    expect(await screen.findByText('Nenhum médico encontrado')).toBeInTheDocument();
  });

  it('cadastra: CRM normalizado no servidor, campos vazios vão como null', async () => {
    const user = userEvent.setup({ delay: null });
    createMock.mockResolvedValue({ ...julia, id: 'doc-2', name: 'Dr. Novo' });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('doctors-table')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: '+ Novo médico' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Novo médico' }));
    await user.type(dialog.getByLabelText(/^Nome/), 'Dr. Novo');
    await user.type(dialog.getByLabelText(/^CRM/), '54321');
    await user.selectOptions(dialog.getByLabelText('UF do CRM'), 'PR');
    await user.type(dialog.getByLabelText('Especialidade'), 'Pediatria');
    await user.selectOptions(dialog.getByLabelText('Responsável pela carteira'), 'u-bia');
    await user.click(dialog.getByRole('button', { name: 'Cadastrar' }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock).toHaveBeenCalledWith({
      name: 'Dr. Novo',
      crm: '54321',
      crmUf: 'PR',
      specialty: 'Pediatria',
      clinic: null,
      address: null,
      phone: null,
      email: null,
      contactName: null,
      visitPreference: null,
      notes: null,
      responsibleId: 'u-bia',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('CRM sem UF é barrado no formulário, sem chamar a API', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('doctors-table')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: '+ Novo médico' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Novo médico' }));
    await user.type(dialog.getByLabelText(/^Nome/), 'Dr. Sem UF');
    await user.type(dialog.getByLabelText(/^CRM/), '111');
    await user.click(dialog.getByRole('button', { name: 'Cadastrar' }));

    expect(await dialog.findByText('Informe a UF do CRM')).toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('409 DOCTOR_CRM_ALREADY_EXISTS marca o CRM com o nome do médico existente e mantém o modal aberto', async () => {
    const user = userEvent.setup({ delay: null });
    createMock.mockRejectedValue(
      new ApiError('DOCTOR_CRM_ALREADY_EXISTS', 'Ja existe um medico com este CRM e UF neste laboratorio', 409, {
        crm: '12345',
        crmUf: 'SC',
        existingDoctor: { id: 'doc-1', name: 'Dra. Júlia Costa', isActive: false },
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByTestId('doctors-table')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: '+ Novo médico' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Novo médico' }));
    await user.type(dialog.getByLabelText(/^Nome/), 'Dr. Repetido');
    await user.type(dialog.getByLabelText(/^CRM/), '12.345');
    await user.selectOptions(dialog.getByLabelText('UF do CRM'), 'SC');
    await user.click(dialog.getByRole('button', { name: 'Cadastrar' }));

    expect(
      await dialog.findByText(
        'CRM já cadastrado para Dra. Júlia Costa (inativo). Reative o cadastro em vez de criar outro.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Novo médico' })).toBeInTheDocument();
  });

  it('edita: abre preenchido e envia PATCH com o id', async () => {
    const user = userEvent.setup({ delay: null });
    updateMock.mockResolvedValue({ ...julia, specialty: 'Obstetrícia' });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('doctors-table')).toBeInTheDocument());

    await user.click(table().getByRole('button', { name: 'Editar' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Editar médico' }));
    expect(dialog.getByLabelText(/^Nome/)).toHaveValue('Dra. Júlia Costa');
    expect(dialog.getByLabelText('UF do CRM')).toHaveValue('SC');

    const specialty = dialog.getByLabelText('Especialidade');
    await user.clear(specialty);
    await user.type(specialty, 'Obstetrícia');
    await user.click(dialog.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(updateMock).toHaveBeenCalledWith(
      'doc-1',
      expect.objectContaining({ name: 'Dra. Júlia Costa', specialty: 'Obstetrícia', responsibleId: 'u-ana' }),
    );
  });

  it('inativar chama POST /doctors/:id/inactivate e recarrega a lista', async () => {
    const user = userEvent.setup({ delay: null });
    inactivateMock.mockResolvedValue({ ...julia, isActive: false });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('doctors-table')).toBeInTheDocument());
    const callsBefore = listMock.mock.calls.length;

    await user.click(table().getByRole('button', { name: 'Inativar Dra. Júlia Costa' }));

    await waitFor(() => expect(inactivateMock).toHaveBeenCalledWith('doc-1'));
    await waitFor(() => expect(listMock.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(await screen.findByText('Médico inativado')).toBeInTheDocument();
  });
});
