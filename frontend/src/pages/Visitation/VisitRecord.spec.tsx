import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListVisitsResponse, VisitDetail } from '@crm-lab/shared';
import { conversationsApi } from '@/api/conversations';
import { doctorsApi } from '@/api/doctors';
import { visitsApi } from '@/api/visits';
import { ToastProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth.store';
import Agenda from './Agenda';

/**
 * Registro da visita no modal "Visita" da Agenda (CRMLAB-88, D-258):
 * check-in/out com um toque, relato com data de retorno, "Agendar retorno"
 * pré-preenchido e anexos. A API é mockada no nível de `visitsApi`.
 */
vi.mock('@/api/visits', () => ({
  visitsApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    reschedule: vi.fn(),
    cancel: vi.fn(),
    notReceived: vi.fn(),
    checkIn: vi.fn(),
    checkOut: vi.fn(),
    updateReport: vi.fn(),
    addAttachment: vi.fn(),
    deleteAttachment: vi.fn(),
    downloadAttachment: vi.fn(),
  },
}));

vi.mock('@/api/doctors', () => ({
  doctorsApi: { list: vi.fn() },
}));

vi.mock('@/api/conversations', () => ({
  conversationsApi: { assignees: vi.fn() },
}));

const getMock = vi.mocked(visitsApi.get);

const NOW = new Date(2026, 9, 7, 10, 0);

function visit(overrides: Partial<VisitDetail> = {}): VisitDetail {
  return {
    id: 'v-1',
    doctor: { id: 'doc-1', name: 'Dra. Júlia Costa', crm: '12345', crmUf: 'SC', specialty: 'Ginecologia', clinic: null, isActive: true },
    responsible: { id: 'u-ana', name: 'Ana Gestora' },
    scheduledAt: new Date(2026, 9, 6, 9, 30).toISOString(),
    type: 'online',
    agenda: null,
    status: 'agendada',
    statusReason: null,
    statusChangedAt: null,
    statusChangedBy: null,
    rescheduleCount: 0,
    createdBy: { id: 'u-bia', name: 'Bia Atendente' },
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    reschedules: [],
    checkInAt: null,
    checkInBy: null,
    checkOutAt: null,
    checkOutBy: null,
    nextVisitDate: null,
    attachmentCount: 0,
    report: { presented: null, doctorFeedback: null, objections: null },
    attachments: [],
    ...overrides,
  };
}

const checkedIn = (overrides: Partial<VisitDetail> = {}) =>
  visit({
    checkInAt: new Date(2026, 9, 6, 9, 35).toISOString(),
    checkInBy: { id: 'u-bia', name: 'Bia Atendente' },
    updatedAt: '2026-10-06T12:35:00.000Z',
    ...overrides,
  });

const realizada = (overrides: Partial<VisitDetail> = {}) =>
  checkedIn({
    status: 'realizada',
    checkOutAt: new Date(2026, 9, 6, 10, 20).toISOString(),
    checkOutBy: { id: 'u-bia', name: 'Bia Atendente' },
    statusChangedAt: new Date(2026, 9, 6, 10, 20).toISOString(),
    statusChangedBy: { id: 'u-bia', name: 'Bia Atendente' },
    updatedAt: '2026-10-06T13:20:00.000Z',
    ...overrides,
  });

const PDF_ATTACHMENT = {
  id: 'att-1',
  fileName: 'folder.pdf',
  mimeType: 'application/pdf',
  byteSize: 2048,
  uploadedBy: { id: 'u-bia', name: 'Bia Atendente' },
  createdAt: '2026-10-06T12:40:00.000Z',
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <Agenda />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** Celular: a visão por dia (CRMLAB-92) — é onde a visitadora toca. */
function mockMobile() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

async function openVisit(user: ReturnType<typeof userEvent.setup>) {
  // A visita é de terça (06/10); a tela abre no dia de hoje (quarta).
  await user.click(await screen.findByRole('tab', { name: /Terça, 06 de out\., com visitas/ }));
  const list = within(await screen.findByTestId('agenda-day-list'));
  await user.click(list.getByText('Dra. Júlia Costa'));
  return within(await screen.findByRole('dialog', { name: 'Visita' }));
}

/** O servidor passa a devolver `next` também no GET (a escrita invalida o detalhe). */
function serverReturns(next: VisitDetail): () => Promise<VisitDetail> {
  return async () => {
    getMock.mockResolvedValue(next);
    return next;
  };
}

function listResponse(visits: VisitDetail[]): ListVisitsResponse {
  return { visits, truncated: false };
}

describe('Registro da visita (CRMLAB-88)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    mockMobile();
    vi.mocked(visitsApi.list).mockResolvedValue(listResponse([visit()]));
    getMock.mockResolvedValue(visit());
    vi.mocked(doctorsApi.list).mockResolvedValue({
      doctors: [],
      pagination: { page: 1, limit: 100, total: 0, totalPages: 0 },
    });
    vi.mocked(conversationsApi.assignees).mockResolvedValue({
      assignees: [
        { id: 'u-ana', name: 'Ana Gestora', role: 'manager' },
        { id: 'u-bia', name: 'Bia Atendente', role: 'attendant' },
      ],
    });
    useAuthStore.setState({
      user: { id: 'u-bia', email: 'bia@lab.test', name: 'Bia Atendente', role: 'attendant', discountLimit: 5 },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('"Cheguei" faz o check-in e a visita passa a mostrar "Saí"', async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(visitsApi.checkIn).mockImplementation(serverReturns(checkedIn()));
    renderPage();
    const dialog = await openVisit(user);

    await user.click(await dialog.findByRole('button', { name: 'Cheguei' }));
    expect(visitsApi.checkIn).toHaveBeenCalledWith('v-1');
    const check = within(await screen.findByTestId('visit-check'));
    expect(await check.findByRole('button', { name: 'Saí' })).toBeInTheDocument();
    expect(screen.getByTestId('visit-check')).toHaveTextContent(/Em visita desde 09:35 · Bia Atendente/);
    expect(check.queryByRole('button', { name: 'Cheguei' })).not.toBeInTheDocument();
  });

  it('com check-in feito, "Saí" faz o check-out e [Reagendar] some', async () => {
    const user = userEvent.setup({ delay: null });
    getMock.mockResolvedValue(checkedIn());
    vi.mocked(visitsApi.checkOut).mockImplementation(serverReturns(realizada()));
    renderPage();
    const dialog = await openVisit(user);

    await dialog.findByRole('button', { name: 'Saí' });
    expect(dialog.queryByRole('button', { name: 'Reagendar' })).not.toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Cancelar visita' })).toBeInTheDocument();

    await user.click(dialog.getByRole('button', { name: 'Saí' }));
    expect(visitsApi.checkOut).toHaveBeenCalledWith('v-1');
    expect(await screen.findByTestId('visit-check-summary')).toHaveTextContent(/Check-out 10:20 · Duração 45 min/);
  });

  it('check-out sem check-in no servidor: avisa e recarrega a visita', async () => {
    const user = userEvent.setup({ delay: null });
    const { ApiError } = await import('@/api/client');
    getMock.mockResolvedValue(checkedIn());
    vi.mocked(visitsApi.checkOut).mockRejectedValue(new ApiError('VISIT_NOT_CHECKED_IN', 'x', 409));
    renderPage();
    const dialog = await openVisit(user);

    const calls = getMock.mock.calls.length;
    await user.click(await dialog.findByRole('button', { name: 'Saí' }));
    expect(await screen.findByText('Faça o check-in antes do check-out.')).toBeInTheDocument();
    await waitFor(() => expect(getMock.mock.calls.length).toBeGreaterThan(calls));
  });

  it('relato salva só os campos que mudaram, com a data de retorno', async () => {
    const user = userEvent.setup({ delay: null });
    getMock.mockResolvedValue(realizada({ report: { presented: 'Painel', doctorFeedback: null, objections: null } }));
    vi.mocked(visitsApi.updateReport).mockResolvedValue(realizada({ nextVisitDate: '2026-11-03' }));
    renderPage();
    const dialog = await openVisit(user);
    const report = within(await dialog.findByTestId('visit-report'));

    expect(report.getByRole('button', { name: 'Salvar relato' })).toBeDisabled();
    await user.type(report.getByLabelText('Feedback do médico'), '  Gostou do prazo ');
    await user.type(report.getByLabelText('Data de retorno'), '2026-11-03');
    await user.click(report.getByRole('button', { name: 'Salvar relato' }));

    expect(visitsApi.updateReport).toHaveBeenCalledWith('v-1', {
      doctorFeedback: 'Gostou do prazo',
      nextVisitDate: '2026-11-03',
    });
  });

  it('"Agendar retorno" abre a visita nova com médico, responsável, tipo e a data às 09:00 — sem criar sozinha', async () => {
    const user = userEvent.setup({ delay: null });
    getMock.mockResolvedValue(realizada({ nextVisitDate: '2026-11-03' }));
    renderPage();
    const dialog = await openVisit(user);

    await user.click(await dialog.findByRole('button', { name: 'Agendar retorno' }));
    const form = within(await screen.findByRole('dialog', { name: 'Agendar retorno' }));
    expect(form.getByLabelText('Data')).toHaveValue('2026-11-03');
    expect(form.getByLabelText('Hora')).toHaveValue('09:00');
    expect(form.getByLabelText('Responsável')).toHaveValue('u-ana');
    expect(form.getByLabelText('Tipo')).toHaveValue('online');
    expect(form.getByLabelText('Médico')).toHaveValue('doc-1');
    expect(visitsApi.create).not.toHaveBeenCalled();
  });

  it('anexa PDF (base64), recusa o que não é imagem/PDF e exclui com confirmação', async () => {
    const user = userEvent.setup({ delay: null, applyAccept: false });
    getMock.mockResolvedValue(checkedIn({ attachments: [PDF_ATTACHMENT], attachmentCount: 1 }));
    vi.mocked(visitsApi.addAttachment).mockResolvedValue({ ...PDF_ATTACHMENT, id: 'att-2', fileName: 'tabela.pdf' });
    vi.mocked(visitsApi.deleteAttachment).mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    const dialog = await openVisit(user);
    const attachments = within(await dialog.findByTestId('visit-attachments'));
    expect(attachments.getByText('folder.pdf')).toBeInTheDocument();

    const input = attachments.getByLabelText('Escolher arquivo para anexar');
    await user.upload(input, new File(['texto'], 'notas.txt', { type: 'text/plain' }));
    expect(await screen.findByText('Só imagem ou PDF.')).toBeInTheDocument();
    expect(visitsApi.addAttachment).not.toHaveBeenCalled();

    await user.upload(input, new File(['%PDF-1.4'], 'tabela.pdf', { type: 'application/pdf' }));
    await waitFor(() =>
      expect(visitsApi.addAttachment).toHaveBeenCalledWith('v-1', {
        fileName: 'tabela.pdf',
        mimeType: 'application/pdf',
        contentBase64: btoa('%PDF-1.4'),
      }),
    );

    await user.click(attachments.getByRole('button', { name: 'Excluir folder.pdf' }));
    expect(confirm).toHaveBeenCalled();
    expect(visitsApi.deleteAttachment).toHaveBeenCalledWith('v-1', 'att-1');
    confirm.mockRestore();
  });

  it('visita cancelada: sem check-in, relato só leitura e anexo só para baixar', async () => {
    const user = userEvent.setup({ delay: null });
    getMock.mockResolvedValue(
      visit({
        status: 'cancelada',
        statusReason: 'Férias',
        report: { presented: 'Material novo', doctorFeedback: null, objections: null },
        attachments: [PDF_ATTACHMENT],
        attachmentCount: 1,
      }),
    );
    renderPage();
    const dialog = await openVisit(user);

    expect(await dialog.findByText('Material novo')).toBeInTheDocument();
    expect(dialog.queryByTestId('visit-check')).not.toBeInTheDocument();
    expect(dialog.queryByRole('button', { name: 'Salvar relato' })).not.toBeInTheDocument();
    expect(dialog.queryByRole('button', { name: 'Anexar arquivo' })).not.toBeInTheDocument();
    expect(dialog.queryByRole('button', { name: 'Excluir folder.pdf' })).not.toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Baixar folder.pdf' })).toBeInTheDocument();
  });
});
