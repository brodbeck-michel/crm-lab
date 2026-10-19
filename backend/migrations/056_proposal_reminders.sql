-- =============================================================================
-- 056_proposal_reminders.sql
-- CRMLAB-102 (D-272): lembrete de contato da proposta parada, com desfecho
-- obrigatorio. SCHEMA.md §41.
--
-- Arquivo UNICO (tabela + policy), como 053/054: a tabela nasce vazia, nao ha
-- backfill. Sem a policy ela VAZARIA entre laboratorios — o GRANT do
-- `ALTER DEFAULT PRIVILEGES` da 002 ja da acesso a `crm_app` no CREATE TABLE.
--
-- Uma linha por ciclo do lembrete: nasce aberta (`resolved_at` NULL) e so
-- fecha com um desfecho (`outcome`). Os dois indices unicos parciais sao as
-- travas: um aberto por proposta, e um automatico por proposta na vida toda.
-- =============================================================================

CREATE TABLE proposal_reminders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  proposal_id  UUID NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  origin       VARCHAR(10) NOT NULL,
  -- Dia do contato em Brasilia (D-272 item 4).
  due_date     DATE NOT NULL,
  note         VARCHAR(500) NULL,
  -- NULL no automatico.
  created_by   UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  -- O aviso WS ja saiu para este lembrete (uma vez por lembrete).
  alerted_at   TIMESTAMP NULL,
  resolved_at  TIMESTAMP NULL,
  -- NULL no `auto_closed`.
  resolved_by  UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  outcome      VARCHAR(20) NULL,
  outcome_note VARCHAR(500) NULL,
  CONSTRAINT proposal_reminders_origin_check CHECK (origin IN ('auto', 'manual')),
  CONSTRAINT proposal_reminders_outcome_check
    CHECK (outcome IS NULL OR outcome IN ('won', 'lost', 'rescheduled', 'auto_closed')),
  CONSTRAINT proposal_reminders_resolved_check CHECK ((resolved_at IS NULL) = (outcome IS NULL))
);

CREATE UNIQUE INDEX proposal_reminders_one_open
  ON proposal_reminders (proposal_id) WHERE resolved_at IS NULL;
CREATE UNIQUE INDEX proposal_reminders_auto_once
  ON proposal_reminders (proposal_id) WHERE origin = 'auto';
-- O tique procura os abertos vencidos do laboratorio.
CREATE INDEX idx_proposal_reminders_open_due
  ON proposal_reminders (tenant_id, due_date) WHERE resolved_at IS NULL;
-- Indices de FK (D-146): os ON DELETE SET NULL.
CREATE INDEX idx_proposal_reminders_created_by ON proposal_reminders (created_by);
CREATE INDEX idx_proposal_reminders_resolved_by ON proposal_reminders (resolved_by);

GRANT SELECT, INSERT, UPDATE, DELETE ON proposal_reminders TO crm_app;

ALTER TABLE proposal_reminders ENABLE ROW LEVEL SECURITY;
CREATE POLICY proposal_reminders_tenant_isolation ON proposal_reminders
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
