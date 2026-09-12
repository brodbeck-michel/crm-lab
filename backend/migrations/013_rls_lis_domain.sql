-- =============================================================================
-- 013_rls_lis_domain.sql
-- RLS das quatro tabelas criadas em 012_lis_domain.sql (attendants,
-- lis_imports, lis_budgets, sales).
--
-- Mesmo padrao de 002_row_level_security.sql, 004_rls_onda6.sql e
-- 006_rls_onda7.sql — mesma forma, mesmo
--     NULLIF(current_setting('app.tenant_id', true), '')::uuid
-- Sem contexto de tenant a comparacao vira NULL: nenhuma linha visivel, nenhum
-- INSERT aceito. Fail-closed por construcao.
--
-- POR QUE ISTO NAO E OPCIONAL: o `ALTER DEFAULT PRIVILEGES` de 002 ja concedeu
-- SELECT/INSERT/UPDATE/DELETE a `crm_app` no momento do CREATE TABLE. Tabela
-- nova sem policy nao trava — ela VAZA entre laboratorios (fail-open).
--
-- Arquivo separado da 012 de proposito, seguindo o mesmo padrao da dupla
-- 003/004 e 005/006: nenhuma linha e escrita pela 012, entao a separacao aqui
-- e por consistencia com o padrao do repositorio, nao por necessidade de
-- backfill.
-- =============================================================================

-- Os GRANTs abaixo sao redundantes com o ALTER DEFAULT PRIVILEGES de 002 quando
-- o dono das tabelas e o mesmo que rodou aquela migracao. Explicitos aqui pelo
-- mesmo motivo da 004/006: continuar corretos se um dia aplicados por outro
-- papel.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON attendants, lis_imports, lis_budgets, sales TO crm_app;

-- -----------------------------------------------------------------------------
-- attendants (SCHEMA.md §24)
-- -----------------------------------------------------------------------------
ALTER TABLE attendants ENABLE ROW LEVEL SECURITY;
CREATE POLICY attendants_tenant_isolation ON attendants
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- lis_imports (SCHEMA.md §25)
-- -----------------------------------------------------------------------------
ALTER TABLE lis_imports ENABLE ROW LEVEL SECURITY;
CREATE POLICY lis_imports_tenant_isolation ON lis_imports
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- lis_budgets (SCHEMA.md §26)
-- -----------------------------------------------------------------------------
ALTER TABLE lis_budgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY lis_budgets_tenant_isolation ON lis_budgets
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- sales (SCHEMA.md §27)
-- -----------------------------------------------------------------------------
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
CREATE POLICY sales_tenant_isolation ON sales
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
