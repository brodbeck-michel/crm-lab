import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser, Doctor, ListDoctorPortfoliosResponse } from '@crm-lab/shared';
import { conversationsApi } from '@/api/conversations';
import { doctorsApi } from '@/api/doctors';
import { ToastProvider } from '@/components/ui';
import { useAuthStore } from '@/stores';
import Portfolios from './Portfolios';
import { buildDoctor } from '@/test/doctor-fixtures';

/**
 * Carteiras — `/visitation/portfolios` (CRMLAB-189, D-329). A API é mockada no
 * nível de `doctorsApi`; o que a tela manda é o que chegaria ao servidor.
 */
vi.mock('@/api/doctors', () => ({
  doctorsApi: {
    list: vi.fn(),
    portfolios: vi.fn(),
    transfer: vi.fn(),
  },
}));

vi.mock('@/api/conversations', () => ({
  conversationsApi: { assignees: vi.fn() },
}));

const listMock = vi.mocked(doctorsApi.list);
const portfoliosMock = vi.mocked(doctorsApi.portfolios);
const transferMock = vi.mocked(doctorsApi.transfer);
const assigneesMock = vi.mocked(conversationsApi.assignees);

function doctor(id: string, name: string, responsible: Doctor['responsible']): Doctor {
  return buildDoctor({ id, name, crm: null, crmUf: null, specialty: null, clinic: null, responsible });
}

const portfolios: ListDoctorPortfoliosResponse = {
  portfolios: [
    { responsible: { id: 'u-carla', name: 'Carla Rep', role: 'representative' }, doctorCount: 2, activeDoctorCount: 2 },
    { responsible: { id: 'u-diego', name: 'Diego Rep', role: 'representative' }, doctorCount: 0, activeDoctorCount: 0 },
  ],
  unassigned: { doctorCount: 1, activeDoctorCount: 1 },
};

function login(): void {
  const user: AuthUser = { id: 'u-ana', email: 'ana@lab.com', name: 'Ana Gestora', role: 'manager', discountLimit: 30 };
  useAuthStore.setState({ user });
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <Portfolios />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Carteiras (/visitation/portfolios)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    login();
    portfoliosMock.mockResolvedValue(portfolios);
    listMock.mockImplementation(async (query = {}) => {
      const doctors = query.unassigned
        ? [doctor('d-3', 'Dr. Órfão', { id: 'u-bia', name: 'Bia Atendente' })]
        : query.responsibleId === 'u-carla'
          ? [
              doctor('d-1', 'Dra. Júlia', { id: 'u-carla', name: 'Carla Rep' }),
              doctor('d-2', 'Dr. Paulo', { id: 'u-carla', name: 'Carla Rep' }),
            ]
          : [];
      return { doctors, pagination: { page: 1, limit: 100, total: doctors.length, totalPages: 1 } };
    });
    assigneesMock.mockResolvedValue({
      assignees: [
        { id: 'u-ana', name: 'Ana Gestora', role: 'manager' },
        { id: 'u-carla', name: 'Carla Rep', role: 'representative' },
        { id: 'u-diego', name: 'Diego Rep', role: 'representative' },
        { id: 'u-bia', name: 'Bia Atendente', role: 'attendant' },
      ],
    });
    transferMock.mockResolvedValue({ transferredDoctors: 2, movedVisits: 1 });
  });

  it('lista cada carteira com o total e o balde "sem responsável"; sem corte ABC enquanto o servidor não manda', async () => {
    renderPage();
    const list = within(await screen.findByTestId('portfolio-list'));
    expect(list.getByText('Carla Rep')).toBeInTheDocument();
    expect(list.getByText('2 médicos · 2 ativos')).toBeInTheDocument();
    expect(list.getByText('Diego Rep')).toBeInTheDocument();
    expect(list.getByText('0 médicos · 0 ativos')).toBeInTheDocument();
    expect(list.getByText('Sem responsável / responsável inelegível')).toBeInTheDocument();
    expect(list.queryByText(/A \d+ · B/)).not.toBeInTheDocument();
  });

  it('mostra o corte A/B/C quando vier no shape (CRMLAB-188)', async () => {
    portfoliosMock.mockResolvedValue({
      ...portfolios,
      portfolios: [{ ...portfolios.portfolios[0]!, abc: { A: 1, B: 1, C: 0, unclassified: 0 } }],
    });
    renderPage();
    expect(await screen.findByText(/A 1 · B 1 · C 0/)).toBeInTheDocument();
  });

  it('clicar na carteira lista os médicos dela; o balde pede ?unassigned=true', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await user.click(await screen.findByText('Carla Rep'));
    const doctors = within(await screen.findByTestId('portfolio-doctors'));
    expect(doctors.getByText('Dra. Júlia')).toBeInTheDocument();
    expect(doctors.getByText('Dr. Paulo')).toBeInTheDocument();
    expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ responsibleId: 'u-carla' }));

    await user.click(screen.getByText('Sem responsável / responsável inelegível'));
    expect(await screen.findByText('Dr. Órfão')).toBeInTheDocument();
    expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ unassigned: true }));
  });

  it('transfere em lote para outro responsável elegível, levando as visitas futuras', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await user.click(await screen.findByText('Carla Rep'));
    await screen.findByTestId('portfolio-doctors');
    await user.click(screen.getByLabelText('Selecionar todos'));
    await user.click(screen.getByRole('button', { name: 'Transferir selecionados (2)' }));

    const dialog = within(await screen.findByRole('dialog'));
    const select = dialog.getByLabelText('Novo responsável');
    const options = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    // Dono atual e atendente ficam fora dos destinos.
    expect(options).toEqual(expect.arrayContaining(['Ana Gestora', 'Diego Rep']));
    expect(options).not.toContain('Carla Rep');
    expect(options).not.toContain('Bia Atendente');

    await user.selectOptions(select, 'u-diego');
    await user.click(dialog.getByLabelText(/Levar junto as visitas futuras/));
    await user.click(dialog.getByRole('button', { name: 'Transferir' }));

    await waitFor(() =>
      expect(transferMock).toHaveBeenCalledWith({
        doctorIds: ['d-1', 'd-2'],
        toUserId: 'u-diego',
        includeFutureVisits: true,
      }),
    );
    expect(await screen.findByText('2 médicos transferidos (1 visita)')).toBeInTheDocument();
  });

  it('sem destino escolhido não chama a API', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await user.click(await screen.findByText('Carla Rep'));
    await screen.findByTestId('portfolio-doctors');
    await user.click(screen.getByLabelText('Selecionar Dra. Júlia'));
    await user.click(screen.getByRole('button', { name: 'Transferir selecionados (1)' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.click(dialog.getByRole('button', { name: 'Transferir' }));
    expect(await dialog.findByText('Escolha o novo responsável')).toBeInTheDocument();
    expect(transferMock).not.toHaveBeenCalled();
  });
});
