-- =============================================================================
-- 058_internal_message_edits.sql
-- CRMLAB-117 (D-282): a autora edita ou apaga para todos a propria mensagem
-- do chat interno. SCHEMA.md §42.
--
-- Arquivo UNICO (colunas + tabela + policy), mesmo padrao da 040: sem
-- backfill, as colunas nascem NULL e a tabela nasce vazia.
--
-- APAGADA NAO E APAGADA (D-282, como D-220): `deleted_at` esconde a mensagem
-- na API, mas a linha, o `content` e o arquivo do anexo ficam. Nenhum codigo
-- faz `DELETE` em `internal_messages` por causa desta acao.
--
-- POR QUE A POLICY NAO E OPCIONAL: o `ALTER DEFAULT PRIVILEGES` da 002 ja
-- concede escrita a `crm_app` no CREATE TABLE. Tabela sem policy VAZA.
-- =============================================================================

ALTER TABLE internal_messages
  ADD COLUMN edited_at TIMESTAMPTZ,
  ADD COLUMN deleted_at TIMESTAMPTZ;

-- Versoes anteriores de mensagem interna editada: uma linha por edicao.
-- `edited_by` e o usuario (so a autora edita, D-282) — SET NULL se sair.
CREATE TABLE internal_message_edits (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id       UUID NOT NULL REFERENCES internal_messages(id) ON DELETE CASCADE,
  previous_content TEXT NOT NULL,
  edited_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  edited_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_internal_message_edits_tenant_id ON internal_message_edits (tenant_id);
CREATE INDEX idx_internal_message_edits_message_id ON internal_message_edits (message_id);
CREATE INDEX idx_internal_message_edits_edited_by ON internal_message_edits (edited_by);

GRANT SELECT, INSERT, UPDATE, DELETE ON internal_message_edits TO crm_app;

-- Mesma forma de 002/040/055: sem contexto de tenant a comparacao vira NULL —
-- nenhuma linha visivel, nenhum INSERT aceito. Fail-closed por construcao.
ALTER TABLE internal_message_edits ENABLE ROW LEVEL SECURITY;
CREATE POLICY internal_message_edits_tenant_isolation ON internal_message_edits
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
