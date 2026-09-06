-- =============================================================================
-- 009_message_media.sql
-- Mídia de mensagem em disco — anexo e áudio (Onda 8 §4, SCHEMA.md §22).
--
-- Arquivo unico (tabela + policy), mesmo padrao de 007/008: a tabela nasce
-- vazia, sem backfill.
--
-- `message_id` e NULLABLE de proposito: o arquivo e gravado e a linha
-- inserida ANTES de a mensagem existir (o id do arquivo em disco e o id desta
-- linha, gerado por `gen_random_uuid()`), e so DEPOIS o service liga o
-- `message_id` — impossivel inserir a mensagem primeiro com uma
-- `attachmentUrl` que aponta para um id que ainda nao existe.
--
-- POR QUE A POLICY NAO E OPCIONAL: o `ALTER DEFAULT PRIVILEGES` de 002 ja
-- concedeu SELECT/INSERT/UPDATE/DELETE a `crm_app` no momento do CREATE TABLE.
-- Tabela nova sem policy nao trava — ela VAZA entre laboratorios (fail-open).
-- =============================================================================

CREATE TABLE message_media (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id  UUID REFERENCES messages(id) ON DELETE CASCADE,
  mime_type   TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  byte_size   INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- `GET /media/:id` consulta so por id, ja filtrado por tenant via RLS. O
-- indice por tenant existe para a varredura de retencao/limpeza futura
-- (registrada como risco em falta no spec §6), nao para este endpoint.
CREATE INDEX message_media_tenant_lookup ON message_media (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON message_media TO crm_app;

-- Mesma forma de 002/004/006/007/008: sem contexto de tenant a comparacao vira
-- NULL — nenhuma linha visivel, nenhum INSERT aceito. Fail-closed por construcao.
ALTER TABLE message_media ENABLE ROW LEVEL SECURITY;
CREATE POLICY message_media_tenant_isolation ON message_media
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
