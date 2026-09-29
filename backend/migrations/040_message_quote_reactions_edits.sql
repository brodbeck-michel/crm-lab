-- =============================================================================
-- 040_message_quote_reactions_edits.sql
-- Citação, reação e mensagem apagada/editada pelo remetente (CRMLAB-66,
-- D-220/D-221/D-222 — SCHEMA.md §4, §33, §34).
--
-- Arquivo ÚNICO (colunas + tabelas + policies), mesmo padrão de 026/027: sem
-- backfill, as tabelas nascem vazias e as colunas novas nascem NULL.
--
-- APAGADA NÃO É APAGADA (D-220): `deleted_at` esconde a mensagem na API, mas a
-- linha, o `content` e o arquivo de `message_media` ficam. Nenhum código faz
-- `DELETE` porque o paciente apagou no celular — é prova para auditoria.
--
-- POR QUE A POLICY NÃO É OPCIONAL: o `ALTER DEFAULT PRIVILEGES` de 002 já
-- concedeu SELECT/INSERT/UPDATE/DELETE a `crm_app` no CREATE TABLE. Tabela
-- nova sem policy não trava — ela VAZA entre laboratórios (fail-open).
-- =============================================================================

ALTER TABLE messages
  ADD COLUMN quoted_external_id VARCHAR(255),
  ADD COLUMN quoted_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  ADD COLUMN edited_at TIMESTAMPTZ,
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by VARCHAR(20)
    CHECK (deleted_by IS NULL OR deleted_by IN ('patient', 'agent'));

CREATE INDEX idx_messages_quoted_message_id ON messages (quoted_message_id);

-- Uma reação por LADO (D-222): para o paciente o laboratório é um número só.
CREATE TABLE message_reactions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id   UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  reactor_type VARCHAR(20) NOT NULL CHECK (reactor_type IN ('patient', 'agent')),
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  emoji        VARCHAR(32) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, message_id, reactor_type)
);

CREATE INDEX idx_message_reactions_message_id ON message_reactions (message_id);
CREATE INDEX idx_message_reactions_user_id ON message_reactions (user_id);

-- Versões anteriores de mensagem editada (D-220): uma linha por edição.
CREATE TABLE message_edits (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id       UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  previous_content TEXT NOT NULL,
  edited_by        VARCHAR(20) NOT NULL CHECK (edited_by IN ('patient', 'agent')),
  edited_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_message_edits_message_id ON message_edits (message_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON message_reactions TO crm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON message_edits TO crm_app;

-- Mesma forma de 002/004/006/009/026: sem contexto de tenant a comparação vira
-- NULL — nenhuma linha visível, nenhum INSERT aceito. Fail-closed por construção.
ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY message_reactions_tenant_isolation ON message_reactions
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE message_edits ENABLE ROW LEVEL SECURITY;
CREATE POLICY message_edits_tenant_isolation ON message_edits
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
