import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Doctor,
  DoctorInteraction,
  DoctorTimelineInteraction,
  DoctorTimelineResponse,
  DoctorTimelineVisit,
} from '@crm-lab/shared';
import { ApiError } from '@/api/client';
import { conversationsApi } from '@/api/conversations';
import { doctorsApi } from '@/api/doctors';
import { visitsApi } from '@/api/visits';
import { useAuthStore } from '@/stores/auth.store';
import { ToastProvider } from '@/components/ui';
import DoctorProfile from './DoctorProfile';
import { buildDoctor } from '@/test/doctor-fixtures';

/**
 * Ficha do médico — `/visitation/doctors/:id` (CRMLAB-89, D-261). A API é
 * mockada no nível de `doctorsApi`, então o que a tela manda é o que chegaria
 * ao backend.
 */
vi.mock('@/api/doctors', () => ({
  doctorsApi: {
    list: vi.fn(),
    get: vi.fn(),
    revenue: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    inactivate: vi.fn(),
    reactivate: vi.fn(),
    timeline: vi.fn(),
    createInteraction: vi.fn(),
    updateInteraction: vi.fn(),
    deleteInteraction: vi.fn(),
    createComment: vi.fn(),
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
    specialties: vi.fn(),
    createSpecialty: vi.fn(),
  },
}));

vi.mock('@/api/visits', () => ({
  visitsApi: { updateReport: vi.fn(), downloadAttachment: vi.fn() },
}));

vi.mock('@/api/conversations', () => ({
  conversationsApi: { assignees: vi.fn() },
}));

const getMock = vi.mocked(doctorsApi.get);
const timelineMock = vi.mocked(doctorsApi.timeline);
const revenueMock = vi.mocked(doctorsApi.revenue);
const createInteractionMock = vi.mocked(doctorsApi.createInteraction);
const updateInteractionMock = vi.mocked(doctorsApi.updateInteraction);
const deleteInteractionMock = vi.mocked(doctorsApi.deleteInteraction);
const assigneesMock = vi.mocked(conversationsApi.assignees);
const specialtiesMock = vi.mocked(doctorsApi.specialties);
const createCommentMock = vi.mocked(doctorsApi.createComment);
const updateCommentMock = vi.mocked(doctorsApi.updateComment);
const deleteCommentMock = vi.mocked(doctorsApi.deleteComment);
const updateReportMock = vi.mocked(visitsApi.updateReport);
const downloadAttachmentMock = vi.mocked(visitsApi.downloadAttachment);

const julia: Doctor = buildDoctor({
  id: 'doc-1',
  name: 'Dra. Júlia Costa',
  crm: '12345',
  crmUf: 'SC',
  specialty: 'Ginecologia',
  clinic: 'Clínica Vida',
  address: 'Rua das Flores, 10',
  phone: '(48) 99999-0000',
  email: 'julia@clinica.com',
  secretaryName: 'Marta',
  contactName: 'Marta',
  visitPreference: 'Terças à tarde',
  notes: 'Prefere material impresso',
  responsible: { id: 'u-ana', name: 'Ana Gestora' },
  isActive: true,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
});

const visita: DoctorTimelineVisit = {
  kind: 'visit',
  id: 'visit-1',
  occurredAt: '2026-09-10T13:20:00.000Z',
  status: 'realizada',
  type: 'presencial',
  purpose: { id: 'p-visita', name: 'Visita', color: 'azul' },
  scheduledAt: '2026-09-10T13:00:00.000Z',
  checkInAt: '2026-09-10T13:20:00.000Z',
  checkOutAt: '2026-09-10T13:55:00.000Z',
  responsible: { id: 'u-bia', name: 'Bia Atendente' },
  statusReason: null,
  reportExcerpt: 'Apresentei o painel de tireoide',
  attachmentCount: 2,
  report: { presented: 'Apresentei o painel de tireoide', doctorFeedback: 'Gostou do prazo', objections: null },
  nextVisitDate: null,
  attachments: [
    {
      id: 'att-img',
      fileName: 'folder.jpg',
      mimeType: 'image/jpeg',
      byteSize: 1200,
      uploadedBy: { id: 'u-bia', name: 'Bia Atendente' },
      createdAt: '2026-09-10T14:00:00.000Z',
    },
    {
      id: 'att-pdf',
      fileName: 'tabela.pdf',
      mimeType: 'application/pdf',
      byteSize: 5400,
      uploadedBy: { id: 'u-bia', name: 'Bia Atendente' },
      createdAt: '2026-09-10T14:05:00.000Z',
    },
  ],
  comments: [],
};

const ligacao: DoctorTimelineInteraction = {
  kind: 'interaction',
  id: 'int-1',
  doctorId: 'doc-1',
  type: 'ligacao',
  occurredAt: '2026-09-12T18:00:00.000Z',
  description: 'Confirmou interesse no convênio',
  createdBy: { id: 'u-bia', name: 'Bia Atendente' },
  updatedBy: null,
  createdAt: '2026-09-12T18:05:00.000Z',
  updatedAt: '2026-09-12T18:05:00.000Z',
  comments: [],
};

function commentOf(id: string, author: { id: string; name: string }, body: string, editedAt: string | null = null) {
  return {
    id,
    itemKind: 'visit' as const,
    itemId: 'visit-1',
    body,
    author,
    createdAt: '2026-09-11T10:00:00.000Z',
    updatedAt: editedAt ?? '2026-09-11T10:00:00.000Z',
    editedAt,
  };
}

function loginAs(id: string, role: 'representative' | 'manager' | 'admin') {
  useAuthStore.setState({
    user: { id, email: `${id}@lab.test`, name: id, role, discountLimit: 15 },
  });
}

function hhmm(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

function page(items: DoctorTimelineResponse['items'], nextCursor: string | null = null): DoctorTimelineResponse {
  return { items, nextCursor };
}

function renderPage(path = '/visitation/doctors/doc-1') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/visitation/doctors/:id" element={<DoctorProfile />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** Itens do feed (filhos diretos da lista: anexos e comentários também são `li`). */
function feedItems(): HTMLElement[] {
  return Array.from(screen.getByTestId('doctor-timeline').children) as HTMLElement[];
}

function timeline() {
  return within(screen.getByTestId('doctor-timeline'));
}

describe('DoctorProfile (/visitation/doctors/:id)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMock.mockResolvedValue(julia);
    timelineMock.mockResolvedValue(page([ligacao, visita]));
    revenueMock.mockResolvedValue({
      matched: true, windowStart: '2025-11-24', windowEnd: '2026-11-24',
      requisitionCount: 31, requisitionValue: 7420.1, paidCount: 28, paidValue: 6980,
      lastRequisitionOn: '2026-11-20',
    });
    assigneesMock.mockResolvedValue({ assignees: [{ id: 'u-ana', name: 'Ana Gestora', role: 'manager' }] });
    specialtiesMock.mockResolvedValue({ specialties: [] });
    downloadAttachmentMock.mockRejectedValue(new Error('sem rede no teste'));
    loginAs('u-bia', 'representative');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mostra os dados do cadastro', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Dra. Júlia Costa' })).toBeInTheDocument();
    expect(screen.getByText('CRM 12345/SC · Ginecologia')).toBeInTheDocument();
    expect(screen.getByText('Clínica Vida')).toBeInTheDocument();
    expect(screen.getByText('Terças à tarde')).toBeInTheDocument();
    expect(screen.getByText('Ana Gestora')).toBeInTheDocument();
    expect(screen.getByText('Prefere material impresso')).toBeInTheDocument();
    expect(getMock).toHaveBeenCalledWith('doc-1');
  });

  it('faturamento do LIS em 12 meses (CRMLAB-198, D-336)', async () => {
    renderPage();

    const section = await screen.findByRole('region', { name: 'Faturamento (LIS) — últimos 12 meses' });
    expect(within(section).getByText('31')).toBeInTheDocument();
    expect(within(section).getByText(/Última requisição em 20\/11\/2026/)).toBeInTheDocument();
    expect(within(section).getByText(/Base da curva ABC/)).toBeInTheDocument();
    expect(revenueMock).toHaveBeenCalledWith('doc-1');
  });

  it('faturamento sem CRM no cadastro explica o vínculo e oferece editar', async () => {
    revenueMock.mockResolvedValue({
      matched: false, windowStart: '2025-11-24', windowEnd: '2026-11-24',
      requisitionCount: 0, requisitionValue: 0, paidCount: 0, paidValue: 0, lastRequisitionOn: null,
    });
    renderPage();

    const section = await screen.findByRole('region', { name: 'Faturamento (LIS)' });
    expect(within(section).getByText(/ligado ao médico pelo CRM \+ UF/)).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Editar' })).toBeInTheDocument();
  });

  it('linha do tempo com visita e registro manual, na ordem do servidor', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('doctor-timeline')).toBeInTheDocument());
    expect(timelineMock).toHaveBeenCalledWith('doc-1', { limit: 20 });

    const itens = feedItems();
    expect(itens).toHaveLength(2);
    expect(within(itens[0] as HTMLElement).getByText('Ligação')).toBeInTheDocument();
    expect(within(itens[0] as HTMLElement).getByText('Confirmou interesse no convênio')).toBeInTheDocument();
    expect(within(itens[0] as HTMLElement).getByText('Registrado por Bia Atendente')).toBeInTheDocument();

    const visitaItem = within(itens[1] as HTMLElement);
    expect(visitaItem.getByText('Visita')).toBeInTheDocument();
    expect(visitaItem.getByText('Realizada')).toBeInTheDocument();
    expect(visitaItem.getByText('Bia Atendente')).toBeInTheDocument();
    expect(visitaItem.getByText('· Presencial')).toBeInTheDocument();
    expect(visitaItem.getByTestId('visit-check-line')).toHaveTextContent(
      `Check-in às ${hhmm('2026-09-10T13:20:00.000Z')} de 10/09 · Check-out às ${hhmm('2026-09-10T13:55:00.000Z')} de 10/09 · 35 min`,
    );
    // Relato completo com rótulos; campo vazio (objeções) não aparece.
    expect(visitaItem.getByText('O que foi apresentado')).toBeInTheDocument();
    expect(visitaItem.getByText('Apresentei o painel de tireoide')).toBeInTheDocument();
    expect(visitaItem.getByText('Feedback do médico')).toBeInTheDocument();
    expect(visitaItem.getByText('Gostou do prazo')).toBeInTheDocument();
    expect(visitaItem.queryByText('Objeções')).not.toBeInTheDocument();
    // Anexos: imagem (miniatura; sem download no teste cai no ícone) e PDF com nome.
    expect(visitaItem.getByRole('button', { name: 'Abrir folder.jpg' })).toBeInTheDocument();
    expect(visitaItem.getByRole('button', { name: 'Abrir tabela.pdf' })).toHaveTextContent('tabela.pdf');
    expect(visitaItem.getByRole('link', { name: 'Abrir visita' })).toHaveAttribute(
      'href',
      '/visitation/agenda?visit=visit-1',
    );
  });

  it('"Carregar mais" pede a próxima página pelo cursor e acumula', async () => {
    const outra: DoctorTimelineInteraction = { ...ligacao, id: 'int-2', type: 'email', description: 'Mandou o folder' };
    timelineMock
      .mockResolvedValueOnce(page([ligacao], 'cursor-1'))
      .mockResolvedValueOnce(page([outra]));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Carregar mais' }));

    await waitFor(() => expect(timeline().getAllByRole('listitem')).toHaveLength(2));
    expect(timelineMock).toHaveBeenLastCalledWith('doc-1', { limit: 20, cursor: 'cursor-1' });
    expect(timeline().getByText('Mandou o folder')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).not.toBeInTheDocument();
  });

  it('sem nada: estado vazio explica de onde vêm os itens', async () => {
    timelineMock.mockResolvedValue(page([]));
    renderPage();
    expect(await screen.findByText('Nenhuma interação ainda')).toBeInTheDocument();
  });

  it('registra interação: tipo, data/hora local em ISO e descrição sem espaço', async () => {
    const created: DoctorInteraction = { ...ligacao, id: 'int-9', type: 'whatsapp' };
    createInteractionMock.mockResolvedValue(created);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '+ Registrar interação' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.selectOptions(dialog.getByLabelText('Tipo'), 'whatsapp');
    await user.clear(dialog.getByLabelText('Data'));
    await user.type(dialog.getByLabelText('Data'), '2026-10-02');
    await user.clear(dialog.getByLabelText('Hora'));
    await user.type(dialog.getByLabelText('Hora'), '14:30');
    await user.type(dialog.getByLabelText('Descrição'), '  Mandou a tabela de exames  ');
    await user.click(dialog.getByRole('button', { name: 'Registrar' }));

    await waitFor(() => expect(createInteractionMock).toHaveBeenCalledTimes(1));
    expect(createInteractionMock).toHaveBeenCalledWith('doc-1', {
      type: 'whatsapp',
      occurredAt: new Date('2026-10-02T14:30:00').toISOString(),
      description: 'Mandou a tabela de exames',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('descrição vazia não sai da tela', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '+ Registrar interação' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.click(dialog.getByRole('button', { name: 'Registrar' }));

    expect(await dialog.findByText('Descreva a interação')).toBeInTheDocument();
    expect(createInteractionMock).not.toHaveBeenCalled();
  });

  it('erro de campo do servidor aparece no campo (data no futuro)', async () => {
    createInteractionMock.mockRejectedValue(
      new ApiError('VALIDATION_ERROR', 'Dados inválidos', 400, {
        fields: { occurredAt: 'A data não pode ser no futuro' },
      }),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '+ Registrar interação' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Descrição'), 'Ligação');
    await user.click(dialog.getByRole('button', { name: 'Registrar' }));

    expect(await dialog.findByText('A data não pode ser no futuro')).toBeInTheDocument();
  });

  it('edita um registro já preenchido', async () => {
    updateInteractionMock.mockResolvedValue({ ...ligacao, description: 'Texto novo' });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Editar registro de Ligação' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Editar registro' }));
    expect(dialog.getByLabelText('Descrição')).toHaveValue('Confirmou interesse no convênio');
    await user.clear(dialog.getByLabelText('Descrição'));
    await user.type(dialog.getByLabelText('Descrição'), 'Texto novo');
    await user.click(dialog.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(updateInteractionMock).toHaveBeenCalledTimes(1));
    expect(updateInteractionMock).toHaveBeenCalledWith('doc-1', 'int-1', {
      type: 'ligacao',
      occurredAt: '2026-09-12T18:00:00.000Z',
      description: 'Texto novo',
    });
  });

  it('exclui só depois de confirmar', async () => {
    deleteInteractionMock.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const user = userEvent.setup();
    renderPage();

    const excluir = await screen.findByRole('button', { name: 'Excluir registro de Ligação' });
    await user.click(excluir);
    expect(deleteInteractionMock).not.toHaveBeenCalled();

    await user.click(excluir);
    await waitFor(() => expect(deleteInteractionMock).toHaveBeenCalledWith('doc-1', 'int-1'));
    expect(confirmSpy).toHaveBeenCalledTimes(2);
  });

  it('médico de outro laboratório: "não encontrado", sem linha do tempo', async () => {
    getMock.mockRejectedValue(new ApiError('NOT_FOUND', 'Não encontrado', 404));
    renderPage();

    expect(await screen.findByText('Médico não encontrado')).toBeInTheDocument();
    expect(timelineMock).not.toHaveBeenCalled();
  });

  // --- CRMLAB-192 (D-332): feed ---

  it('relato longo aparece cortado com "Ver mais", que expande e recolhe', async () => {
    const longo = Array.from({ length: 6 }, (_, i) => `Linha ${i + 1} do relato`).join('\n');
    timelineMock.mockResolvedValue(page([{ ...visita, report: { presented: longo, doctorFeedback: null, objections: null } }]));
    const user = userEvent.setup();
    renderPage();

    const verMais = await screen.findByRole('button', { name: 'Ver mais' });
    const campo = screen.getByText(/Linha 1 do relato/);
    expect(campo).toHaveClass('line-clamp-4');
    await user.click(verMais);
    expect(campo).not.toHaveClass('line-clamp-4');
    await user.click(screen.getByRole('button', { name: 'Ver menos' }));
    expect(campo).toHaveClass('line-clamp-4');
  });

  it('relato curto não tem "Ver mais"', async () => {
    renderPage();
    await screen.findByTestId('doctor-timeline');
    expect(screen.queryByRole('button', { name: 'Ver mais' })).not.toBeInTheDocument();
  });

  it('filtro por tipo pede ao servidor só aquele tipo', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('doctor-timeline');
    expect(screen.getByRole('radio', { name: 'Tudo' })).toHaveAttribute('aria-checked', 'true');

    timelineMock.mockResolvedValue(page([visita]));
    await user.click(screen.getByRole('radio', { name: 'Visitas' }));
    await waitFor(() => expect(timelineMock).toHaveBeenLastCalledWith('doc-1', { limit: 20, types: ['visita'] }));
    expect(screen.getByRole('radio', { name: 'Visitas' })).toHaveAttribute('aria-checked', 'true');

    timelineMock.mockResolvedValue(page([]));
    await user.click(screen.getByRole('radio', { name: 'WhatsApp' }));
    await waitFor(() => expect(timelineMock).toHaveBeenLastCalledWith('doc-1', { limit: 20, types: ['whatsapp'] }));
    expect(await screen.findByText('Nada deste tipo')).toBeInTheDocument();

    for (const label of ['Ligações', 'E-mail']) expect(screen.getByRole('radio', { name: label })).toBeInTheDocument();
  });

  it('edita o relato pela ficha mandando só o que mudou', async () => {
    updateReportMock.mockResolvedValue({ id: 'visit-1' } as Awaited<ReturnType<typeof visitsApi.updateReport>>);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Editar relato' }));
    const editor = within(screen.getByTestId('visit-report-editor'));
    expect(editor.getByLabelText('O que foi apresentado')).toHaveValue('Apresentei o painel de tireoide');
    await user.type(editor.getByLabelText('Objeções'), '  Preço alto ');
    await user.click(editor.getByRole('button', { name: 'Salvar relato' }));

    await waitFor(() => expect(updateReportMock).toHaveBeenCalledWith('visit-1', { objections: 'Preço alto' }));
    await waitFor(() => expect(screen.queryByTestId('visit-report-editor')).not.toBeInTheDocument());
  });

  it('visita cancelada não oferece editar relato', async () => {
    timelineMock.mockResolvedValue(page([{ ...visita, status: 'cancelada', statusReason: 'Férias' }]));
    renderPage();
    await screen.findByText('Motivo: Férias');
    expect(screen.queryByRole('button', { name: 'Editar relato' })).not.toBeInTheDocument();
  });

  it('comenta num item da linha do tempo', async () => {
    createCommentMock.mockResolvedValue(commentOf('c-new', { id: 'u-bia', name: 'Bia Atendente' }, 'Ligou de novo?'));
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('doctor-timeline');

    const itens = feedItems();
    const ligacaoItem = within(itens[0] as HTMLElement);
    expect(ligacaoItem.getByRole('button', { name: 'Comentar' })).toBeDisabled();
    await user.type(ligacaoItem.getByLabelText('Escreva um comentário'), '  Ligou de novo?  ');
    await user.click(ligacaoItem.getByRole('button', { name: 'Comentar' }));

    await waitFor(() =>
      expect(createCommentMock).toHaveBeenCalledWith('doc-1', { itemKind: 'interaction', itemId: 'int-1', body: 'Ligou de novo?' }),
    );
  });

  it('só o autor edita o comentário; mostra "(editado)"', async () => {
    updateCommentMock.mockResolvedValue(commentOf('c-1', { id: 'u-bia', name: 'Bia Atendente' }, 'Texto corrigido'));
    timelineMock.mockResolvedValue(
      page([
        {
          ...visita,
          comments: [
            commentOf('c-1', { id: 'u-bia', name: 'Bia Atendente' }, 'Manda o material'),
            commentOf('c-2', { id: 'u-ana', name: 'Ana Gestora' }, 'Combinado', '2026-09-11T11:00:00.000Z'),
          ],
        },
      ]),
    );
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Manda o material');
    expect(screen.getByText(/\(editado\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Editar comentário de Ana Gestora' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Excluir comentário de Ana Gestora' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Editar comentário de Bia Atendente' }));
    const campo = screen.getByLabelText('Editar comentário');
    await user.clear(campo);
    await user.type(campo, 'Texto corrigido');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(updateCommentMock).toHaveBeenCalledWith('doc-1', 'c-1', { body: 'Texto corrigido' }));
  });

  it('exclui o próprio comentário depois de confirmar; o admin exclui de colega, o gestor não', async () => {
    deleteCommentMock.mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    timelineMock.mockResolvedValue(
      page([{ ...visita, comments: [commentOf('c-1', { id: 'u-bia', name: 'Bia Atendente' }, 'Manda o material')] }]),
    );
    const user = userEvent.setup();
    const { unmount } = renderPage();

    await user.click(await screen.findByRole('button', { name: 'Excluir comentário de Bia Atendente' }));
    await waitFor(() => expect(deleteCommentMock).toHaveBeenCalledWith('doc-1', 'c-1'));
    unmount();

    loginAs('u-ana', 'manager');
    const gestor = renderPage();
    await screen.findByText('Manda o material');
    expect(screen.queryByRole('button', { name: 'Excluir comentário de Bia Atendente' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Editar comentário de Bia Atendente' })).not.toBeInTheDocument();
    gestor.unmount();

    loginAs('u-davi', 'admin');
    renderPage();
    expect(await screen.findByRole('button', { name: 'Excluir comentário de Bia Atendente' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Editar comentário de Bia Atendente' })).not.toBeInTheDocument();
  });


  // --- CRMLAB-188 (D-328): ficha em seções ---

  it('ficha em seções, com WhatsApp clicável, horário estruturado, endereço e secretária', async () => {
    getMock.mockResolvedValue({
      ...julia,
      birthDay: 14,
      birthMonth: 3,
      birthYear: 1980,
      acceptsPrivate: true,
      monthlyConsultations: 120,
      monthlyPrivateConsultations: 40,
      consultationFee: 350,
      visitHours: [{ weekdays: [2, 4], start: '13:30', end: '15:00' }],
      isPartner: true,
      partnerSince: '2025-03-01',
      partnershipNotes: 'Indica check-up',
      addressZip: '88701100',
      addressStreet: 'Rua Altamiro Guimarães',
      addressNumber: '100',
      addressCity: 'Tubarão',
      addressState: 'SC',
      secretaryName: 'Marta',
      secretaryBirthDay: 2,
      secretaryBirthMonth: 8,
      secretaryPhone: '(48) 98888-7777',
      secretaryNotes: 'Gosta de chocolate',
      abcClass: 'B',
      abcBaseValue: 900,
      abcCalculatedAt: '2026-11-21T09:00:00.000Z',
    });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Dra. Júlia Costa' })).toBeInTheDocument();

    for (const title of ['Dados do médico', 'Clínica', 'Horário para representante', 'Parceria', 'Endereço', 'Secretária']) {
      expect(screen.getByRole('region', { name: title })).toBeInTheDocument();
    }
    const dados = within(screen.getByRole('region', { name: 'Dados do médico' }));
    expect(dados.getByText('14/03/1980')).toBeInTheDocument();
    expect(dados.getByRole('link', { name: 'Abrir WhatsApp de Dra. Júlia Costa' })).toHaveAttribute(
      'href',
      'https://wa.me/5548999990000',
    );

    const clinica = within(screen.getByRole('region', { name: 'Clínica' }));
    expect(clinica.getByText('Sim')).toBeInTheDocument();
    expect(clinica.getByText(/350,00/)).toBeInTheDocument();

    const horario = within(screen.getByRole('region', { name: 'Horário para representante' }));
    expect(horario.getByText('Ter, Qui · 13:30–15:00')).toBeInTheDocument();
    expect(horario.getByText('Terças à tarde')).toBeInTheDocument();

    expect(within(screen.getByRole('region', { name: 'Parceria' })).getByText('01/03/2025')).toBeInTheDocument();

    const endereco = within(screen.getByRole('region', { name: 'Endereço' }));
    expect(endereco.getByText(/Rua Altamiro Guimarães, 100/)).toBeInTheDocument();
    expect(endereco.getByText(/CEP 88701-100/)).toBeInTheDocument();
    // Com o estruturado preenchido, o texto antigo não aparece.
    expect(endereco.queryByText('Rua das Flores, 10')).not.toBeInTheDocument();

    const secretaria = within(screen.getByRole('region', { name: 'Secretária' }));
    expect(secretaria.getByText('Marta')).toBeInTheDocument();
    expect(secretaria.getByText('02/08')).toBeInTheDocument();
    expect(secretaria.getByRole('link', { name: 'Abrir WhatsApp de Marta' })).toHaveAttribute(
      'href',
      'https://wa.me/5548988887777',
    );

    expect(screen.getByLabelText(/^Curva ABC: B\./)).toBeInTheDocument();
  });

  it('sem endereço estruturado mostra o texto antigo; seção vazia diz "Não informado"', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Dra. Júlia Costa' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Endereço' })).getByText('Rua das Flores, 10')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Parceria' })).getByText('Não informado')).toBeInTheDocument();
    // Sem cálculo da curva ainda: sem selo.
    expect(screen.queryByLabelText(/^Curva ABC/)).not.toBeInTheDocument();
  });
});
