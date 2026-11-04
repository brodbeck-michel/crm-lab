/**
 * Leituras do "primeiro contato" (CRMLAB-134, D-305/D-306). Rodam na transacao
 * de quem chama, sob RLS, e ainda filtram `tenant_id` (CLAUDE.md regra 1).
 *
 * Primeiro contato = mensagem de atendente para uma conversa sem NENHUMA
 * mensagem do paciente e sem nenhuma mensagem de atendente que nao tenha
 * falhado. Mensagem de sistema nao conta. A procura pela mensagem do paciente
 * usa `idx_messages_patient_conversation` (062): o predicado
 * `sender_type = 'patient'` precisa ficar literal.
 */
import type { DbTx } from '../db/types.js';

const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** Enviar para esta conversa agora seria primeiro contato? */
export async function isFirstContact(
  tx: DbTx,
  tenantId: string,
  conversationId: string,
): Promise<boolean> {
  const result = await tx.query<{ first: boolean }>(
    `SELECT NOT EXISTS (
              SELECT 1 FROM messages p
               WHERE p.conversation_id = $2 AND p.tenant_id = $1 AND p.sender_type = 'patient'
            )
        AND NOT EXISTS (
              SELECT 1 FROM messages a
               WHERE a.conversation_id = $2 AND a.tenant_id = $1
                 AND a.sender_type = 'agent' AND a.status <> 'failed'
            ) AS first`,
    [tenantId, conversationId],
  );
  return result.rows[0]?.first === true;
}

export interface RecentFirstContacts {
  total: number;
  /** Quando o contato mais antigo da janela sai dela (ISO UTC); `null` sem contatos. */
  nextSlotAt: string | null;
}

/**
 * Primeiros contatos da janela movel de 60 min (D-306 item 3): conversas de
 * WhatsApp do laboratorio, ainda sem mensagem do paciente, cuja PRIMEIRA
 * mensagem de atendente nao falhada caiu na ultima hora. Parte das mensagens
 * recentes (indice por `created_at`) para nao varrer o historico inteiro.
 */
export async function countRecentFirstContacts(
  tx: DbTx,
  tenantId: string,
): Promise<RecentFirstContacts> {
  const result = await tx.query<{ total: number | string; next_slot_at: string | null }>(
    `SELECT COUNT(*)::int AS total,
            to_char(MIN(r.first_at) + INTERVAL '1 hour', ${ISO_UTC}) AS next_slot_at
       FROM (
         SELECT m.conversation_id, MIN(m.created_at) AS first_at
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id AND c.tenant_id = $1
          WHERE m.tenant_id = $1
            AND c.channel = 'whatsapp'
            AND m.sender_type = 'agent'
            AND m.status <> 'failed'
            AND m.created_at > NOW() - INTERVAL '1 hour'
          GROUP BY m.conversation_id
       ) r
      WHERE NOT EXISTS (
              SELECT 1 FROM messages p
               WHERE p.conversation_id = r.conversation_id AND p.sender_type = 'patient'
            )
        AND NOT EXISTS (
              SELECT 1 FROM messages e
               WHERE e.conversation_id = r.conversation_id
                 AND e.sender_type = 'agent' AND e.status <> 'failed'
                 AND e.created_at <= NOW() - INTERVAL '1 hour'
            )`,
    [tenantId],
  );
  const row = result.rows[0];
  return { total: Number(row?.total ?? 0), nextSlotAt: row?.next_slot_at ?? null };
}
