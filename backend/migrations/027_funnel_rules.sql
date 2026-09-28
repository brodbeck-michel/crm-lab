-- =============================================================================
-- 027_funnel_rules.sql
-- CRMLAB-56 (D-190): regras do funil definidas pelo laboratorio na pagina
-- Configuracoes -> Regras. SCHEMA.md §32.
--
-- Arquivo UNICO (tabela + policy), como 026: nao ha backfill, a tabela nasce
-- vazia e "sem linha" significa "padroes" (DEFAULT_FUNNEL_RULES). Sem a policy
-- ela VAZARIA entre laboratorios — o GRANT do `ALTER DEFAULT PRIVILEGES` da 002
-- ja da acesso a `crm_app` no CREATE TABLE.
-- =============================================================================

CREATE TABLE funnel_rules (
  tenant_id UUID PRIMARY KEY,
  rules JSONB NOT NULL,                  -- FunnelRules inteiro, ja mesclado com os padroes
  updated_by UUID NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_funnel_rules_updated_by ON funnel_rules(updated_by);

CREATE TRIGGER trg_funnel_rules_updated_at
  BEFORE UPDATE ON funnel_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE funnel_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY funnel_rules_tenant_isolation ON funnel_rules
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
