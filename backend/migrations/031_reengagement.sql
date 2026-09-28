-- =============================================================================
-- 031_reengagement.sql
-- CRMLAB-62 (D-211..D-214): reingajamento da conversa e feriados do
-- laboratorio. SCHEMA.md §4 (messages.automation), §33 e §34.
--
-- Arquivo UNICO (colunas + tabelas + policies), como 026: nao ha backfill,
-- as tabelas nascem vazias. Sem as policies elas VAZARIAM entre laboratorios
-- — o GRANT do `ALTER DEFAULT PRIVILEGES` da 002 ja da acesso a `crm_app` no
-- CREATE TABLE.
-- =============================================================================

-- Mensagem que o sistema mandou sozinho ao paciente (D-211 item 5). `agent`
-- com `sender_id NULL` e `automation` nulo continua sendo "Enviada pelo
-- celular" (D-173); com `automation` preenchido, "Mensagem automatica".
ALTER TABLE messages
  ADD COLUMN automation VARCHAR(20) NULL,
  ADD CONSTRAINT messages_automation_check CHECK (automation IS NULL OR automation IN ('reengagement'));

-- Uma linha por disparo decidido (D-211 item 3): o que aconteceu com o 1º e o
-- 2º reingajamento de cada silencio. O silencio e identificado pela ultima
-- mensagem de pessoa do laboratorio (`anchor_message_id`); a UNIQUE e o que
-- impede mandar duas vezes o mesmo disparo, inclusive com tique concorrente.
CREATE TABLE conversation_reengagements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  anchor_message_id UUID NOT NULL,
  step VARCHAR(10) NOT NULL,
  outcome VARCHAR(20) NOT NULL,
  reason VARCHAR(20) NULL,
  message_id UUID NULL,
  decided_at TIMESTAMP NOT NULL DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (anchor_message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL,
  CONSTRAINT conversation_reengagements_step_check CHECK (step IN ('first', 'second')),
  CONSTRAINT conversation_reengagements_outcome_check CHECK (outcome IN ('sent', 'discarded', 'failed')),
  CONSTRAINT conversation_reengagements_reason_check CHECK (
    (outcome = 'discarded' AND reason IN ('holiday', 'stale')) OR (outcome <> 'discarded' AND reason IS NULL)
  ),
  CONSTRAINT conversation_reengagements_once UNIQUE (anchor_message_id, step)
);

CREATE INDEX idx_conversation_reengagements_tenant_id ON conversation_reengagements(tenant_id);
CREATE INDEX idx_conversation_reengagements_conversation_id ON conversation_reengagements(conversation_id);
CREATE INDEX idx_conversation_reengagements_message_id ON conversation_reengagements(message_id);

ALTER TABLE conversation_reengagements ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversation_reengagements_tenant_isolation ON conversation_reengagements
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Feriados do laboratorio (municipais, estaduais, dias sem expediente). Os
-- nacionais sao calculados em `shared/` e NAO sao gravados (D-213).
CREATE TABLE tenant_holidays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  holiday_date DATE NOT NULL,
  description VARCHAR(100) NOT NULL,
  created_by UUID NULL,
  created_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT tenant_holidays_once UNIQUE (tenant_id, holiday_date)
);

CREATE INDEX idx_tenant_holidays_created_by ON tenant_holidays(created_by);

ALTER TABLE tenant_holidays ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_holidays_tenant_isolation ON tenant_holidays
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
