-- =============================================================================
-- 053_conversation_participants.sql
-- CRMLAB-93 (D-263): participantes da conversa — chamar a gestora (ou outra
-- colega) para dentro do atendimento SEM transferir. SCHEMA.md §39.
--
-- Arquivo UNICO (tabela + policy), como 007/052: a tabela nasce vazia, nao ha
-- backfill. Sem a policy ela VAZARIA entre laboratorios — o GRANT do
-- `ALTER DEFAULT PRIVILEGES` da 002 ja da acesso a `crm_app` no CREATE TABLE.
--
-- `messages.attributed_to` (D-263 item 6): a dona da conversa no instante em
-- que uma PARTICIPANTE respondeu. O relatorio de tempo de resposta (D-257)
-- conta a resposta para ela. Gravado na mensagem para uma transferencia
-- posterior nao reescrever o passado. `NULL` em toda mensagem que nao e de
-- participante — a leitura usa `COALESCE(attributed_to, sender_id)`.
-- =============================================================================

CREATE TABLE conversation_participants (
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Chave natural: adicionar quem ja participa e no-op (ON CONFLICT).
  PRIMARY KEY (conversation_id, user_id)
);

-- A visibilidade da lista pergunta "conversas em que ESTE usuario participa".
CREATE INDEX idx_conversation_participants_user ON conversation_participants (tenant_id, user_id);
-- Indice de FK (D-146): o ON DELETE SET NULL.
CREATE INDEX idx_conversation_participants_added_by ON conversation_participants (added_by);

GRANT SELECT, INSERT, UPDATE, DELETE ON conversation_participants TO crm_app;

ALTER TABLE conversation_participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversation_participants_tenant_isolation ON conversation_participants
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE messages
  ADD COLUMN attributed_to UUID REFERENCES users(id) ON DELETE SET NULL;
-- Indice de FK (D-146), parcial: so as respostas de participante preenchem.
CREATE INDEX idx_messages_attributed_to ON messages (attributed_to) WHERE attributed_to IS NOT NULL;
