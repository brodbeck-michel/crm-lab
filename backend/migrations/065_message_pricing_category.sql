-- =============================================================================
-- 065_message_pricing_category.sql
-- CRMLAB-141 (D-312): custo estimado da Cloud API. SCHEMA.md §47 (uma migracao
-- por card: 063 = 138, 064 = 136, 065 = 141, 066 = 137).
--
-- `messages.pricing_category` = categoria de COBRANCA da Meta da mensagem
-- enviada pelo CRM pela Cloud API: `service` (texto/anexo dentro da janela) ou
-- a categoria do modelo (D-309), corrigida pelo `pricing.category` do webhook
-- de status (a Meta e quem cobra). `qr`, paciente e mensagens antigas: NULL.
--
-- `whatsapp_price_table` e GLOBAL da instalacao (preco e da Meta, igual para
-- todos os laboratorios): sem tenant_id, sem RLS — a excecao consciente do
-- SCHEMA §47. `crm_app` so LE; reajuste = linha nova com `effective_from`
-- futuro, feita por quem opera a plataforma (script/migracao), nunca pela tela.
-- Seed: valores oficiais em BRL vigentes desde 01/10/2026.
-- =============================================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS pricing_category VARCHAR(20) NULL
    CONSTRAINT messages_pricing_category_check
    CHECK (pricing_category IS NULL
           OR pricing_category IN ('service', 'utility', 'marketing', 'authentication'));

CREATE TABLE IF NOT EXISTS whatsapp_price_table (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category VARCHAR(20) NOT NULL
    CONSTRAINT whatsapp_price_table_category_check
    CHECK (category IN ('service', 'utility', 'marketing', 'authentication')),
  price_brl NUMERIC(10,4) NOT NULL CHECK (price_brl >= 0),
  effective_from DATE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT whatsapp_price_table_category_effective_key UNIQUE (category, effective_from)
);

INSERT INTO whatsapp_price_table (category, price_brl, effective_from) VALUES
  ('marketing', 0.3217, '2026-10-01'),
  ('utility', 0.0350, '2026-10-01'),
  ('authentication', 0.0350, '2026-10-01'),
  ('service', 0.0350, '2026-10-01')
ON CONFLICT (category, effective_from) DO NOTHING;

-- O DEFAULT PRIVILEGES da 002 daria escrita ao `crm_app`; preco nao e dado de
-- laboratorio, entao a aplicacao so le.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
    REVOKE INSERT, UPDATE, DELETE ON whatsapp_price_table FROM crm_app;
    GRANT SELECT ON whatsapp_price_table TO crm_app;
  END IF;
END
$$;
