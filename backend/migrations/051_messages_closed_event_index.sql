-- =============================================================================
-- 051_messages_closed_event_index.sql
-- Alerta de tempo de resposta: encerrar zera a espera (CRMLAB-90, D-259 —
-- SCHEMA.md §4).
--
-- `awaitingReplySince` passa a contar da primeira mensagem do paciente depois
-- da MAIS RECENTE entre a ultima resposta humana (indice 046) e o ultimo
-- encerramento — a mensagem de sistema "Atendimento encerrado por X" (D-174),
-- a mesma fronteira do relatorio de tempo de resposta (D-257). Achar o ultimo
-- encerramento por conversa no indice geral `(conversation_id, created_at)`
-- obrigaria a pular todas as outras mensagens da conversa.
--
-- INDICE PARCIAL: so os eventos de encerramento entram, entao o ultimo e a
-- primeira entrada da conversa. A consulta (`AWAITING_REPLY_LATERAL` em
-- `conversation.repository.ts`) repete o predicado literalmente — diferente
-- disso, o planner nao usa o indice.
--
-- Sem coluna nova, sem policy: `messages` ja esta sob RLS (002). O numero 050
-- ficou reservado para o CRMLAB-88.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_messages_closed_event
  ON messages (conversation_id, created_at DESC)
  WHERE sender_type = 'system' AND content LIKE 'Atendimento encerrado%';
