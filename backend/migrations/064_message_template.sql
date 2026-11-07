-- =============================================================================
-- 064_message_template.sql
-- CRMLAB-136 (D-309): mensagem enviada por modelo aprovado da Meta guarda o
-- modelo. SCHEMA.md §47 (uma migracao por card: 063 = 138, 064 = 136,
-- 065 = 141, 066 = 137).
--
-- So `ADD COLUMN` nulo (quatro colunas): mensagem de texto livre, de paciente, de sistema e
-- todo o modo `qr` ficam NULL. `content` continua guardando o corpo ja
-- preenchido (atendente e paciente leem o mesmo texto). `template_category`
-- e a do MODELO; a categoria de COBRANCA (`pricing_category`) e da 065.
-- =============================================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS template_name VARCHAR(512) NULL,
  ADD COLUMN IF NOT EXISTS template_language VARCHAR(20) NULL,
  ADD COLUMN IF NOT EXISTS template_category VARCHAR(20) NULL
    CONSTRAINT messages_template_category_check
    CHECK (template_category IS NULL OR template_category IN ('marketing', 'utility')),
  -- Variaveis em ordem (JSON array de strings): o "tentar de novo" reenvia o
  -- MESMO modelo. Nao saem na API (o texto preenchido ja esta em `content`).
  ADD COLUMN IF NOT EXISTS template_variables JSONB NULL;
