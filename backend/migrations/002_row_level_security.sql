-- =============================================================================
-- 002_row_level_security.sql
-- Isolamento multitenant real (D-002, BUSINESS_RULES.md §4 nivel 3).
--
-- O backend conecta como o papel `crm_app`, que NAO e dono das tabelas —
-- portanto o RLS se aplica a ele (donos e superusuarios burlam RLS).
-- Cada request seta `app.tenant_id` no inicio da transacao:
--     SET LOCAL app.tenant_id = '<uuid do tenant>';
--
-- Padrao usado nas policies:
--     NULLIF(current_setting('app.tenant_id', true), '')::uuid
-- O segundo argumento de current_setting evita erro quando a variavel nunca foi
-- setada (retorna NULL); NULLIF trata o caso de string vazia (SET LOCAL ... = ''
-- ou RESET). Sem contexto de tenant, a comparacao vira NULL => nenhuma linha
-- visivel e nenhum INSERT aceito. Fail-closed por construcao.
--
-- `tenants` tambem tem policy, pela coluna `id` (a chave do proprio tenant).
--
-- Funciona igual em Postgres 16 (docker) e PGlite (testes) — D-008.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Papel da aplicacao
-- -----------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
    CREATE ROLE crm_app NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO crm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO crm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO crm_app;

-- Tabelas criadas por migracoes futuras herdam os mesmos GRANTs.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO crm_app;

-- -----------------------------------------------------------------------------
-- tenants: tabela raiz. Nao tem coluna `tenant_id` — a chave do proprio tenant
-- e `id`. Sem policy aqui, qualquer caminho de codigo que esquecesse o filtro
-- (ou uma injecao de SQL em endpoint autenticado) enumeraria todos os
-- laboratorios clientes: nome, slug, plano, data de assinatura. Isso e
-- vazamento entre concorrentes — a camada 3 de SECURITY.md ficaria aberta
-- exatamente na tabela raiz. BUSINESS_RULES.md §4 nao abre excecao.
--
-- Com a policy abaixo, tudo que o sistema legitimamente faz dentro de uma
-- transacao COM contexto continua funcionando: carregar o proprio tenant no
-- payload de login, joins users -> tenants, a tela de Personalizacao.
--
-- Os dois caminhos que precisam enxergar mais de um tenant sao excecoes
-- explicitas e auditaveis, executadas pelo `withoutTenant()` do Kernel (roda
-- como dono da tabela, que burla RLS):
--   1. login — busca o usuario por email antes de saber o tenant
--   2. console da plataforma — opera sobre todos os tenants por definicao
-- Nenhum outro caminho deve usar `withoutTenant()`.
-- -----------------------------------------------------------------------------
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenants_self_isolation ON tenants
  FOR ALL
  USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Policies por tenant_id — uma por tabela de dados de laboratorio
-- FOR ALL cobre SELECT/UPDATE/DELETE via USING e INSERT/UPDATE via WITH CHECK.
-- -----------------------------------------------------------------------------

-- users
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_tenant_isolation ON users
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- conversations
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversations_tenant_isolation ON conversations
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- messages
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY messages_tenant_isolation ON messages
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- exam_catalog
ALTER TABLE exam_catalog ENABLE ROW LEVEL SECURITY;
CREATE POLICY exam_catalog_tenant_isolation ON exam_catalog
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- proposals
ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY proposals_tenant_isolation ON proposals
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- proposal_items (tenant_id proprio — ver 001)
ALTER TABLE proposal_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY proposal_items_tenant_isolation ON proposal_items
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- proposal_status_history
ALTER TABLE proposal_status_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY proposal_status_history_tenant_isolation ON proposal_status_history
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- themes
ALTER TABLE themes ENABLE ROW LEVEL SECURITY;
CREATE POLICY themes_tenant_isolation ON themes
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- audit_logs
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_tenant_isolation ON audit_logs
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- internal_channels
ALTER TABLE internal_channels ENABLE ROW LEVEL SECURITY;
CREATE POLICY internal_channels_tenant_isolation ON internal_channels
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- internal_messages
ALTER TABLE internal_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY internal_messages_tenant_isolation ON internal_messages
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- refresh_tokens
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY refresh_tokens_tenant_isolation ON refresh_tokens
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
