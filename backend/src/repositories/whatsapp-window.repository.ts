/**
 * Leituras da janela de 24 h da Cloud API (CRMLAB-137, D-310). Rodam na
 * transacao de quem chama, sob RLS, e ainda filtram `tenant_id` (regra 1).
 *
 * O relogio e o do BANCO (`now()`), o mesmo que carimba `messages.created_at`:
 * nada depende do relogio do cliente nem do da aplicacao. O predicado
 * `sender_type = 'patient'` fica literal para usar `idx_messages_patient_conversation`.
 * Mensagem do paciente apagada nao conta (D-310 item 1).
 */
import type { DbTx } from '../db/types.js';

/** O canal WhatsApp do laboratorio tem linha em `cloud_api` (API oficial da Meta)? */
export async function isCloudApiWhatsApp(tx: DbTx, tenantId: string): Promise<boolean> {
  const result = await tx.query<{ id: string }>(
    `SELECT id FROM tenant_channels
      WHERE tenant_id = $1 AND channel = 'whatsapp' AND connection_mode = 'cloud_api'`,
    [tenantId],
  );
  return result.rows.length > 0;
}

export interface WindowRow {
  /** ISO UTC da ultima mensagem do paciente; `null` = nunca escreveu. */
  lastPatientMessageAt: string | null;
  /** Segundos ate fechar, pelo relogio do banco (pode ser negativo); `null` sem mensagem. */
  remainingSeconds: number | null;
}

export async function readWindow(
  tx: DbTx,
  tenantId: string,
  conversationId: string,
  windowHours: number,
): Promise<WindowRow> {
  const result = await tx.query<{ last_at: string | null; remaining: number | string | null }>(
    `SELECT to_char(MAX(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_at,
            EXTRACT(EPOCH FROM (MAX(created_at) + make_interval(hours => $3) - (now() AT TIME ZONE 'UTC'))) AS remaining
       FROM messages
      WHERE tenant_id = $1 AND conversation_id = $2 AND sender_type = 'patient'
        AND deleted_at IS NULL`,
    [tenantId, conversationId, windowHours],
  );
  const row = result.rows[0];
  return {
    lastPatientMessageAt: row?.last_at ?? null,
    remainingSeconds: row?.remaining == null ? null : Number(row.remaining),
  };
}
