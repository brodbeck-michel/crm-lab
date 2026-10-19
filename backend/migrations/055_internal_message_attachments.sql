-- =============================================================================
-- 055_internal_message_attachments.sql
-- CRMLAB-101 (D-271): arquivo anexado a uma mensagem do chat interno.
-- SCHEMA.md §41.
--
-- Arquivo UNICO (tabela + policy), sem backfill: a tabela nasce vazia.
--
-- `message_id` e NOT NULL (diferente de `message_media`): a mensagem e esta
-- linha nascem na MESMA transacao. `UNIQUE (message_id)` = um anexo por
-- mensagem, como no atendimento. O `id` (gen_random_uuid()) e tambem o nome do
-- arquivo em disco (`lib/media-storage.ts`) — nunca o `file_name` enviado.
--
-- POR QUE A POLICY NAO E OPCIONAL: o `ALTER DEFAULT PRIVILEGES` da 002 ja
-- concede escrita a `crm_app` no CREATE TABLE. Tabela sem policy VAZA.
-- =============================================================================

CREATE TABLE internal_message_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  message_id UUID NOT NULL,
  mime_type VARCHAR(127) NOT NULL,           -- ja passado pela allow-list + sniff
  file_name VARCHAR(255) NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES internal_messages(id) ON DELETE CASCADE,
  CONSTRAINT internal_message_attachments_one_per_message UNIQUE (message_id),
  CHECK (byte_size > 0)
);

CREATE INDEX idx_internal_message_attachments_tenant_id ON internal_message_attachments(tenant_id);

ALTER TABLE internal_message_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY internal_message_attachments_tenant_isolation ON internal_message_attachments
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
