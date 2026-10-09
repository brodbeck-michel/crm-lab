-- =============================================================================
-- 054_conversation_auto_replies.sql
-- CRMLAB-94 (D-264): mensagem fora do horario e boas-vindas enviadas pelo CRM.
-- SCHEMA.md §4 (messages.automation) e §40.
--
-- Arquivo UNICO (CHECK + tabela + policy), como 031: nao ha backfill, a tabela
-- nasce vazia. Sem a policy ela VAZARIA entre laboratorios — o GRANT do
-- `ALTER DEFAULT PRIVILEGES` da 002 ja da acesso a `crm_app` no CREATE TABLE.
-- =============================================================================

-- Mensagem automatica de fora do horario e de boas-vindas (D-264 item 6).
ALTER TABLE messages DROP CONSTRAINT messages_automation_check;
ALTER TABLE messages
  ADD CONSTRAINT messages_automation_check
  CHECK (automation IS NULL OR automation IN ('reengagement', 'offhours', 'greeting'));

-- Uma linha por resposta automatica decidida (D-264 item 4), gravada ANTES do
-- envio. Os indices unicos parciais sao a trava: um `offhours` por conversa
-- por periodo fechado (a reabertura do laboratorio) e um `greeting` por
-- conversa — inclusive com webhooks concorrentes.
CREATE TABLE conversation_auto_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  kind VARCHAR(20) NOT NULL,
  reopens_at TIMESTAMP NULL,
  trigger_message_id UUID NULL,
  outcome VARCHAR(20) NOT NULL,
  message_id UUID NULL,
  decided_at TIMESTAMP NOT NULL DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (trigger_message_id) REFERENCES messages(id) ON DELETE SET NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL,
  CONSTRAINT conversation_auto_replies_kind_check CHECK (kind IN ('offhours', 'greeting')),
  CONSTRAINT conversation_auto_replies_outcome_check CHECK (outcome IN ('sent', 'failed')),
  CONSTRAINT conversation_auto_replies_period_check CHECK ((kind = 'offhours') = (reopens_at IS NOT NULL))
);

CREATE UNIQUE INDEX conversation_auto_replies_offhours_once
  ON conversation_auto_replies (conversation_id, reopens_at) WHERE kind = 'offhours';
CREATE UNIQUE INDEX conversation_auto_replies_greeting_once
  ON conversation_auto_replies (conversation_id) WHERE kind = 'greeting';
CREATE INDEX idx_conversation_auto_replies_tenant_id ON conversation_auto_replies(tenant_id);
CREATE INDEX idx_conversation_auto_replies_trigger_message_id ON conversation_auto_replies(trigger_message_id);
CREATE INDEX idx_conversation_auto_replies_message_id ON conversation_auto_replies(message_id);

ALTER TABLE conversation_auto_replies ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversation_auto_replies_tenant_isolation ON conversation_auto_replies
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
