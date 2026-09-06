-- =============================================================================
-- 007_conversation_pins.sql
-- Conversa fixada no topo da lista, POR ATENDENTE (Onda 8 §2.3, SCHEMA.md §21).
--
-- Arquivo unico (tabela + policy), diferente dos pares 003/004 e 005/006: a
-- separacao daqueles existe para o backfill rodar antes de a policy ligar, e
-- aqui nao ha backfill — a tabela nasce vazia.
--
-- POR QUE A POLICY NAO E OPCIONAL: o `ALTER DEFAULT PRIVILEGES` de 002 ja
-- concedeu SELECT/INSERT/UPDATE/DELETE a `crm_app` no momento do CREATE TABLE.
-- Tabela nova sem policy nao trava — ela VAZA entre laboratorios (fail-open).
-- =============================================================================

CREATE TABLE conversation_pins (
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Chave natural: e ela que torna `POST /pin` idempotente (ON CONFLICT).
  PRIMARY KEY (user_id, conversation_id)
);

-- A consulta da listagem e sempre "os pins DESTE usuario neste tenant".
CREATE INDEX conversation_pins_lookup ON conversation_pins (tenant_id, user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON conversation_pins TO crm_app;

-- Mesma forma de 002/004/006: sem contexto de tenant a comparacao vira NULL —
-- nenhuma linha visivel, nenhum INSERT aceito. Fail-closed por construcao.
ALTER TABLE conversation_pins ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversation_pins_tenant_isolation ON conversation_pins
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
