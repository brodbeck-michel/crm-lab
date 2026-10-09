/**
 * Acesso a `conversation_auto_replies` e as leituras da resposta automatica
 * (SCHEMA.md §40 — CRMLAB-94, D-264). Toda funcao roda na transacao de quem
 * chama, sob RLS.
 */
import type { AutoReplyKind } from '@crm-lab/shared';
import type { DbTx } from '../db/types.js';

/**
 * A mensagem e a PRIMEIRA da conversa? Nenhuma outra, de qualquer lado,
 * anterior a ela (D-264 item 7). Duas primeiras concorrentes: so a mais antiga
 * responde `true`.
 */
export async function isFirstMessage(tx: DbTx, conversationId: string, messageId: string): Promise<boolean> {
  const result = await tx.query<{ id: string }>(
    `SELECT o.id
       FROM messages m
       JOIN messages o ON o.conversation_id = m.conversation_id AND o.id <> m.id
      WHERE m.id = $1 AND m.conversation_id = $2
        AND (o.created_at, o.id) < (m.created_at, m.id)
      LIMIT 1`,
    [messageId, conversationId],
  );
  return result.rows.length === 0;
}

/**
 * Reserva a resposta (D-264 item 4). So grava se a conversa e `active` de
 * `whatsapp`; `null` quando nao e ou quando ja havia resposta deste tipo no
 * periodo (indices unicos parciais) — outro webhook chegou antes.
 */
export async function claim(
  tx: DbTx,
  input: {
    tenantId: string;
    conversationId: string;
    kind: AutoReplyKind;
    reopensAt: Date | null;
    triggerMessageId: string;
  },
): Promise<string | null> {
  const result = await tx.query<{ id: string }>(
    `INSERT INTO conversation_auto_replies
            (tenant_id, conversation_id, kind, reopens_at, trigger_message_id, outcome)
     SELECT $1, c.id, $3, $4::timestamp, $5, 'sent'
       FROM conversations c
      WHERE c.id = $2 AND c.tenant_id = $1 AND c.status = 'active' AND c.channel = 'whatsapp'
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      input.tenantId,
      input.conversationId,
      input.kind,
      input.reopensAt ? input.reopensAt.toISOString() : null,
      input.triggerMessageId,
    ],
  );
  return result.rows[0]?.id ?? null;
}

/** Resultado do envio: a mensagem gravada e, se o canal recusou, `failed`. */
export async function finish(
  tx: DbTx,
  id: string,
  input: { outcome: 'sent' | 'failed'; messageId: string | null },
): Promise<void> {
  await tx.query(`UPDATE conversation_auto_replies SET outcome = $2, message_id = $3 WHERE id = $1`, [
    id,
    input.outcome,
    input.messageId,
  ]);
}
