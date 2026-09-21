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
-- sem ser dona de nada e sem BYPASSRLS/CREATEDB/CREATEROLE/SUPERUSER/REPLICATION.
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
    CREATE ROLE crm_login LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END $$;

GRANT crm_app TO crm_login;
