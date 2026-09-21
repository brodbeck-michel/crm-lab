-- =============================================================================
-- 020_crm_login_role.sql
-- CRMLAB-38 item 1 (D-145): role de conexao do pool sem superuser.
--
-- Ate aqui a pool conecta como o `POSTGRES_USER` do container, que e
-- superuser (imagem oficial do Postgres cria o usuario do `POSTGRES_USER`
-- assim). Dentro de cada transacao com tenant a app troca para `crm_app` via
-- `SET LOCAL ROLE` (D-002, tenant-context.ts), mas tudo que roda em
-- `withoutTenant()` — login, `/platform/*`, lookup de tenant do webhook,
-- seeds — NUNCA troca de role: fica com o poder do superuser correndo solto
-- (DDL, BYPASSRLS, DROP TABLE). Nenhuma SQLi foi encontrada (todo valor por
-- bind, ORDER BY por allow-list) — isto e defesa em profundidade, nao
-- correcao de vulnerabilidade explorada.
--
-- `crm_login` e a role que a POOL deveria usar. Membro de `crm_app`: herda os
-- mesmos GRANTs de SELECT/INSERT/UPDATE/DELETE (D-002) por INHERIT (default),
-- sem ser dona de nada e sem CREATEDB/CREATEROLE/SUPERUSER/REPLICATION.
--
-- BYPASSRLS SIM, de proposito (D-165, correcao da revisao deste card). A
-- primeira versao desta migracao criava a role NOBYPASSRLS, o que TORNAVA A
-- TROCA DA `DATABASE_URL` IMPOSSIVEL: medido em homologacao em 21/09/2026, a
-- role NOBYPASSRLS enxerga 0 de 5 usuarios e 0 de 3 tenants nos caminhos
-- `withoutTenant()`, porque as policies de 002 comparam contra `app.tenant_id`
-- e ali ele nunca e setado. Login, `/platform/*`, `resolveWebhookTenant` e
-- seeds parariam de funcionar por completo.
--
-- Com BYPASSRLS, medido no mesmo banco: caminho SEM tenant volta a ver os 5
-- usuarios e 3 tenants, e o caminho COM tenant continua sob RLS normalmente
-- (3 de 5 usuarios, 1 de 3 tenants), porque `withTenant()` faz
-- `SET LOCAL ROLE crm_app` (D-002) e `crm_app` NAO tem BYPASSRLS. Ou seja: a
-- exposicao dos caminhos sem tenant fica exatamente igual a de hoje, e o que
-- este card remove de verdade e o SUPERUSER — DDL, DROP TABLE, COPY de arquivo
-- do host, leitura de qualquer tabela do cluster.
--
-- SEM SENHA aqui de proposito: senha em migracao versionada e senha vazada no
-- git. Trocar `DATABASE_URL` para usar `crm_login` e setar a senha dela
-- (`ALTER ROLE crm_login WITH PASSWORD '...'`) e PENDENCIA MANUAL na VPS — ver
-- docs/guides/DEPLOYMENT.md e docs/STATUS.md (entrada CRMLAB-38). O job
-- `migrate` do compose continua conectando como a role dona (ja e um servico
-- separado do `backend`, nao mexido aqui).
-- =============================================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_login') THEN
    CREATE ROLE crm_login LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END $$;

GRANT crm_app TO crm_login;

-- Banco que JA aplicou a primeira versao deste arquivo (hml e producao, em
-- 21/09/2026) nao re-executa nada daqui: o 020 ja esta em `schema_migrations`.
-- Para esses, a correcao vem em `023_crm_login_bypassrls.sql`.
