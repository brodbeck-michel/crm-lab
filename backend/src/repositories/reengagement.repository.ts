/**
 * Acesso a `conversation_reengagements` e as leituras do reingajamento
 * (SCHEMA.md §33 — CRMLAB-62, D-211/D-212). Toda funcao roda na transacao de
 * quem chama, sob RLS.
 *
 * O SILENCIO de uma conversa e identificado pela ultima mensagem de pessoa do
 * laboratorio (`sender_type = 'agent'` e `automation` nulo — CRM ou celular):
 * a ancora. Mensagem automatica nunca vira ancora (D-211 item 2).
 */
import type { ReengagementDiscardReason, ReengagementOutcome, ReengagementStep } from '@crm-lab/shared';
import type { DbTx } from '../db/types.js';

const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** O canal WhatsApp do laboratorio esta ativo e conectado por QR Code? (D-214) */
export async function isQrWhatsAppActive(tx: DbTx, tenantId: string): Promise<boolean> {
  const result = await tx.query<{ id: string }>(
    `SELECT id FROM tenant_channels
      WHERE tenant_id = $1 AND channel = 'whatsapp' AND is_active = TRUE AND connection_mode = 'qr'`,
    [tenantId],
  );
  return result.rows.length > 0;
}

export interface SilenceRow {
  conversation_id: string;
  anchor_id: string;
  anchor_at: string;
  first_outcome: ReengagementOutcome | null;
  first_at: string | null;
}

const ANCHOR_LATERAL = `JOIN LATERAL (
         SELECT m.id, m.created_at
           FROM messages m
          WHERE m.conversation_id = c.id AND m.sender_type = 'agent' AND m.automation IS NULL
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT 1
       ) a ON TRUE`;

const PATIENT_AFTER_ANCHOR = `EXISTS (
         SELECT 1 FROM messages p
          WHERE p.conversation_id = c.id AND p.sender_type = 'patient' AND p.created_at > a.created_at
       )`;

/**
 * Silencios em aberto: conversa ativa de WhatsApp cuja ancora e posterior a
 * `since`, sem mensagem do paciente depois dela e sem o 2º decidido. Da mais
 * antiga para a mais nova.
 */
export async function selectSilences(
  tx: DbTx,
  tenantId: string,
  since: Date,
  limit: number,
): Promise<SilenceRow[]> {
  const result = await tx.query<SilenceRow>(
    `SELECT c.id AS conversation_id, a.id AS anchor_id,
            to_char(a.created_at, ${ISO_UTC}) AS anchor_at,
            f.outcome AS first_outcome,
            to_char(f.decided_at, ${ISO_UTC}) AS first_at
       FROM conversations c
       ${ANCHOR_LATERAL}
       LEFT JOIN conversation_reengagements f ON f.anchor_message_id = a.id AND f.step = 'first'
      WHERE c.tenant_id = $1 AND c.status = 'active' AND c.channel = 'whatsapp'
        AND c.last_message_at >= $2::timestamp
        AND a.created_at >= $2::timestamp
        AND NOT ${PATIENT_AFTER_ANCHOR}
        AND NOT EXISTS (
              SELECT 1 FROM conversation_reengagements s
               WHERE s.anchor_message_id = a.id AND s.step = 'second')
      ORDER BY a.created_at ASC, c.id ASC
      LIMIT $3`,
    [tenantId, since.toISOString(), limit],
  );
  return result.rows;
}

/**
 * Reconfere o silencio com a conversa TRAVADA (`FOR UPDATE`): ainda ativa, de
 * WhatsApp, com a mesma ancora e sem resposta do paciente. E o que impede
 * mandar para quem respondeu ou foi encerrado entre a leitura e o envio.
 */
export async function lockSilence(
  tx: DbTx,
  tenantId: string,
  conversationId: string,
  anchorId: string,
): Promise<boolean> {
  const locked = await tx.query<{ id: string }>(
    `SELECT id FROM conversations
      WHERE id = $1 AND tenant_id = $2 AND status = 'active' AND channel = 'whatsapp'
      FOR UPDATE`,
    [conversationId, tenantId],
  );
  if (locked.rows.length === 0) return false;
  const still = await tx.query<{ anchor_id: string }>(
    `SELECT a.id AS anchor_id
       FROM conversations c
       ${ANCHOR_LATERAL}
      WHERE c.id = $1 AND NOT ${PATIENT_AFTER_ANCHOR}`,
    [conversationId],
  );
  return still.rows[0]?.anchor_id === anchorId;
}

/** O 1º do silencio, lido de novo dentro da trava. */
export async function findDecision(
  tx: DbTx,
  anchorId: string,
  step: ReengagementStep,
): Promise<{ id: string; outcome: ReengagementOutcome } | null> {
  const result = await tx.query<{ id: string; outcome: ReengagementOutcome }>(
    `SELECT id, outcome FROM conversation_reengagements WHERE anchor_message_id = $1 AND step = $2`,
    [anchorId, step],
  );
  return result.rows[0] ?? null;
}

/**
 * Grava a decisao. `null` quando o disparo ja estava decidido (UNIQUE
 * `(anchor_message_id, step)`): outro tique chegou antes, nada a fazer.
 */
export async function insertDecision(
  tx: DbTx,
  input: {
    tenantId: string;
    conversationId: string;
    anchorId: string;
    step: ReengagementStep;
    outcome: ReengagementOutcome;
    reason?: ReengagementDiscardReason | null;
    decidedAt: Date;
  },
): Promise<string | null> {
  const result = await tx.query<{ id: string }>(
    `INSERT INTO conversation_reengagements
            (tenant_id, conversation_id, anchor_message_id, step, outcome, reason, decided_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7::timestamp)
     ON CONFLICT (anchor_message_id, step) DO NOTHING
     RETURNING id`,
    [
      input.tenantId,
      input.conversationId,
      input.anchorId,
      input.step,
      input.outcome,
      input.reason ?? null,
      input.decidedAt.toISOString(),
    ],
  );
  return result.rows[0]?.id ?? null;
}

/** Resultado do envio: a mensagem gravada e, se o canal recusou, `failed`. */
export async function finishDecision(
  tx: DbTx,
  id: string,
  input: { outcome: 'sent' | 'failed'; messageId: string | null },
): Promise<void> {
  await tx.query(
    `UPDATE conversation_reengagements SET outcome = $2, message_id = $3 WHERE id = $1`,
    [id, input.outcome, input.messageId],
  );
}
