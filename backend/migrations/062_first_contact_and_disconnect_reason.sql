-- =============================================================================
-- 062_first_contact_and_disconnect_reason.sql
-- CRMLAB-134 (D-305, D-307): proteção contra nova restrição do WhatsApp por QR.
-- SCHEMA.md §46.
--
-- 1. Índice parcial para "o paciente já escreveu nesta conversa?" (D-305): o
--    `EXISTS` da lista de conversas e a conta de primeiros contatos (D-306)
--    procuram a mensagem do paciente por conversa. O predicado do índice é o
--    MESMO da consulta (`sender_type = 'patient'`), senão o planner não o usa.
--
-- 2. Motivo da última queda do WhatsApp por QR (D-307). Só colunas NULÁVEIS:
--    linha antiga fica "sem registro de queda" (`lastDisconnect: null`).
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_messages_patient_conversation
  ON messages (conversation_id)
  WHERE sender_type = 'patient';

ALTER TABLE tenant_channels
  ADD COLUMN IF NOT EXISTS disconnected_at TIMESTAMP NULL,
  ADD COLUMN IF NOT EXISTS disconnect_reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS disconnect_status_code INTEGER NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_channels_disconnect_reason_check'
  ) THEN
    ALTER TABLE tenant_channels
      ADD CONSTRAINT tenant_channels_disconnect_reason_check
      CHECK (disconnect_reason IS NULL OR disconnect_reason IN ('manual', 'logged_out', 'other'));
  END IF;
END $$;
