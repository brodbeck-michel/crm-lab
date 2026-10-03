/**
 * Leitura do relatorio de tempo de resposta (CRMLAB-83, D-257 — SERVICES.md §9).
 * Roda na transacao de quem chama, sob RLS. SO LEITURA.
 *
 * A query devolve UMA LINHA POR BLOCO de mensagens seguidas do paciente cujo
 * inicio cai no periodo. O calculo dos minutos uteis fica no service, em TS,
 * com o mesmo `businessMinutesBetween` do alerta (D-254): expediente e
 * feriados nao cabem em SQL sem duplicar a regra.
 *
 * As tres fronteiras, na ordem de uma conversa:
 *   - RESPOSTA HUMANA: `sender_type = 'agent'` e `automation` nulo (CRM ou
 *     celular) — a ancora do reingajamento e do alerta. Automatica e de
 *     sistema nao respondem nem encerram a espera.
 *   - ENCERRAMENTO: a mensagem de sistema "Atendimento encerrado por X"
 *     (D-174 item 2). Fecha o bloco SEM resposta: sem isso, o "obrigado" do
 *     paciente antes de encerrar ganharia como resposta a da proxima conversa,
 *     semanas depois.
 *   - INICIO DO BLOCO: mensagem do paciente sem outra do paciente entre ela e a
 *     ultima fronteira (resposta ou encerramento). E a PRIMEIRA do bloco que
 *     conta, como no `awaitingReplySince`.
 *
 * O bloco "abre o atendimento" (`opens`, primeira resposta) quando nao ha
 * resposta humana antes dele (conversa nova) ou quando a ultima fronteira e um
 * encerramento (conversa que voltou).
 *
 * Performance: `patient_msgs` usa o indice parcial
 * `idx_messages_patient_tenant_created` (049) — o predicado e repetido
 * LITERALMENTE. A ultima resposta antes e a proxima depois saem do
 * `idx_messages_human_reply` (046), tambem com o predicado literal. O resto
 * sao faixas curtas do `idx_messages_conversation_created`, entre uma
 * fronteira e o bloco.
 */
import type { DbTx } from '../db/types.js';

const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** Texto fixo do evento de encerramento (`conversation.service.ts`, D-174). */
const CLOSED_EVENT = `'Atendimento encerrado%'`;

export interface ResponseBlockRow {
  conversation_id: string;
  /** Primeira mensagem do bloco, ISO UTC. */
  waiting_since: string;
  /** O bloco abre o atendimento (conversa nova ou que voltou de encerrada). */
  opens: boolean;
  /** Proxima resposta humana, ISO UTC; `null` = nao houve. */
  replied_at: string | null;
  /** Quem respondeu; `null` com `replied_at` preenchido = celular. */
  responder_id: string | null;
  responder_name: string | null;
  /** Encerrado antes de qualquer resposta (evento de sistema ou status atual). */
  closed_unanswered: boolean;
}

/**
 * Blocos que COMECAM em `[startUtc, endUtc)`. A resposta pode vir depois do
 * fim do periodo: o bloco pertence ao dia em que o paciente esperou.
 */
export async function listBlocks(
  tx: DbTx,
  tenantId: string,
  startUtc: string,
  endUtc: string,
): Promise<ResponseBlockRow[]> {
  const result = await tx.query<ResponseBlockRow>(
    `WITH patient_msgs AS (
       SELECT m.id, m.conversation_id, m.created_at
         FROM messages m
        WHERE m.tenant_id = $1 AND m.sender_type = 'patient'
          AND m.created_at >= $2::timestamp AND m.created_at < $3::timestamp
     ),
     blocks AS (
       SELECT p.conversation_id, p.created_at,
              (lr.created_at IS NULL OR lc.created_at IS NOT NULL) AS opens
         FROM patient_msgs p
         LEFT JOIN LATERAL (
           SELECT h.created_at FROM messages h
            WHERE h.conversation_id = p.conversation_id
              AND h.sender_type = 'agent' AND h.automation IS NULL
              AND h.created_at < p.created_at
            ORDER BY h.created_at DESC
            LIMIT 1
         ) lr ON TRUE
         LEFT JOIN LATERAL (
           SELECT s.created_at FROM messages s
            WHERE s.conversation_id = p.conversation_id
              AND s.sender_type = 'system' AND s.content LIKE ${CLOSED_EVENT}
              AND s.created_at < p.created_at
              AND (lr.created_at IS NULL OR s.created_at > lr.created_at)
            ORDER BY s.created_at DESC
            LIMIT 1
         ) lc ON TRUE
        WHERE NOT EXISTS (
          SELECT 1 FROM messages q
           WHERE q.conversation_id = p.conversation_id
             AND q.sender_type = 'patient'
             AND q.created_at <= p.created_at
             AND (q.created_at, q.id) < (p.created_at, p.id)
             AND q.created_at > COALESCE(GREATEST(lr.created_at, lc.created_at), '-infinity'::timestamp)
        )
     )
     SELECT b.conversation_id,
            to_char(b.created_at, ${ISO_UTC}) AS waiting_since,
            b.opens,
            to_char(r.created_at, ${ISO_UTC}) AS replied_at,
            r.sender_id AS responder_id,
            u.name AS responder_name,
            (
              EXISTS (
                SELECT 1 FROM messages s
                 WHERE s.conversation_id = b.conversation_id
                   AND s.sender_type = 'system' AND s.content LIKE ${CLOSED_EVENT}
                   AND s.created_at > b.created_at
                   AND (r.created_at IS NULL OR s.created_at < r.created_at)
              )
              OR (r.created_at IS NULL AND c.status = 'closed')
            ) AS closed_unanswered
       FROM blocks b
       JOIN conversations c ON c.id = b.conversation_id AND c.tenant_id = $1
       LEFT JOIN LATERAL (
         SELECT n.created_at, n.sender_id FROM messages n
          WHERE n.conversation_id = b.conversation_id
            AND n.sender_type = 'agent' AND n.automation IS NULL
            AND n.created_at > b.created_at
          ORDER BY n.created_at ASC
          LIMIT 1
       ) r ON TRUE
       LEFT JOIN users u ON u.id = r.sender_id AND u.tenant_id = $1
      ORDER BY b.created_at ASC`,
    [tenantId, startUtc, endUtc],
  );
  return result.rows;
}
