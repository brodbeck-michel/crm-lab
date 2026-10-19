import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ProposalDetail, ProposalReminder } from '@crm-lab/shared';
import { mutationIdle } from '@/test/query-mocks';
import * as proposalsApi from '@/api/proposals';
import ReminderPanel from './ReminderPanel';

vi.mock('@/api/proposals');

/** 19/10/2026 09:00 em Brasília. */
const NOW = new Date('2026-10-19T12:00:00.000Z');

const OPEN: ProposalReminder = {
  id: 'rem-1',
  origin: 'auto',
  dueDate: '2026-10-19',
  note: 'ligar de manhã',
  createdBy: null,
  createdByName: null,
  createdAt: '2026-10-19T09:00:00.000Z',
};

function proposal(overrides: Partial<ProposalDetail> = {}): ProposalDetail {
  return {
    id: 'prop-1',
    proposalNumber: 1,
    origin: 'crm',
    conversationId: 'conv-1',
    patientName: 'João',
    patientPhone: '11999999999',
    status: 'follow_up',
    discountPercent: 0,
    totalPrice: 100,
    subtotal: 100,
    createdBy: 'user-1',
    createdByName: 'Maria',
    approvalStatus: 'none',
    reasonLost: null,
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
    rejectionReason: null,
    sentAt: null,
    closedAt: null,
    createdAt: '2026-10-01T10:00:00Z',
    updatedAt: '2026-10-01T10:00:00Z',
    insuranceId: null,
    lisBudgetNumber: null,
    lisReconciledAt: null,
    lisRequisitionNumber: null,
    lisIssuedOn: null,
    lisAttendantName: null,
    items: [],
    history: [],
    requestingDoctor: null,
    lisPaidValue: null,
    lisPaidOn: null,
    reminder: null,
    reminders: [],
    ...overrides,
  };
}

let schedule: ReturnType<typeof vi.fn>;
let resolve: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  schedule = vi.fn();
  resolve = vi.fn();
  vi.mocked(proposalsApi.useScheduleProposalReminder).mockReturnValue(mutationIdle(schedule));
  vi.mocked(proposalsApi.useResolveProposalReminder).mockReturnValue(mutationIdle(resolve));
});

function renderPanel(detail: ProposalDetail, requireLossReason = true) {
  return render(<ReminderPanel proposal={detail} requireLossReason={requireLossReason} now={NOW} />);
}

describe('ReminderPanel', () => {
  it('sem lembrete: agenda com dia e observação opcional', () => {
    renderPanel(proposal());
    fireEvent.click(screen.getByRole('button', { name: 'Agendar lembrete' }));
    fireEvent.change(screen.getByLabelText('Dia do contato'), { target: { value: '2026-10-25' } });
    fireEvent.change(screen.getByLabelText('Observação (opcional)'), {
      target: { value: 'ligar dia 25' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar lembrete' }));
    expect(schedule).toHaveBeenCalledWith(
      { proposalId: 'prop-1', body: { dueDate: '2026-10-25', note: 'ligar dia 25' } },
      expect.anything(),
    );
  });

  it('lembrete aberto vencido mostra dia, "Vencido", origem e a observação', () => {
    renderPanel(proposal({ reminder: OPEN }));
    expect(screen.getByText('Contato em 19/10/2026')).toBeInTheDocument();
    expect(screen.getByText('Vencido')).toBeInTheDocument();
    expect(screen.getByText('Automático')).toBeInTheDocument();
    expect(screen.getByText('ligar de manhã')).toBeInTheDocument();
  });

  it('lembrete futuro não leva "Vencido"', () => {
    renderPanel(proposal({ reminder: { ...OPEN, dueDate: '2026-10-20' } }));
    expect(screen.queryByText('Vencido')).not.toBeInTheDocument();
  });

  it('desfecho Ganho chama o resolve com won', () => {
    renderPanel(proposal({ reminder: OPEN }));
    fireEvent.click(screen.getByRole('button', { name: 'Registrar desfecho' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ganho' }));
    expect(resolve).toHaveBeenCalledWith(
      { proposalId: 'prop-1', body: { outcome: 'won' } },
      expect.anything(),
    );
  });

  it('desfecho Perdido usa o formulário de motivo de sempre', () => {
    renderPanel(proposal({ reminder: OPEN }));
    fireEvent.click(screen.getByRole('button', { name: 'Registrar desfecho' }));
    fireEvent.click(screen.getByRole('button', { name: 'Perdido' }));
    const confirm = screen.getByRole('button', { name: 'Confirmar' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'preco' } });
    fireEvent.click(confirm);
    expect(resolve).toHaveBeenCalledWith(
      { proposalId: 'prop-1', body: { outcome: 'lost', reasonLost: 'preco' } },
      expect.anything(),
    );
  });

  it('Perdido sem motivo quando a regra não exige', () => {
    renderPanel(proposal({ reminder: OPEN }), false);
    fireEvent.click(screen.getByRole('button', { name: 'Registrar desfecho' }));
    fireEvent.click(screen.getByRole('button', { name: 'Perdido' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(resolve).toHaveBeenCalledWith(
      { proposalId: 'prop-1', body: { outcome: 'lost' } },
      expect.anything(),
    );
  });

  it('Reagendar contato: só a data é obrigatória (futura), observação opcional', () => {
    renderPanel(proposal({ reminder: OPEN }));
    fireEvent.click(screen.getByRole('button', { name: 'Registrar desfecho' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reagendar contato' }));
    const date = screen.getByLabelText('Dia do contato');
    expect(date).toHaveValue('2026-10-20');
    fireEvent.change(date, { target: { value: '2026-10-19' } });
    expect(screen.getByRole('button', { name: 'Reagendar contato' })).toBeDisabled();
    fireEvent.change(date, { target: { value: '2026-10-28' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reagendar contato' }));
    expect(resolve).toHaveBeenCalledWith(
      { proposalId: 'prop-1', body: { outcome: 'rescheduled', dueDate: '2026-10-28' } },
      expect.anything(),
    );
  });

  it('erro do servidor aparece no painel', () => {
    resolve.mockImplementation((_vars: unknown, options: { onError: (e: unknown) => void }) =>
      options.onError(new Error('As regras não permitem')),
    );
    renderPanel(proposal({ reminder: OPEN }));
    fireEvent.click(screen.getByRole('button', { name: 'Registrar desfecho' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ganho' }));
    expect(screen.getByRole('alert')).toHaveTextContent('As regras não permitem');
  });

  it('lista os lembretes fechados com o desfecho', () => {
    renderPanel(
      proposal({
        reminder: OPEN,
        reminders: [
          {
            ...OPEN,
            id: 'rem-0',
            dueDate: '2026-10-10',
            resolvedAt: '2026-10-10T15:00:00.000Z',
            resolvedBy: 'user-1',
            resolvedByName: 'Maria',
            outcome: 'rescheduled',
            outcomeNote: 'pediu retorno',
          },
          {
            ...OPEN,
            resolvedAt: null,
            resolvedBy: null,
            resolvedByName: null,
            outcome: null,
            outcomeNote: null,
          },
        ],
      }),
    );
    const list = screen.getByRole('list', { name: 'Lembretes anteriores' });
    expect(list).toHaveTextContent('10/10/2026 · Reagendado por Maria');
    expect(list).toHaveTextContent('pediu retorno');
  });
});
