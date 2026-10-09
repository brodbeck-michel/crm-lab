/**
 * AutoReplyService — resposta automatica fora do horario e boas-vindas.
 * SERVICES.md §33 (CRMLAB-94, D-264).
 *
 * Chamado por `MessageService.createFromPatient` SEM `await`, depois de cada
 * mensagem NOVA do paciente (D-264 item 1). Por isso NUNCA lanca: qualquer
 * erro vira log, e a mensagem recebida ja esta gravada.
 *
 * Quem decide se o laboratorio esta fechado e a funcao pura
 * `offHoursReopening` (`shared/`), sobre a mesma regua do reingajamento
 * (D-212/D-213). Uma resposta = uma linha em `conversation_auto_replies`,
 * gravada ANTES do envio: os indices unicos parciais sao a trava contra
 * mandar duas vezes no mesmo periodo fechado (ou duas boas-vindas), inclusive
 * com webhooks concorrentes.
 */
import {
  AUTO_REPLY_REOPENING_SEARCH_DAYS,
  localDateOf,
  offHoursReopening,
  type AutoReplyKind,
  type Message,
} from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import { isBusinessError } from '../http/errors.js';
import { logger } from '../lib/logger.js';
import * as repo from '../repositories/auto-reply.repository.js';
import * as holidayRepo from '../repositories/holiday.repository.js';
import type { MessageAutomation } from '../repositories/message.repository.js';
import { isQrWhatsAppActive } from '../repositories/reengagement.repository.js';
import { readAutoReplySettings } from './channel-settings.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AutoReplyResult {
  kind: AutoReplyKind;
  outcome: 'sent' | 'failed';
}

/** O pedaco do MessageService que a resposta automatica usa. */
export interface AutoReplySender {
  createAutomated(
    tenantId: string,
    conversationId: string,
    content: string,
    automation: MessageAutomation,
  ): Promise<Message>;
}

export interface AutoReplyService {
  /** Nunca lanca. `null` = nada a enviar (aberto, desligado, canal sem envio, ja respondido). */
  afterPatientMessage(
    tenantId: string,
    conversationId: string,
    message: Pick<Message, 'id' | 'createdAt'>,
    sender: AutoReplySender,
  ): Promise<AutoReplyResult | null>;
}

interface Plan {
  kind: AutoReplyKind;
  content: string;
  reopensAt: Date | null;
}

/** Texto utilizavel: ligada e nao vazia (D-264 item 8). */
function textOf(setting: { enabled: boolean; message: string | null }): string | null {
  return setting.enabled && setting.message && setting.message.trim().length > 0 ? setting.message : null;
}

export function createAutoReplyService(deps: { db: DbClient }): AutoReplyService {
  const { db } = deps;

  /** Decide e reserva numa transacao. `null` = nada a enviar. */
  async function planAndClaim(
    tenantId: string,
    conversationId: string,
    message: Pick<Message, 'id' | 'createdAt'>,
  ): Promise<{ plan: Plan; claimId: string } | null> {
    return db.withTenant(tenantId, async (tx) => {
      const { autoMessages, businessHours } = await readAutoReplySettings(tx, tenantId);
      const offHours = textOf(autoMessages.offHours);
      const greeting = textOf(autoMessages.greeting);
      if (offHours === null && greeting === null) return null;
      // So WhatsApp por QR Code (D-264 item 5, a mesma condicao do D-214).
      if (!(await isQrWhatsAppActive(tx, tenantId))) return null;

      const at = new Date(message.createdAt);
      const holidays = await holidayRepo.listDates(
        tx,
        tenantId,
        localDateOf(at, businessHours.timezone),
        localDateOf(
          new Date(at.getTime() + (AUTO_REPLY_REOPENING_SEARCH_DAYS + 1) * DAY_MS),
          businessHours.timezone,
        ),
      );
      const reopensAt = offHoursReopening(at, businessHours, holidays);

      let plan: Plan | null = null;
      if (reopensAt !== null) {
        // Fechado: so a de fora do horario, nunca boas-vindas (D-264 item 7).
        if (offHours !== null) plan = { kind: 'offhours', content: offHours, reopensAt };
      } else if (greeting !== null && (await repo.isFirstMessage(tx, conversationId, message.id))) {
        plan = { kind: 'greeting', content: greeting, reopensAt: null };
      }
      if (plan === null) return null;

      const claimId = await repo.claim(tx, {
        tenantId,
        conversationId,
        kind: plan.kind,
        reopensAt: plan.reopensAt,
        triggerMessageId: message.id,
      });
      return claimId === null ? null : { plan, claimId };
    });
  }

  async function afterPatientMessage(
    tenantId: string,
    conversationId: string,
    message: Pick<Message, 'id' | 'createdAt'>,
    sender: AutoReplySender,
  ): Promise<AutoReplyResult | null> {
    let claimed: { plan: Plan; claimId: string } | null;
    try {
      claimed = await planAndClaim(tenantId, conversationId, message);
    } catch (err) {
      logger.warn('auto_reply.failed', {
        tenantId,
        conversationId,
        stage: 'plan',
        reason: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (claimed === null) return null;
    const { plan, claimId } = claimed;

    try {
      const sent = await sender.createAutomated(tenantId, conversationId, plan.content, plan.kind);
      await db.withTenant(tenantId, (tx) => repo.finish(tx, claimId, { outcome: 'sent', messageId: sent.id }));
      logger.info('auto_reply.sent', { tenantId, conversationId, kind: plan.kind, messageId: sent.id });
      return { kind: plan.kind, outcome: 'sent' };
    } catch (err) {
      const messageId =
        isBusinessError(err) && typeof err.details?.messageId === 'string' ? err.details.messageId : null;
      try {
        await db.withTenant(tenantId, (tx) => repo.finish(tx, claimId, { outcome: 'failed', messageId }));
      } catch (finishErr) {
        logger.warn('auto_reply.finish_failed', {
          tenantId,
          conversationId,
          reason: finishErr instanceof Error ? finishErr.message : String(finishErr),
        });
      }
      logger.warn('auto_reply.failed', {
        tenantId,
        conversationId,
        kind: plan.kind,
        stage: 'send',
        messageId,
        reason: isBusinessError(err) ? err.code : err instanceof Error ? err.message : String(err),
      });
      return { kind: plan.kind, outcome: 'failed' };
    }
  }

  return { afterPatientMessage };
}
