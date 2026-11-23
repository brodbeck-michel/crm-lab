-- =============================================================================
-- 074_doctor_timeline_comments.sql
-- CRMLAB-192 (D-332): comentarios nos itens da linha do tempo do medico — uma
-- visita (`doctor_visits`) OU um registro manual (`doctor_interactions`).
-- SCHEMA.md §38a.
--
-- Referencia polimorfica SEGURA: duas colunas com FK de verdade (ON DELETE
-- CASCADE) e CHECK de exatamente uma preenchida — nada de `item_type` +
-- `item_id` sem FK.
--
-- Arquivo UNICO (tabela + policy), como 052/069: a tabela nasce vazia, nao ha
-- backfill. Sem a policy ela VAZARIA entre laboratorios — o GRANT do
-- `ALTER DEFAULT PRIVILEGES` da 002 ja da acesso a `crm_app` no CREATE TABLE.
-- Idempotente (IF NOT EXISTS / DROP ... IF EXISTS).
-- =============================================================================

CREATE TABLE IF NOT EXISTS doctor_timeline_comments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  visit_id       UUID REFERENCES doctor_visits(id) ON DELETE CASCADE,
  interaction_id UUID REFERENCES doctor_interactions(id) ON DELETE CASCADE,
  author_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  body           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at      TIMESTAMPTZ,                 -- NULL = nunca editado
  CONSTRAINT doctor_timeline_comments_one_target
    CHECK ((visit_id IS NULL) <> (interaction_id IS NULL)),
  CONSTRAINT doctor_timeline_comments_body_check
    CHECK (length(trim(body)) > 0 AND length(body) <= 2000)
);

-- O feed le os comentarios dos itens da pagina, do mais antigo para o mais novo.
CREATE INDEX IF NOT EXISTS idx_doctor_timeline_comments_visit
  ON doctor_timeline_comments(visit_id, created_at) WHERE visit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_doctor_timeline_comments_interaction
  ON doctor_timeline_comments(interaction_id, created_at) WHERE interaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_doctor_timeline_comments_tenant_id ON doctor_timeline_comments(tenant_id);
-- Indice de FK (D-146): o ON DELETE SET NULL.
CREATE INDEX IF NOT EXISTS idx_doctor_timeline_comments_author_id ON doctor_timeline_comments(author_id);

DROP TRIGGER IF EXISTS trg_doctor_timeline_comments_updated_at ON doctor_timeline_comments;
CREATE TRIGGER trg_doctor_timeline_comments_updated_at
  BEFORE UPDATE ON doctor_timeline_comments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON doctor_timeline_comments TO crm_app;

ALTER TABLE doctor_timeline_comments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS doctor_timeline_comments_tenant_isolation ON doctor_timeline_comments;
CREATE POLICY doctor_timeline_comments_tenant_isolation ON doctor_timeline_comments
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
