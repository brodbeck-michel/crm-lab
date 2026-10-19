import { useState } from 'react';
import {
  PROPOSAL_REMINDER_NOTE_MAX,
  PROPOSAL_REMINDER_OUTCOME_LABELS,
  addDaysToIsoDate,
  isReminderDue,
  saoPauloToday,
  type LossReason,
  type ProposalDetail,
  type ProposalReminderEntry,
} from '@crm-lab/shared';
import { toHandledError } from '@/api';
import { useResolveProposalReminder, useScheduleProposalReminder } from '@/api/proposals';
import { formatDateTime, formatIsoDay } from '@/lib/format';
import { Button, Chip, Input, TextArea } from '@/components/ui';
import LostReasonForm from './LostReasonForm';

/**
 * Lembrete de contato (CRMLAB-102, D-272, PAGES.md §6). Bloco do corpo do
 * modal — não mexe no cabeçalho, onde mora o "Enviar mensagem" (CRMLAB-100).
 *
 * Agendar/reagendar → `PUT /proposals/:id/reminder`. O desfecho → `POST
 * /proposals/:id/reminder/resolve`: Ganho e Perdido passam pelo fluxo de
 * estágio de sempre no servidor (as travas das Regras valem); Reagendar exige
 * só a nova data (futura).
 */

type Mode = 'idle' | 'schedule' | 'outcome' | 'lost' | 'reschedule';

interface ReminderPanelProps {
  proposal: ProposalDetail;
  /** "Exigir motivo ao marcar Perdido" das Regras. */
  requireLossReason: boolean;
  /** Proposta fechada: só a lista dos lembretes, sem ações. */
  readOnly?: boolean;
  /** Só para teste. */
  now?: Date;
}

/** Mensagem do servidor para o painel: os erros de campo, se houver, senão a geral. */
function errorText(err: unknown): string {
  const handled = toHandledError(err);
  const fields = (handled.details as { fields?: Record<string, string> } | undefined)?.fields;
  if (fields && Object.keys(fields).length > 0) return Object.values(fields).join(' ');
  return handled.message;
}

function describeClosed(entry: ProposalReminderEntry): string {
  const label = entry.outcome ? PROPOSAL_REMINDER_OUTCOME_LABELS[entry.outcome] : '';
  const who = entry.resolvedByName ? ` por ${entry.resolvedByName}` : '';
  const when = entry.resolvedAt ? ` em ${formatDateTime(entry.resolvedAt)}` : '';
  return `${formatIsoDay(entry.dueDate)} · ${label}${who}${when}`;
}

export default function ReminderPanel({
  proposal,
  requireLossReason,
  readOnly = false,
  now,
}: ReminderPanelProps) {
  const schedule = useScheduleProposalReminder();
  const resolve = useResolveProposalReminder();
  const [mode, setMode] = useState<Mode>('idle');
  const [dueDate, setDueDate] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const clock = now ?? new Date();
  const today = saoPauloToday(clock);
  const open = proposal.reminder ?? null;
  const due = isReminderDue(open, clock);
  const closed = (proposal.reminders ?? []).filter((r) => r.outcome !== null);
  const pending = schedule.isPending || resolve.isPending;

  const startSchedule = () => {
    setDueDate(open?.dueDate ?? today);
    setNote(open?.note ?? '');
    setError(null);
    setMode('schedule');
  };

  const startReschedule = () => {
    setDueDate(addDaysToIsoDate(today, 1));
    setNote('');
    setError(null);
    setMode('reschedule');
  };

  const done = () => {
    setMode('idle');
    setError(null);
  };

  const submitSchedule = () => {
    schedule.mutate(
      { proposalId: proposal.id, body: { dueDate, note: note.trim() === '' ? null : note } },
      { onSuccess: done, onError: (err) => setError(errorText(err)) },
    );
  };

  const submitWon = () => {
    resolve.mutate(
      { proposalId: proposal.id, body: { outcome: 'won' } },
      { onSuccess: done, onError: (err) => setError(errorText(err)) },
    );
  };

  const submitLost = (reasonLost: LossReason | undefined) => {
    resolve.mutate(
      {
        proposalId: proposal.id,
        body: reasonLost !== undefined ? { outcome: 'lost', reasonLost } : { outcome: 'lost' },
      },
      { onSuccess: done, onError: (err) => setError(errorText(err)) },
    );
  };

  const submitReschedule = () => {
    resolve.mutate(
      {
        proposalId: proposal.id,
        body: {
          outcome: 'rescheduled',
          dueDate,
          ...(note.trim() !== '' ? { note } : {}),
        },
      },
      { onSuccess: done, onError: (err) => setError(errorText(err)) },
    );
  };

  const dateForm = (minDate: string, onSubmit: () => void, submitLabel: string) => (
    <div className="space-y-sm">
      <div className="w-48">
        <Input
          type="date"
          label="Dia do contato"
          value={dueDate}
          min={minDate}
          onChange={(e) => setDueDate(e.target.value)}
        />
      </div>
      <TextArea
        label="Observação (opcional)"
        value={note}
        maxLength={PROPOSAL_REMINDER_NOTE_MAX}
        placeholder="Ex.: ligar dia 25"
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="flex justify-end gap-sm">
        <Button variant="secondary" size="sm" onClick={done}>
          Cancelar
        </Button>
        <Button
          variant="primary"
          size="sm"
          loading={pending}
          disabled={dueDate === '' || dueDate < minDate}
          onClick={onSubmit}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );

  return (
    <section aria-label="Lembrete de contato" className="space-y-sm border-t pt-md">
      <div className="flex items-center justify-between gap-sm">
        <span className="font-semibold">Lembrete de contato</span>
        {!readOnly && mode === 'idle' && open === null && (
          <Button variant="secondary" size="sm" onClick={startSchedule}>
            Agendar lembrete
          </Button>
        )}
      </div>

      {!readOnly && open !== null && mode === 'idle' && (
        <div className="space-y-xs">
          <div className="flex flex-wrap items-center gap-xs">
            <span className="text-body">Contato em {formatIsoDay(open.dueDate)}</span>
            {due && <Chip tone="attention">Vencido</Chip>}
            {open.origin === 'auto' && <Chip tone="inactive">Automático</Chip>}
          </div>
          {open.note && <p className="text-caption text-neutral-600">{open.note}</p>}
          <div className="flex flex-wrap justify-end gap-sm">
            <Button variant="secondary" size="sm" onClick={startSchedule}>
              Reagendar
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setError(null);
                setMode('outcome');
              }}
            >
              Registrar desfecho
            </Button>
          </div>
        </div>
      )}

      {mode === 'schedule' && dateForm(today, submitSchedule, 'Salvar lembrete')}

      {mode === 'outcome' && (
        <div className="space-y-sm">
          <p className="text-caption text-neutral-600">Como foi o contato?</p>
          <div className="flex flex-wrap gap-sm">
            <Button variant="confirmation" size="sm" loading={pending} onClick={submitWon}>
              Ganho
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setMode('lost')}>
              Perdido
            </Button>
            <Button variant="secondary" size="sm" onClick={startReschedule}>
              Reagendar contato
            </Button>
            <Button variant="secondary" size="sm" onClick={done}>
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {mode === 'lost' && (
        <div className="space-y-sm">
          <LostReasonForm
            onSubmit={submitLost}
            isPending={pending}
            requireReason={requireLossReason}
          />
          <Button variant="secondary" size="sm" onClick={done}>
            Cancelar
          </Button>
        </div>
      )}

      {mode === 'reschedule' &&
        dateForm(addDaysToIsoDate(today, 1), submitReschedule, 'Reagendar contato')}

      {error && (
        <p role="alert" className="text-caption text-accent-700">
          {error}
        </p>
      )}

      {closed.length > 0 && (
        <ul aria-label="Lembretes anteriores" className="space-y-xs">
          {closed.map((entry) => (
            <li key={entry.id} className="text-caption text-neutral-600">
              {describeClosed(entry)}
              {entry.outcomeNote && <> — {entry.outcomeNote}</>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
