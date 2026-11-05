-- =============================================================================
-- 063_channel_waba_id.sql
-- CRMLAB-138 (D-308): modo do canal WhatsApp escolhido pelo gestor e credenciais
-- da Cloud API por laboratorio. SCHEMA.md §15.
--
-- `waba_id` = id da conta WhatsApp Business (Meta) do laboratorio. Nao e segredo
-- (vai em claro, como `phone_number_id`). Coluna NULAVEL: linha antiga fica sem WABA.
-- =============================================================================

ALTER TABLE tenant_channels
  ADD COLUMN IF NOT EXISTS waba_id TEXT NULL;
