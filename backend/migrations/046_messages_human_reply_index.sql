-- =============================================================================
-- 046_messages_human_reply_index.sql
-- Alerta de tempo de resposta (CRMLAB-84, D-254 — SCHEMA.md §4).
--
-- A lista de conversas passa a devolver `awaitingReplySince`: a primeira
-- mensagem do paciente depois da ULTIMA resposta de pessoa do laboratorio
-- (`sender_type = 'agent'` e `automation` nulo — CRM ou celular, a mesma
-- ancora do reingajamento, SCHEMA.md §33). Achar essa ultima resposta por
-- conversa e o passo caro: no indice geral `(conversation_id, created_at)`
-- o planner teria de pular as mensagens do paciente, automaticas e de
-- sistema ate achar uma da atendente.
--
-- INDICE PARCIAL: so as respostas humanas entram, entao a ultima e a primeira
-- entrada do indice da conversa. A consulta (`AWAITING_REPLY_LATERAL` em
-- `conversation.repository.ts`) repete o predicado literalmente — diferente
-- disso, o planner nao usa o indice. O reingajamento (`ANCHOR_LATERAL`)
-- tambem se beneficia.
--
-- Sem coluna nova, sem policy: `messages` ja esta sob RLS (002).
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_messages_human_reply
  ON messages (conversation_id, created_at DESC)
  WHERE sender_type = 'agent' AND automation IS NULL;
