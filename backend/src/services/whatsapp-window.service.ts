/**
 * Janela de 24 h da API oficial da Meta (CRMLAB-137, D-310).
 *
 * No canal `cloud_api`, texto livre e anexo so saem se o paciente escreveu nas
 * ultimas 24 h (a ultima mensagem DO PACIENTE conta, nunca a da atendente).
 * Fora disso a Meta so aceita template aprovado (frente F2). O modo `qr`
 * (Evolution) nao tem essa regra e nunca passa por aqui.
 *
 * Chamado pelo `MessageService` ANTES de gravar qualquer mensagem de saida
 * (Composer, anexo, orcamento, "Nova conversa", "tentar de novo", automacoes):
 * recusado, nada e gravado nem enviado.
 */
import { WHATSAPP_WINDOW_HOURS } from '@crm-lab/shared';
import type { WhatsAppWindowStatus } from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import { BusinessError } from '../http/errors.js';
import { logger } from '../lib/logger.js';
import { isCloudApiWhatsApp, readWindow } from '../repositories/whatsapp-window.repository.js';

export interface WhatsAppWindowGuard {
  /** `null` = sem restricao (canal nao e `cloud_api`). */
  status(tenantId: string, conversationId: string): Promise<WhatsAppWindowStatus | null>;
  /** Lanca `WHATSAPP_WINDOW_CLOSED` quando a janela esta fechada. */
  assertOpen(tenantId: string, conversationId: string): Promise<void>;
}

export function createWhatsAppWindowGuard(deps: { db: DbClient }): WhatsAppWindowGuard {
  const { db } = deps;

  async function status(
    tenantId: string,
    conversationId: string,
  ): Promise<WhatsAppWindowStatus | null> {
    return db.withTenant(tenantId, async (tx) => {
      if (!(await isCloudApiWhatsApp(tx, tenantId))) return null;
      const row = await readWindow(tx, tenantId, conversationId, WHATSAPP_WINDOW_HOURS);
      if (row.lastPatientMessageAt === null || row.remainingSeconds === null) {
        return { open: false, remainingSeconds: 0, expiresAt: null, lastPatientMessageAt: null };
      }
      // `ceil`: com menos de 1 s, ainda aberta tem que dar 1, nunca 0.
      const remainingSeconds = Math.max(0, Math.ceil(row.remainingSeconds));
      return {
        open: row.remainingSeconds > 0,
        remainingSeconds,
        expiresAt: new Date(
          Date.parse(row.lastPatientMessageAt) + WHATSAPP_WINDOW_HOURS * 3_600_000,
        ).toISOString(),
        lastPatientMessageAt: row.lastPatientMessageAt,
      };
    });
  }

  return {
    status,
    async assertOpen(tenantId, conversationId) {
      const current = await status(tenantId, conversationId);
      if (current === null || current.open) return;
      logger.warn('whatsapp.window_closed', {
        tenantId,
        conversationId,
        lastPatientMessageAt: current.lastPatientMessageAt,
      });
      // `details` de API_ERRORS (D-310 item 2): datas ISO UTC ou `null`.
      throw new BusinessError('WHATSAPP_WINDOW_CLOSED', {
        conversationId,
        lastPatientMessageAt: current.lastPatientMessageAt,
        windowClosedAt: current.expiresAt,
      });
    },
  };
}
