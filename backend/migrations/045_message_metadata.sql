-- =============================================================================
-- 045_message_metadata.sql
-- Metadados da mensagem (CRMLAB-70, D-234 — SCHEMA.md §4).
--
-- O que o WhatsApp manda junto e o arquivo nao tem: duracao (video/audio),
-- paginas (PDF), miniatura do video, localizacao e contatos compartilhados.
-- Nome, tamanho e MIME do arquivo NAO entram aqui: continuam em
-- `message_media` (a leitura acha pela id da `attachment_url`).
--
-- Anulavel e sem backfill: mensagem antiga fica `NULL` e aparece como antes.
-- Sem policy nova: `messages` ja esta sob RLS (002).
-- =============================================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSONB;
