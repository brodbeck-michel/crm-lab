/**
 * Teto de primeiros contatos por hora no WhatsApp por QR (CRMLAB-134, D-306).
 *
 * Chamado pelo `MessageService` ANTES de gravar a mensagem do atendente
 * (Composer, anexo, envio do orcamento, "Nova conversa", "tentar de novo"):
 * recusado aqui, nada e gravado nem enviado. Automacoes nao passam por aqui
 * (D-306 item 4).
 *
 * Duas chamadas simultaneas podem passar do teto por 1 (D-306 item 7): o
 * objetivo e cortar rajada, nao contar exato — por isso nao ha lock.
 */
import type { DbClient } from '../db/types.js';
import { BusinessError } from '../http/errors.js';
import { logger } from '../lib/logger.js';
import { countRecentFirstContacts, isFirstContact } from '../repositories/first-contact.repository.js';
import { isQrWhatsAppActive } from '../repositories/reengagement.repository.js';
import { readFunnelRules } from './funnel-rules.service.js';

export interface FirstContactGuard {
  /** Lanca `FIRST_CONTACT_LIMIT_REACHED` quando o envio passaria do teto. */
  assertAllowed(tenantId: string, conversationId: string): Promise<void>;
}

export function createFirstContactGuard(deps: { db: DbClient }): FirstContactGuard {
  const { db } = deps;
  return {
    async assertAllowed(tenantId, conversationId) {
      await db.withTenant(tenantId, async (tx) => {
        const { firstContactLimit } = await readFunnelRules(tx, tenantId);
        if (!firstContactLimit.enabled) return;
        if (!(await isQrWhatsAppActive(tx, tenantId))) return;
        if (!(await isFirstContact(tx, tenantId, conversationId))) return;
        const recent = await countRecentFirstContacts(tx, tenantId);
        if (recent.total < firstContactLimit.perHour) return;
        logger.warn('whatsapp.first_contact_limited', {
          tenantId,
          conversationId,
          limit: firstContactLimit.perHour,
          recent: recent.total,
        });
        throw new BusinessError('FIRST_CONTACT_LIMIT_REACHED', {
          limit: firstContactLimit.perHour,
          retryAt: recent.nextSlotAt,
        });
      });
    },
  };
}
