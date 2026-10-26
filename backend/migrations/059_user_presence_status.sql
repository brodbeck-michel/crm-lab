-- =============================================================================
-- 059_user_presence_status.sql
-- CRMLAB-120 (D-286): ultimo status que a atendente ESCOLHEU (Online, Ocupado,
-- Ausente). SCHEMA.md §44.
--
-- `offline` nao e gravado: vem de nao haver aba aberta (memoria do
-- WebSocketHub). A inatividade de 30 min tambem fica so em memoria.
-- Coluna nova numa tabela que ja tem policy (002): nada de RLS aqui.
-- =============================================================================

ALTER TABLE users
  ADD COLUMN presence_status VARCHAR(10) NOT NULL DEFAULT 'online'
    CHECK (presence_status IN ('online', 'busy', 'away'));
