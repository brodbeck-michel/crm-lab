import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doctor, ListDoctorsResponse } from '@crm-lab/shared';
import { ApiError } from '@/api/client';
import { conversationsApi } from '@/api/conversations';
import { doctorsApi } from '@/api/doctors';
import { lookupCep } from '@/api/viacep';
import { useAuthStore } from '@/stores/auth.store';
import { ToastProvider } from '@/components/ui';
import Doctors from './Doctors';
import { buildDoctor } from '@/test/doctor-fixtures';

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
    specialties: vi.fn(),
    createSpecialty: vi.fn(),
    recalculateAbc: vi.fn(),
  },
}));

vi.mock('@/api/viacep', () => ({ lookupCep: vi.fn() }));

vi.mock('@/api/conversations', () => ({
  conversationsApi: { assignees: vi.fn() },
}));

const listMock = vi.mocked(doctorsApi.list);
const createMock = vi.mocked(doctorsApi.create);
const updateMock = vi.mocked(doctorsApi.update);
const inactivateMock = vi.mocked(doctorsApi.inactivate);
const assigneesMock = vi.mocked(conversationsApi.assignees);
const specialtiesMock = vi.mocked(doctorsApi.specialties);
const createSpecialtyMock = vi.mocked(doctorsApi.createSpecialty);
const recalculateMock = vi.mocked(doctorsApi.recalculateAbc);
const lookupCepMock = vi.mocked(lookupCep);

/** Rótulo "Nome" do médico (não o "Nome da secretária"). */
const NAME_LABEL = /^Nome(?! da)/;

function asRole(role: 'representative' | 'manager' | 'admin') {
  useAuthStore.setState({
    user: { id: 'u-me', email: 'me@lab.test', name: 'Eu', role, discountLimit: 5 },
  });
}

const julia: Doctor = buildDoctor({
  id: 'doc-1',
  name: 'Dra. Júlia Costa',
  crm: '12345',
  crmUf: 'SC',
  specialtyId: 'sp-gin',
  specialty: 'Ginecologia',
  clinic: 'Clínica Vida',
  address: null,
  phone: '(48) 99999-0000',
  email: null,
  secretaryName: 'Marta',
  contactName: 'Marta',
  visitPreference: 'Terças à tarde',
  notes: null,
  responsible: { id: 'u-ana', name: 'Ana Gestora' },
  isActive: true,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
});

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
        { id: 'u-bia', name: 'Bia Representante', role: 'representative' },
      ],
    });
    specialtiesMock.mockResolvedValue({
      specialties: [
        { id: 'sp-gin', name: 'Ginecologia', isActive: true },
        { id: 'sp-ped', name: 'Pediatria', isActive: true },
        { id: 'sp-old', name: 'Antiga', isActive: false },
      ],
    });
    lookupCepMock.mockResolvedValue(null);
    // Gestor vê tudo e escolhe o responsável (D-329); o recorte do representante tem spec própria.
    asRole('manager');
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
    // O nome abre a ficha do médico (CRMLAB-89).
    expect(table().getByRole('link', { name: 'Dra. Júlia Costa' })).toHaveAttribute('href', '/visitation/doctors/doc-1');
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

    await waitFor(() => expect(screen.getByRole('option', { name: 'Bia Representante' })).toBeInTheDocument());
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
    await user.type(dialog.getByLabelText(NAME_LABEL), 'Dr. Novo');
    await user.type(dialog.getByLabelText(/^CRM/), '54321');
    await user.selectOptions(dialog.getByLabelText('UF do CRM'), 'PR');
    await waitFor(() => expect(dialog.getByRole('option', { name: 'Pediatria' })).toBeInTheDocument());
    // Inativa não é oferecida para cadastro novo.
    expect(dialog.queryByRole('option', { name: /Antiga/ })).not.toBeInTheDocument();
    await user.selectOptions(dialog.getByLabelText('Especialidade'), 'sp-ped');
    await user.selectOptions(dialog.getByLabelText('Responsável pela carteira'), 'u-bia');
    await user.click(dialog.getByRole('button', { name: 'Cadastrar' }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock).toHaveBeenCalledWith({
      name: 'Dr. Novo',
      crm: '54321',
      crmUf: 'PR',
      specialtyId: 'sp-ped',
      birthDay: null,
      birthMonth: null,
      birthYear: null,
      phone: null,
      email: null,
      responsibleId: 'u-bia',
      notes: null,
      clinic: null,
      acceptsPrivate: null,
      monthlyConsultations: null,
      monthlyPrivateConsultations: null,
      consultationFee: null,
      visitHours: [],
      visitPreference: null,
      isPartner: false,
      partnerSince: null,
      partnershipNotes: null,
      addressZip: null,
      addressStreet: null,
      addressNumber: null,
      addressComplement: null,
      addressDistrict: null,
      addressCity: null,
      addressState: null,
      secretaryName: null,
      secretaryBirthDay: null,
      secretaryBirthMonth: null,
      secretaryBirthYear: null,
      secretaryPhone: null,
      secretaryNotes: null,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('CRM sem UF é barrado no formulário, sem chamar a API', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('doctors-table')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: '+ Novo médico' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Novo médico' }));
    await user.type(dialog.getByLabelText(NAME_LABEL), 'Dr. Sem UF');
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
    await user.type(dialog.getByLabelText(NAME_LABEL), 'Dr. Repetido');
    await user.type(dialog.getByLabelText(/^CRM/), '12.345');
    await user.selectOptions(dialog.getByLabelText('UF do CRM'), 'SC');
    // Responsável é obrigatório no cadastro (D-329).
    await waitFor(() => expect(dialog.getByRole('option', { name: 'Ana Gestora' })).toBeInTheDocument());
    await user.selectOptions(dialog.getByLabelText('Responsável pela carteira'), 'u-ana');
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
    updateMock.mockResolvedValue({ ...julia, specialtyId: 'sp-ped', specialty: 'Pediatria' });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('doctors-table')).toBeInTheDocument());

    await user.click(table().getByRole('button', { name: 'Editar' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Editar médico' }));
    expect(dialog.getByLabelText(NAME_LABEL)).toHaveValue('Dra. Júlia Costa');
    expect(dialog.getByLabelText('UF do CRM')).toHaveValue('SC');

    expect(dialog.getByLabelText('Nome da secretária')).toHaveValue('Marta');
    expect(dialog.getByLabelText('Observação de horário')).toHaveValue('Terças à tarde');

    await waitFor(() => expect(dialog.getByRole('option', { name: 'Pediatria' })).toBeInTheDocument());
    await user.selectOptions(dialog.getByLabelText('Especialidade'), 'sp-ped');
    await user.click(dialog.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    const body = updateMock.mock.calls[0]?.[1];
    expect(updateMock.mock.calls[0]?.[0]).toBe('doc-1');
    expect(body).toEqual(
      expect.objectContaining({
        name: 'Dra. Júlia Costa',
        specialtyId: 'sp-ped',
        secretaryName: 'Marta',
        visitPreference: 'Terças à tarde',
        responsibleId: 'u-ana',
      }),
    );
    // Colunas antigas não entram mais no corpo (o schema é `.strict()`).
    expect(body).not.toHaveProperty('specialty');
    expect(body).not.toHaveProperty('contactName');
    expect(body).not.toHaveProperty('address');
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

  // --- CRMLAB-188 (D-328): cadastro ampliado ---

  it('selo ABC na lista e filtros de especialidade e curva ABC chegam ao GET /doctors', async () => {
    const user = userEvent.setup({ delay: null });
    listMock.mockResolvedValue(
      listResponse([{ ...julia, abcClass: 'A', abcBaseValue: 1234.5, abcCalculatedAt: '2026-11-21T09:00:00.000Z' }]),
    );
    renderPage();
    await waitFor(() => expect(screen.getByTestId('doctors-table')).toBeInTheDocument());

    expect(table().getByLabelText(/^Curva ABC: A\. Base: R\$\s?1\.234,50 nos últimos 12 meses, calculado em 21\/11$/)).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('option', { name: 'Pediatria' })).toBeInTheDocument());
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filtrar por especialidade' }), 'sp-ped');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filtrar por curva ABC' }), 'B');
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({ page: 1, limit: 20, active: true, specialtyId: 'sp-ped', abcClass: 'B' }),
    );
  });

  it('[Recalcular curva ABC] só para gestor/admin', async () => {
    asRole('representative');
    renderPage();
    await waitFor(() => expect(screen.getByTestId('doctors-table')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Recalcular curva ABC' })).not.toBeInTheDocument();
  });

  it('gestor recalcula a curva ABC e vê as contagens', async () => {
    const user = userEvent.setup({ delay: null });
    asRole('manager');
    recalculateMock.mockResolvedValue({
      calculatedAt: '2026-11-21T09:00:00.000Z',
      windowStart: '2025-11-21T09:00:00.000Z',
      doctors: 5,
      counts: { A: 1, B: 1, C: 3 },
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('doctors-table')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Recalcular curva ABC' }));
    await waitFor(() => expect(recalculateMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Curva ABC recalculada: 1 A · 1 B · 3 C')).toBeInTheDocument();
  });

  it('formulário barra aniversário incompleto, particulares acima do total e faixa sem dia', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('doctors-table')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: '+ Novo médico' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Novo médico' }));
    await user.type(dialog.getByLabelText(NAME_LABEL), 'Dr. Validado');
    await user.type(dialog.getAllByLabelText('Aniversário — dia')[0] as HTMLElement, '14');
    await user.type(dialog.getByLabelText('Consultas/mês'), '10');
    await user.type(dialog.getByLabelText('Particulares/mês'), '20');
    await user.click(dialog.getByRole('button', { name: '+ faixa' }));
    await user.click(dialog.getByRole('button', { name: 'Cadastrar' }));

    expect(await dialog.findByText('Informe dia e mês juntos')).toBeInTheDocument();
    expect(dialog.getByText('Particulares não pode passar do total')).toBeInTheDocument();
    expect(dialog.getByText('Escolha ao menos um dia em cada faixa')).toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('horário estruturado, parceria, clínica e secretária vão no corpo', async () => {
    const user = userEvent.setup({ delay: null });
    createMock.mockResolvedValue({ ...julia, id: 'doc-3' });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('doctors-table')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: '+ Novo médico' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Novo médico' }));
    await user.type(dialog.getByLabelText(NAME_LABEL), 'Dr. Completo');
    // Responsável é obrigatório no cadastro (D-329).
    await waitFor(() => expect(dialog.getByRole('option', { name: 'Ana Gestora' })).toBeInTheDocument());
    await user.selectOptions(dialog.getByLabelText('Responsável pela carteira'), 'u-ana');
    await user.type(dialog.getAllByLabelText('Aniversário — dia')[0] as HTMLElement, '29');
    await user.type(dialog.getAllByLabelText('Mês')[0] as HTMLElement, '2');
    await user.selectOptions(dialog.getByLabelText('Atende particular'), 'yes');
    await user.type(dialog.getByLabelText('Consultas/mês'), '100');
    await user.type(dialog.getByLabelText('Particulares/mês'), '40');
    await user.type(dialog.getByLabelText('Valor da consulta (R$)'), '350,50');

    await user.click(dialog.getByRole('button', { name: '+ faixa' }));
    const row = within(dialog.getByTestId('visit-hours-row'));
    await user.click(row.getByLabelText('Qui'));
    await user.click(row.getByLabelText('Ter'));
    await user.type(row.getByLabelText('Início'), '13:30');
    await user.type(row.getByLabelText('Fim'), '15:00');

    await user.click(dialog.getByRole('switch', { name: 'É parceiro' }));
    await user.type(dialog.getByLabelText('Parceiro desde'), '2025-03-01');
    await user.type(dialog.getByLabelText('Nome da secretária'), 'Marta');
    await user.type(dialog.getByLabelText('Telefone/WhatsApp da secretária'), '48 98888-7777');
    await user.click(dialog.getByRole('button', { name: 'Cadastrar' }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Dr. Completo',
        birthDay: 29,
        birthMonth: 2,
        birthYear: null,
        acceptsPrivate: true,
        monthlyConsultations: 100,
        monthlyPrivateConsultations: 40,
        consultationFee: 350.5,
        visitHours: [{ weekdays: [2, 4], start: '13:30', end: '15:00' }],
        isPartner: true,
        partnerSince: '2025-03-01',
        secretaryName: 'Marta',
        secretaryPhone: '48 98888-7777',
      }),
    );
  });

  it('CEP com 8 dígitos preenche pelo ViaCEP só os campos vazios', async () => {
    const user = userEvent.setup({ delay: null });
    lookupCepMock.mockResolvedValue({
      street: 'Rua Altamiro Guimarães',
      district: 'Centro',
      city: 'Tubarão',
      state: 'SC',
      complement: '',
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('doctors-table')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: '+ Novo médico' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Novo médico' }));
    await user.type(dialog.getByLabelText('Bairro'), 'Vila Moema');
    await user.type(dialog.getByLabelText(/^CEP/), '88701-100');

    await waitFor(() => expect(dialog.getByLabelText('Logradouro')).toHaveValue('Rua Altamiro Guimarães'));
    expect(lookupCepMock).toHaveBeenCalledWith('88701100');
    expect(dialog.getByLabelText('Cidade')).toHaveValue('Tubarão');
    expect(dialog.getByLabelText('UF')).toHaveValue('SC');
    // O que já foi digitado fica.
    expect(dialog.getByLabelText('Bairro')).toHaveValue('Vila Moema');
  });

  it('CEP que o ViaCEP não acha não trava nada: a pessoa digita', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('doctors-table')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: '+ Novo médico' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Novo médico' }));
    await user.type(dialog.getByLabelText(/^CEP/), '00000000');
    await waitFor(() => expect(lookupCepMock).toHaveBeenCalled());
    expect(dialog.getByLabelText('Logradouro')).toHaveValue('');
  });

  it('"+ nova especialidade" só para gestor/admin; cria e já seleciona', async () => {
    const user = userEvent.setup({ delay: null });
    asRole('admin');
    createSpecialtyMock.mockResolvedValue({ id: 'sp-new', name: 'Medicina do Sono', isActive: true });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('doctors-table')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: '+ Novo médico' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Novo médico' }));
    await user.click(dialog.getByRole('button', { name: '+ nova especialidade' }));
    await user.type(dialog.getByLabelText('Nova especialidade'), 'Medicina do Sono');
    specialtiesMock.mockResolvedValue({
      specialties: [
        { id: 'sp-gin', name: 'Ginecologia', isActive: true },
        { id: 'sp-new', name: 'Medicina do Sono', isActive: true },
      ],
    });
    await user.click(dialog.getByRole('button', { name: 'Criar' }));

    await waitFor(() => expect(createSpecialtyMock).toHaveBeenCalledWith({ name: 'Medicina do Sono' }));
    await waitFor(() => expect(dialog.getByLabelText('Especialidade')).toHaveValue('sp-new'));
  });

  it('representante não vê "+ nova especialidade"', async () => {
    const user = userEvent.setup({ delay: null });
    asRole('representative');
    renderPage();
    await waitFor(() => expect(screen.getByTestId('doctors-table')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '+ Novo médico' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Novo médico' }));
    expect(dialog.queryByRole('button', { name: '+ nova especialidade' })).not.toBeInTheDocument();
  });
});
