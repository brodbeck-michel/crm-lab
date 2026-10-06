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
 *   - RESPOSTA HUMANA (`R`): `sender_type = 'agent'` e `automation` nulo (CRM
 *     ou celular) — a ancora do reingajamento e do alerta. Automatica e de
 *     sistema nao respondem nem encerram a espera: nem entram na sequencia.
 *   - ENCERRAMENTO (`C`): a mensagem de sistema "Atendimento encerrado por X"
 *     (D-174 item 2). Fecha o bloco SEM resposta: sem isso, o "obrigado" do
 *     paciente antes de encerrar ganharia como resposta a da proxima conversa,
 *     semanas depois.
 *   - INICIO DO BLOCO: mensagem do paciente (`P`) cuja anterior na sequencia
 *     nao e do paciente. E a PRIMEIRA do bloco que conta, como no
 *     `awaitingReplySince`.
 *
 * O bloco "abre o atendimento" (`opens`, primeira resposta) quando nao ha nada
 * antes dele (conversa nova) ou quando o anterior e um encerramento (conversa
 * que voltou).
 *
 * COMO: uma passada so, com janela. As conversas sao as que tem mensagem do
 * paciente no periodo; delas vem a sequencia P/R/C inteira (o bloco pode ter
 * comecado antes e a resposta vir depois do periodo). `grp` conta as fronteiras
 * ate a linha: o bloco de `grp = n` termina na fronteira de `grp = n + 1`.
 * Uma versao anterior, com LATERAL/NOT EXISTS por mensagem, ficava quadratica
 * quando o planner nao acertava o indice — a janela e linear no numero de
 * mensagens das conversas tocadas (um sort + um hash join).
 *
 * Performance: `convs` usa o indice parcial `idx_messages_patient_tenant_created`
 * (049) — o predicado e repetido LITERALMENTE; a sequencia sai de
 * `idx_messages_conversation_id`.
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
    `WITH convs AS (
       SELECT DISTINCT m.conversation_id
         FROM messages m
        WHERE m.tenant_id = $1 AND m.sender_type = 'patient'
          AND m.created_at >= $2::timestamp AND m.created_at < $3::timestamp
     ),
     seq AS (
       -- Resposta de participante conta para a dona do momento (D-263 item 6).
       SELECT m.conversation_id, m.id, m.created_at,
              COALESCE(m.attributed_to, m.sender_id) AS sender_id,
              CASE WHEN m.sender_type = 'patient' THEN 'P'
                   WHEN m.sender_type = 'agent' THEN 'R'
                   ELSE 'C' END AS kind
         FROM messages m
         JOIN convs v ON v.conversation_id = m.conversation_id
        WHERE m.tenant_id = $1
          AND (m.sender_type = 'patient'
               OR (m.sender_type = 'agent' AND m.automation IS NULL)
               OR (m.sender_type = 'system' AND m.content LIKE ${CLOSED_EVENT}))
     ),
     marked AS (
       SELECT s.*,
              LAG(s.kind) OVER w AS prev_kind,
              COUNT(*) FILTER (WHERE s.kind <> 'P') OVER (w ROWS UNBOUNDED PRECEDING) AS grp
         FROM seq s
       WINDOW w AS (PARTITION BY s.conversation_id ORDER BY s.created_at, s.id)
     ),
     blocks AS (
       SELECT conversation_id, created_at, grp,
              (prev_kind IS NULL OR prev_kind = 'C') AS opens
         FROM marked
        WHERE kind = 'P' AND (prev_kind IS NULL OR prev_kind <> 'P')
          AND created_at >= $2::timestamp AND created_at < $3::timestamp
     ),
     ends AS (
       SELECT conversation_id, grp, kind, created_at, sender_id
         FROM marked
        WHERE kind <> 'P'
     )
     SELECT b.conversation_id,
            to_char(b.created_at, ${ISO_UTC}) AS waiting_since,
            b.opens,
            CASE WHEN e.kind = 'R' THEN to_char(e.created_at, ${ISO_UTC}) END AS replied_at,
            CASE WHEN e.kind = 'R' THEN e.sender_id END AS responder_id,
            CASE WHEN e.kind = 'R' THEN u.name END AS responder_name,
            (e.kind = 'C' OR (e.kind IS NULL AND c.status = 'closed')) AS closed_unanswered
       FROM blocks b
       JOIN conversations c ON c.id = b.conversation_id AND c.tenant_id = $1
       LEFT JOIN ends e ON e.conversation_id = b.conversation_id AND e.grp = b.grp + 1
       LEFT JOIN users u ON u.id = e.sender_id AND u.tenant_id = $1
      ORDER BY b.created_at ASC`,
    [tenantId, startUtc, endUtc],
  );
  return result.rows;
}
