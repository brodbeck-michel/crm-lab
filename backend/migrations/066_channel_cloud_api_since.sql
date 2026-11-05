-- =============================================================================
-- 066_channel_cloud_api_since.sql
-- CRMLAB-137 (D-310 item 1, emendado em 05/11/2026): a janela de 24 h so conta
-- fala do paciente que chegou pelo WhatsApp DEPOIS de o canal passar para
-- `cloud_api`. Fala recebida pelo QR (Evolution) ou sem webhook nao abre a
-- janela da Meta (ela recusaria com 131047). SCHEMA.md §47.
--
-- `cloud_api_since` = quando o canal entrou em `cloud_api` pela ultima vez.
-- Carimbado por TRIGGER (qualquer caminho que mude o modo: PUT do modo, upsert,
-- scripts), relogio do banco como `messages.created_at` (sessao em UTC, D-078).
-- Volta para `qr` mantem o valor (historico); nova ida para `cloud_api` recarimba.
-- So o canal `whatsapp` e carimbado (o DEFAULT de connection_mode e `cloud_api`
-- para todo canal). Restore SO de dados (`pg_restore --data-only`) com o trigger
-- ja criado recarimbaria tudo; a sync da hml restaura antes dos triggers.
--
-- `messages.received_via` = por qual webhook a fala do PACIENTE chegou:
-- `cloud_api` (Meta) ou `evolution` (QR). So `cloud_api` abre a janela — o
-- webhook do QR continua aceito com o canal em `cloud_api` (instancia ainda
-- pareada), mas a Meta nao conhece essas falas. Mensagens antigas ficam NULL.
-- Numero 066: 064 = CRMLAB-136 e 065 = CRMLAB-141 estao reservadas; o migrador
-- aplica por nome o que falta, entao a lacuna nao atrapalha.
-- =============================================================================

ALTER TABLE tenant_channels
  ADD COLUMN IF NOT EXISTS cloud_api_since TIMESTAMP NULL;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS received_via VARCHAR(20) NULL
    CONSTRAINT messages_received_via_check
    CHECK (received_via IS NULL OR received_via IN ('cloud_api', 'evolution'));

-- Linhas que ja estao em `cloud_api`: a janela comeca agora (conservador; fala
-- anterior nao e garantida como recebida pela Meta).
UPDATE tenant_channels
   SET cloud_api_since = (now() AT TIME ZONE 'UTC')
 WHERE channel = 'whatsapp'
   AND connection_mode = 'cloud_api'
   AND cloud_api_since IS NULL;

CREATE OR REPLACE FUNCTION tenant_channels_cloud_api_since() RETURNS trigger AS $$
BEGIN
  IF NEW.channel = 'whatsapp' AND NEW.connection_mode = 'cloud_api'
     AND (TG_OP = 'INSERT' OR OLD.connection_mode IS DISTINCT FROM 'cloud_api') THEN
    -- UTC explicito: um psql de operador em outro fuso nao desloca o carimbo.
    NEW.cloud_api_since := (now() AT TIME ZONE 'UTC');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tenant_channels_cloud_api_since ON tenant_channels;
CREATE TRIGGER trg_tenant_channels_cloud_api_since
  BEFORE INSERT OR UPDATE OF connection_mode ON tenant_channels
  FOR EACH ROW EXECUTE FUNCTION tenant_channels_cloud_api_since();
