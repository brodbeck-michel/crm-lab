-- =============================================================================
-- 049_messages_patient_period_index.sql
-- Relatório de tempo de resposta (CRMLAB-83, D-257 — SCHEMA.md §4).
--
-- `GET /analytics/response-time` começa pelas mensagens do PACIENTE do
-- laboratório num período de até 93 dias. Os índices que existiam eram só de
-- `tenant_id` ou só de `created_at`: o planner teria de escolher um e filtrar
-- o resto, varrendo as mensagens de todos os laboratórios do período (ou todo o
-- histórico de um laboratório).
--
-- ÍNDICE PARCIAL: só as mensagens do paciente entram (é delas que o relatório
-- parte: quais conversas tiveram paciente escrevendo no período). A consulta
-- (CTE `convs` em `response-time.repository.ts`) repete o predicado
-- literalmente — diferente disso, o planner não usa o índice. A sequência de
-- cada conversa vem depois pelo índice de `conversation_id`.
--
-- Sem coluna nova, sem policy: `messages` já está sob RLS (002). O número 048
-- ficou reservado para o CRMLAB-87.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_messages_patient_tenant_created
  ON messages (tenant_id, created_at)
  WHERE sender_type = 'patient';
