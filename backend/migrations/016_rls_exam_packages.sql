-- =============================================================================
-- 016_rls_exam_packages.sql
-- RLS das três tabelas criadas em 015_exam_packages.sql.
--
-- Mesmo padrão de 002/004/006/013 — mesma forma:
--     NULLIF(current_setting('app.tenant_id', true), '')::uuid
-- Sem contexto de tenant a comparação vira NULL: nenhuma linha visível, nenhum
-- INSERT aceito. Fail-closed por construção.
--
-- POR QUE ISTO NÃO É OPCIONAL: o `ALTER DEFAULT PRIVILEGES` de 002 já concedeu
-- SELECT/INSERT/UPDATE/DELETE a `crm_app` no momento do CREATE TABLE. Tabela
-- nova sem policy não trava — ela VAZA entre laboratórios (fail-open).
-- =============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE
  ON exam_packages, exam_package_items, exam_package_prices TO crm_app;

-- -----------------------------------------------------------------------------
-- exam_packages (SCHEMA.md §28)
-- -----------------------------------------------------------------------------
ALTER TABLE exam_packages ENABLE ROW LEVEL SECURITY;
CREATE POLICY exam_packages_tenant_isolation ON exam_packages
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- exam_package_items (SCHEMA.md §29)
-- -----------------------------------------------------------------------------
ALTER TABLE exam_package_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY exam_package_items_tenant_isolation ON exam_package_items
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- exam_package_prices (SCHEMA.md §30)
-- -----------------------------------------------------------------------------
ALTER TABLE exam_package_prices ENABLE ROW LEVEL SECURITY;
CREATE POLICY exam_package_prices_tenant_isolation ON exam_package_prices
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
