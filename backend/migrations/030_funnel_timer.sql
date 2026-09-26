-- =============================================================================
-- 030_funnel_timer.sql
-- CRMLAB-59 (D-207/D-208): motor de tempo do funil. SCHEMA.md §10.
--
-- Duas colunas em `proposal_status_history`, nulas em toda linha existente
-- (sem backfill). A tabela ja esta sob RLS desde a 002: coluna nova nao muda
-- a policy.
--   automation       -> { rule, days, dayCounting } quando o motor moveu o cartao
--   stale_alerted_at -> o alerta de "Novo orcamento" parado ja saiu para ESTA
--                       entrada na coluna ("uma vez por entrada")
-- =============================================================================

ALTER TABLE proposal_status_history
  ADD COLUMN automation JSONB NULL,
  ADD COLUMN stale_alerted_at TIMESTAMP NULL;
