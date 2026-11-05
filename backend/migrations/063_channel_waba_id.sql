-- =============================================================================
-- 063_channel_waba_id.sql
-- CRMLAB-138 (D-308): modo do canal WhatsApp escolhido pelo gestor e credenciais
-- da Cloud API por laboratorio. SCHEMA.md §47 (a 063 e so do 138; template = 064
-- no CRMLAB-136, custo = 065 no CRMLAB-141).
--
-- `waba_id` = id da conta WhatsApp Business (Meta). Nao e segredo (em claro, como
-- `phone_number_id`). NULAVEL: linha antiga fica sem WABA.
--
-- `cloud_api_token` = token da Meta, cifrado em repouso (D-076) e write-only. Sai
-- de `api_token` porque, em `qr`, `api_token` guarda a apikey da instancia
-- Evolution: com uma coluna so, parear o QR apagava o token da Meta e a troca
-- `qr -> cloud_api` ficava impossivel (D-308 item 3, emendado em 05/11/2026).
-- Mesmos tres estados de `api_token`: NULL nunca configurou, '' revogou, texto.
--
-- Linhas ja em `cloud_api`: o token da Meta MUDA de coluna (copia o ciphertext,
-- a chave da cifra e a mesma) e `api_token` fica NULL, para a linha nunca parecer
-- pareada no QR com o token da Meta. Linhas em `qr` nao sao tocadas.
-- =============================================================================

ALTER TABLE tenant_channels
  ADD COLUMN IF NOT EXISTS waba_id VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS cloud_api_token TEXT NULL;

UPDATE tenant_channels
   SET cloud_api_token = api_token,
       api_token = NULL
 WHERE channel = 'whatsapp'
   AND connection_mode = 'cloud_api'
   AND api_token IS NOT NULL
   AND cloud_api_token IS NULL;
