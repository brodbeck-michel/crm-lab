-- =============================================================================
-- 006_rls_onda7.sql
-- RLS das tres tabelas criadas em 005_insurances_and_catalog.sql.
--
-- Mesmo padrao de 002_row_level_security.sql e 004_rls_onda6.sql — mesma
-- forma, mesmo
--     NULLIF(current_setting('app.tenant_id', true), '')::uuid
-- Sem contexto de tenant a comparacao vira NULL: nenhuma linha visivel, nenhum
-- INSERT aceito. Fail-closed por construcao.
--
-- POR QUE ISTO NAO E OPCIONAL: o `ALTER DEFAULT PRIVILEGES` de 002 ja concedeu
-- SELECT/INSERT/UPDATE/DELETE a `crm_app` no momento do CREATE TABLE. Tabela
-- nova sem policy nao trava — ela VAZA entre laboratorios (fail-open).
--
-- Arquivo separado da 005 de proposito, seguindo o mesmo padrao da dupla
-- 003/004: nenhuma linha e escrita pela 005, entao a separacao aqui e por
-- consistencia com o padrao do repositorio, nao por necessidade de backfill.
-- =============================================================================

-- Os GRANTs abaixo sao redundantes com o ALTER DEFAULT PRIVILEGES de 002 quando
-- o dono das tabelas e o mesmo que rodou aquela migracao. Explicitos aqui pelo
-- mesmo motivo da 004: continuar corretos se um dia aplicados por outro papel.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON insurances, exam_prices, exam_synonyms TO crm_app;

-- -----------------------------------------------------------------------------
-- insurances (SCHEMA.md §18)
-- -----------------------------------------------------------------------------
ALTER TABLE insurances ENABLE ROW LEVEL SECURITY;
CREATE POLICY insurances_tenant_isolation ON insurances
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- exam_prices (SCHEMA.md §19)
-- -----------------------------------------------------------------------------
ALTER TABLE exam_prices ENABLE ROW LEVEL SECURITY;
CREATE POLICY exam_prices_tenant_isolation ON exam_prices
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- exam_synonyms (SCHEMA.md §20)
-- -----------------------------------------------------------------------------
ALTER TABLE exam_synonyms ENABLE ROW LEVEL SECURITY;
CREATE POLICY exam_synonyms_tenant_isolation ON exam_synonyms
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
