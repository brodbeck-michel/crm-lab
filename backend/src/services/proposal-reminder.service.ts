/**
 * ProposalReminderService — lembrete de contato da proposta parada
 * (SERVICES.md §34, CRMLAB-102, D-272). Dono de `proposal_reminders`.
 *
 * - `schedule`: "Agendar lembrete" no modal — cria o manual ou reagenda o
 *   aberto (no maximo um aberto por proposta).
 * - `resolve`: desfecho obrigatorio. Ganho/Perdido NAO tem caminho proprio:
 *   vao pelo `ProposalService.updateStatus` de sempre (matriz, travas das
 *   Regras, motivo, aprovacao, audit, WS), que fecha o lembrete dentro da
 *   transacao do estagio (`recordTransitionInTx`). Reagendar fecha o atual e
 *   abre outro na nova data.
 *
 * O lembrete automatico e o aviso de vencido sao do motor de tempo
 * (`FunnelTimerService`); o encerramento junto com a proposta, de
 * `closeOpenReminderInTx` (proposal.service.ts).
 */
import {
  PROPOSAL_REMINDER_MAX_DAYS_AHEAD,
  PROPOSAL_REMINDER_NOTE_MAX,
  TERMINAL_STATUSES,
  addDaysToIsoDate,
  isCardOwner,
  isValidIsoDate,
  saoPauloToday,
  type LossReason,
  type ProposalDetail,
  type ProposalStatus,
  type ResolveProposalReminderRequest,
  type ScheduleProposalReminderRequest,
} from '@crm-lab/shared';
import type { DbClient, DbTx } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError } from '../http/errors.js';
import type { WsHub } from '../lib/ws-hub.js';
import * as auditRepo from '../repositories/audit.repository.js';
import * as reminderRepo from '../repositories/proposal-reminder.repository.js';
import type { ProposalRow } from '../repositories/proposal.repository.js';
import { loadDetail, loadVisibleProposal, type ProposalService } from './proposal.service.js';

export interface ProposalReminderServiceDeps {
  db: DbClient;
  wsHub: WsHub;
  proposals: ProposalService;
  now?: () => Date;
}

/** Observacao: `trim`, vazio = `null`; acima do teto = erro. */
function normalizeNote(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function noteTooLong(note: string | null): boolean {
  return note !== null && note.length > PROPOSAL_REMINDER_NOTE_MAX;
}

/**
 * Erro do dia, ou `null`. `allowToday`: o "Agendar" aceita hoje; o desfecho
 * "Reagendar contato" exige data futura (D-272 itens 3 e 6).
 */
function dueDateError(dueDate: string, today: string, allowToday: boolean): string | null {
  if (!isValidIsoDate(dueDate)) return 'Informe uma data válida (AAAA-MM-DD)';
  if (allowToday ? dueDate < today : dueDate <= today) {
    return allowToday ? 'Escolha hoje ou uma data futura' : 'Escolha uma data futura';
  }
  if (dueDate > addDaysToIsoDate(today, PROPOSAL_REMINDER_MAX_DAYS_AHEAD)) {
    return `Escolha uma data em até ${PROPOSAL_REMINDER_MAX_DAYS_AHEAD} dias`;
  }
  return null;
}

/**
 * Proposta visivel (outro tenant / fora da visibilidade -> `NOT_FOUND`),
 * aberta, e de quem pode cuidar dela: responsavel (ou fila comum do Bitlab),
 * gestor ou admin (D-272 item 9).
 */
async function loadActionable(tx: DbTx, ctx: TenantContext, id: string): Promise<ProposalRow> {
  const row = await loadVisibleProposal(tx, ctx, id);
  if (TERMINAL_STATUSES.includes(row.status as ProposalStatus)) {
    throw new BusinessError('PROPOSAL_ALREADY_CLOSED', { status: row.status });
  }
  const supervisor = ctx.role === 'manager' || ctx.role === 'admin';
  if (!supervisor && !isCardOwner(row.created_by, ctx.userId)) {
    throw new BusinessError('FORBIDDEN', { reason: 'not_owner' });
  }
  return row;
}

export class ProposalReminderService {
  private readonly now: () => Date;

  constructor(private readonly deps: ProposalReminderServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** `PUT /proposals/:id/reminder`. */
  async schedule(
    ctx: TenantContext,
    id: string,
    dto: ScheduleProposalReminderRequest,
  ): Promise<ProposalDetail> {
    const today = saoPauloToday(this.now());
    const note = normalizeNote(dto.note);
    const fields: Record<string, string> = {};
    const dateError = dueDateError(dto.dueDate, today, true);
    if (dateError !== null) fields.dueDate = dateError;
    if (noteTooLong(note)) {
      fields.note = `A observação deve ter até ${PROPOSAL_REMINDER_NOTE_MAX} caracteres`;
    }

    const detail = await this.deps.db.withTenant(ctx.tenantId, async (tx) => {
      await loadActionable(tx, ctx, id);
      if (Object.keys(fields).length > 0) throw new BusinessError('VALIDATION_ERROR', { fields });
      const open = await reminderRepo.findOpenForUpdate(tx, id);
      if (open) {
        await reminderRepo.reschedule(tx, open.id, dto.dueDate, note);
        await auditRepo.insert(tx, {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          action: 'update_proposal_reminder',
          entityType: 'proposal',
          entityId: id,
          oldValues: { reminderId: open.id, dueDate: open.dueDate, note: open.note },
          newValues: { reminderId: open.id, dueDate: dto.dueDate, note },
          ipAddress: ctx.ip,
        });
      } else {
        const reminderId = await reminderRepo.insert(tx, {
          tenantId: ctx.tenantId,
          proposalId: id,
          origin: 'manual',
          dueDate: dto.dueDate,
          note,
          createdBy: ctx.userId,
        });
        if (reminderId === null) {
          throw new BusinessError('CONFLICT', { reason: 'reminder_already_open' });
        }
        await auditRepo.insert(tx, {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          action: 'create_proposal_reminder',
          entityType: 'proposal',
          entityId: id,
          oldValues: null,
          newValues: { reminderId, origin: 'manual', dueDate: dto.dueDate, note },
          ipAddress: ctx.ip,
        });
      }
      return loadDetail(tx, id);
    });
    this.deps.wsHub.emitToTenant(ctx.tenantId, 'proposal.updated', { proposalId: id });
    return detail;
  }

  /** `POST /proposals/:id/reminder/resolve`. */
  async resolve(
    ctx: TenantContext,
    id: string,
    dto: ResolveProposalReminderRequest,
  ): Promise<ProposalDetail> {
    const today = saoPauloToday(this.now());
    const fields: Record<string, string> = {};
    let rescheduleNote: string | null = null;
    if (dto.outcome === 'rescheduled') {
      const dateError = dueDateError(dto.dueDate, today, false);
      if (dateError !== null) fields.dueDate = dateError;
      rescheduleNote = normalizeNote(dto.note);
      if (noteTooLong(rescheduleNote)) {
        fields.note = `A observação deve ter até ${PROPOSAL_REMINDER_NOTE_MAX} caracteres`;
      }
    }

    const rescheduled = await this.deps.db.withTenant(ctx.tenantId, async (tx) => {
      await loadActionable(tx, ctx, id);
      const open = await reminderRepo.findOpenForUpdate(tx, id);
      if (!open) throw new BusinessError('CONFLICT', { reason: 'no_open_reminder' });
      if (Object.keys(fields).length > 0) throw new BusinessError('VALIDATION_ERROR', { fields });
      if (dto.outcome !== 'rescheduled') return null;

      await reminderRepo.resolve(tx, {
        id: open.id,
        outcome: 'rescheduled',
        resolvedBy: ctx.userId,
        outcomeNote: rescheduleNote,
      });
      const nextId = await reminderRepo.insert(tx, {
        tenantId: ctx.tenantId,
        proposalId: id,
        origin: 'manual',
        dueDate: dto.dueDate,
        note: rescheduleNote,
        createdBy: ctx.userId,
      });
      await auditRepo.insert(tx, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: 'resolve_proposal_reminder',
        entityType: 'proposal',
        entityId: id,
        oldValues: { reminderId: open.id, dueDate: open.dueDate },
        newValues: {
          reminderId: open.id,
          outcome: 'rescheduled',
          note: rescheduleNote,
          nextReminderId: nextId,
          nextDueDate: dto.dueDate,
        },
        ipAddress: ctx.ip,
      });
      await auditRepo.insert(tx, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: 'create_proposal_reminder',
        entityType: 'proposal',
        entityId: id,
        oldValues: null,
        newValues: { reminderId: nextId, origin: 'manual', dueDate: dto.dueDate, note: rescheduleNote },
        ipAddress: ctx.ip,
      });
      return loadDetail(tx, id);
    });

    if (rescheduled !== null) {
      this.deps.wsHub.emitToTenant(ctx.tenantId, 'proposal.updated', { proposalId: id });
      return rescheduled;
    }

    // Ganho/Perdido: o fluxo de estagio de sempre (D-272 item 6).
    const reasonLost: LossReason | undefined =
      dto.outcome === 'lost' ? dto.reasonLost : undefined;
    await this.deps.proposals.updateStatus(
      ctx,
      id,
      dto.outcome === 'won' ? 'ganho' : 'perdido',
      reasonLost,
      { viaReminder: true },
    );
    return this.deps.proposals.getById(ctx, id);
  }
}

export function createProposalReminderService(
  deps: ProposalReminderServiceDeps,
): ProposalReminderService {
  return new ProposalReminderService(deps);
}
