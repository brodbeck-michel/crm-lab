/**
 * ReengagementService — reingajamento da conversa. SERVICES.md §28
 * (CRMLAB-62, D-211..D-214).
 *
 * Roda DENTRO do tique do motor de tempo (D-211 item 1): `FunnelTimerService`
 * chama `runForTenant` depois dos passos do funil. Quem decide e a funcao pura
 * `planReengagement` (`shared/`); aqui ficam a leitura, a trava e o envio.
 *
 * Um disparo = uma linha em `conversation_reengagements`, gravada ANTES do
 * envio (D-211 item 3). A UNIQUE `(anchor_message_id, step)` e a trava contra
 * mandar duas vezes; se o processo cair entre a linha e o envio, o paciente
 * fica sem a mensagem, nunca com duas.
 */
import {
  REENGAGEMENT_LOOKBACK_DAYS,
  localDateOf,
  planReengagement,
  type Message,
  type ReengagementAction,
  type ReengagementStep,
} from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import { isBusinessError } from '../http/errors.js';
import { logger } from '../lib/logger.js';
import * as holidayRepo from '../repositories/holiday.repository.js';
import * as repo from '../repositories/reengagement.repository.js';
import { readBusinessHours } from './channel-settings.service.js';
import { readFunnelRules } from './funnel-rules.service.js';

/** Teto de silencios por laboratorio por tique, como o `FUNNEL_TIMER_BATCH` (D-205 item 7). */
export const REENGAGEMENT_BATCH = 200;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface ReengagementTenantResult {
  sent: number;
  discarded: number;
  failed: number;
}

export interface ReengagementService {
  runForTenant(tenantId: string, at: Date): Promise<ReengagementTenantResult>;
}

/** O pedaco do MessageService que o reingajamento usa. */
export interface AutomatedSender {
  createAutomated(tenantId: string, conversationId: string, content: string): Promise<Message>;
}

export interface ReengagementServiceDeps {
  db: DbClient;
  sender: AutomatedSender;
}

function emptyResult(): ReengagementTenantResult {
  return { sent: 0, discarded: 0, failed: 0 };
}

export function createReengagementService(deps: ReengagementServiceDeps): ReengagementService {
  const { db, sender } = deps;

  /** Reserva o disparo sob trava. `null` = o silencio mudou ou outro tique ja decidiu. */
  async function claim(
    tenantId: string,
    conversationId: string,
    anchorId: string,
    step: ReengagementStep,
    at: Date,
  ): Promise<string | null> {
    return db.withTenant(tenantId, async (tx) => {
      if (!(await repo.lockSilence(tx, tenantId, conversationId, anchorId))) return null;
      if (step === 'second') {
        const first = await repo.findDecision(tx, anchorId, 'first');
        if (first?.outcome !== 'sent') return null;
      }
      return repo.insertDecision(tx, {
        tenantId,
        conversationId,
        anchorId,
        step,
        outcome: 'sent',
        decidedAt: at,
      });
    });
  }

  async function send(
    tenantId: string,
    conversationId: string,
    anchorId: string,
    step: ReengagementStep,
    content: string,
    at: Date,
  ): Promise<'sent' | 'failed' | null> {
    const decisionId = await claim(tenantId, conversationId, anchorId, step, at);
    if (decisionId === null) return null;
    try {
      const message = await sender.createAutomated(tenantId, conversationId, content);
      await db.withTenant(tenantId, (tx) =>
        repo.finishDecision(tx, decisionId, { outcome: 'sent', messageId: message.id }),
      );
      logger.info('reengagement.sent', { tenantId, conversationId, step, messageId: message.id });
      return 'sent';
    } catch (err) {
      const messageId =
        isBusinessError(err) && typeof err.details?.messageId === 'string' ? err.details.messageId : null;
      await db.withTenant(tenantId, (tx) =>
        repo.finishDecision(tx, decisionId, { outcome: 'failed', messageId }),
      );
      logger.warn('reengagement.failed', {
        tenantId,
        conversationId,
        step,
        messageId,
        reason: isBusinessError(err) ? err.code : err instanceof Error ? err.message : String(err),
      });
      return 'failed';
    }
  }

  async function discard(
    tenantId: string,
    conversationId: string,
    anchorId: string,
    action: Extract<ReengagementAction, { kind: 'discard' }>,
    at: Date,
  ): Promise<boolean> {
    const id = await db.withTenant(tenantId, (tx) =>
      repo.insertDecision(tx, {
        tenantId,
        conversationId,
        anchorId,
        step: action.step,
        outcome: 'discarded',
        reason: action.reason,
        decidedAt: at,
      }),
    );
    if (id === null) return false;
    logger.info('reengagement.discarded', {
      tenantId,
      conversationId,
      step: action.step,
      reason: action.reason,
    });
    return true;
  }

  async function runForTenant(tenantId: string, at: Date): Promise<ReengagementTenantResult> {
    const result = emptyResult();
    const context = await db.withTenant(tenantId, async (tx) => {
      const rules = await readFunnelRules(tx, tenantId);
      if (!rules.reengagement.first.enabled) return null;
      // So WhatsApp por QR Code (D-214): na API oficial nada e considerado.
      if (!(await repo.isQrWhatsAppActive(tx, tenantId))) return null;
      const hours = await readBusinessHours(tx, tenantId);
      const span =
        rules.reengagement.first.hours + (rules.reengagement.second.enabled ? rules.reengagement.second.hours : 0);
      const since = new Date(at.getTime() - span * HOUR_MS - REENGAGEMENT_LOOKBACK_DAYS * DAY_MS);
      const silences = await repo.selectSilences(tx, tenantId, since, REENGAGEMENT_BATCH);
      const holidays = await holidayRepo.listDates(
        tx,
        tenantId,
        localDateOf(since, hours.timezone),
        localDateOf(new Date(at.getTime() + (span * HOUR_MS + REENGAGEMENT_LOOKBACK_DAYS * DAY_MS)), hours.timezone),
      );
      return { rules: rules.reengagement, hours, silences, holidays };
    });
    if (context === null) return result;

    for (const silence of context.silences) {
      const action = planReengagement(
        {
          anchorAt: new Date(silence.anchor_at),
          first:
            silence.first_outcome === null || silence.first_at === null
              ? null
              : { outcome: silence.first_outcome, decidedAt: new Date(silence.first_at) },
          secondDecided: false,
        },
        context.rules,
        at,
        context.hours,
        context.holidays,
      );
      if (action.kind === 'discard') {
        if (await discard(tenantId, silence.conversation_id, silence.anchor_id, action, at)) {
          result.discarded += 1;
        }
        continue;
      }
      if (action.kind !== 'send') continue;
      const content = context.rules[action.step].message;
      const outcome = await send(tenantId, silence.conversation_id, silence.anchor_id, action.step, content, at);
      if (outcome === 'sent') result.sent += 1;
      if (outcome === 'failed') result.failed += 1;
    }
    return result;
  }

  return { runForTenant };
}
