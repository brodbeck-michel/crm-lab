-- =============================================================================
-- 004_rls_onda6.sql
-- RLS das quatro tabelas criadas em 003_patients_and_channels.sql.
--
-- Mesmo padrao de 002_row_level_security.sql — mesma forma, mesmo
--     NULLIF(current_setting('app.tenant_id', true), '')::uuid
-- Sem contexto de tenant a comparacao vira NULL: nenhuma linha visivel, nenhum
-- INSERT aceito. Fail-closed por construcao.
--
-- POR QUE ISTO NAO E OPCIONAL: o `ALTER DEFAULT PRIVILEGES` de 002 ja concedeu
-- SELECT/INSERT/UPDATE/DELETE a `crm_app` no momento do CREATE TABLE. Tabela
-- nova sem policy nao trava — ela VAZA entre laboratorios (fail-open).
--
-- Arquivo separado da 003 de proposito: o backfill da 003 escreve linhas de
-- todos os tenants de uma vez e rodaria contra estas policies.
-- =============================================================================

-- Os GRANTs abaixo sao redundantes com o ALTER DEFAULT PRIVILEGES de 002 quando
-- o dono das tabelas e o mesmo que rodou aquela migracao. Explicitos aqui para
-- que a 003 continue correta se um dia for aplicada por outro papel.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON patients, tenant_channels, tenant_settings, channel_reads TO crm_app;

-- -----------------------------------------------------------------------------
-- patients (SCHEMA.md §14)
-- -----------------------------------------------------------------------------
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
CREATE POLICY patients_tenant_isolation ON patients
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- tenant_channels (SCHEMA.md §15) — a policy protege a LINHA; o segredo
-- (api_token, webhook_secret) e protegido pela projecao explicita de colunas no
-- repositorio. As duas defesas sao independentes e ambas obrigatorias.
-- -----------------------------------------------------------------------------
ALTER TABLE tenant_channels ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_channels_tenant_isolation ON tenant_channels
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- tenant_settings (SCHEMA.md §16) — `tenant_id` e a PK E a chave da policy.
-- -----------------------------------------------------------------------------
ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_settings_tenant_isolation ON tenant_settings
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- channel_reads (SCHEMA.md §17)
--
-- Isolamento por tenant como as demais — E MAIS: a gravacao exige que o canal e
-- o usuario sejam do MESMO tenant do contexto. Isso nao e zelo decorativo: as
-- FKs de `channel_id` e `user_id` sao verificadas pelo sistema FORA do RLS
-- (integridade referencial nao enxerga policy), entao sem a checagem abaixo um
-- INSERT feito no contexto do tenant A poderia gravar `last_read_at` do usuario
-- do tenant B — o pior tipo de linha: valida para o banco, atravessando a
-- fronteira que o produto inteiro promete.
--
-- Os EXISTS lem `users` e `internal_channels`, que ja estao sob as policies de
-- 002: dentro do contexto de A, so enxergam linhas de A. A checagem e, na
-- pratica, "existe no meu tenant?".
--
-- SELECT continua sendo por tenant (nao por usuario): `unreadCount` e derivado
-- por `WHERE user_id = :userId` no service, e a tela de operacao pode
-- legitimamente ler o estado de leitura da equipe. O que a policy garante e que
-- esse "da equipe" nunca cruza laboratorio.
-- -----------------------------------------------------------------------------
ALTER TABLE channel_reads ENABLE ROW LEVEL SECURITY;
CREATE POLICY channel_reads_tenant_isolation ON channel_reads
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM internal_channels ic
       WHERE ic.id = channel_reads.channel_id
         AND ic.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    AND EXISTS (
      SELECT 1 FROM users u
       WHERE u.id = channel_reads.user_id
         AND u.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
  );
