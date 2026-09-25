-- =============================================================================
-- 026_lis_sync.sql
-- CRMLAB-52 (D-185/D-186): sincronizacao dos orcamentos do LIS pela API do
-- Bitlab. SCHEMA.md §25 (lis_imports.kind) e §31 (lis_sync_settings).
--
-- Arquivo UNICO (tabela + policy), como 007/008: nao ha backfill, a tabela
-- nasce vazia. Sem a policy ela VAZARIA entre laboratorios — o GRANT do
-- `ALTER DEFAULT PRIVILEGES` da 002 ja da acesso a `crm_app` no CREATE TABLE.
-- =============================================================================

-- Rodada da sincronizacao que recebeu pelo menos um orcamento. `file_name`
-- fica NULL, como no purge.
ALTER TABLE lis_imports DROP CONSTRAINT lis_imports_kind_check;
ALTER TABLE lis_imports
  ADD CONSTRAINT lis_imports_kind_check CHECK (kind IN ('import', 'purge', 'sync'));

CREATE TABLE lis_sync_settings (
  tenant_id UUID PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  api_key TEXT NULL,                     -- x-api-key do Bitlab, CIFRADA (secret-box, D-076)
  watermark VARCHAR(30) NULL,            -- maior `marcaDagua` ja gravada, crua (D-187)
  last_run_at TIMESTAMP NULL,
  last_success_at TIMESTAMP NULL,
  last_error TEXT NULL,
  updated_by UUID NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT lis_sync_settings_enabled_needs_key CHECK (NOT enabled OR api_key IS NOT NULL)
);

CREATE INDEX idx_lis_sync_settings_updated_by ON lis_sync_settings(updated_by);

CREATE TRIGGER trg_lis_sync_settings_updated_at
  BEFORE UPDATE ON lis_sync_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE lis_sync_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY lis_sync_settings_tenant_isolation ON lis_sync_settings
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
