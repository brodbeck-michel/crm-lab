-- =============================================================================
-- 072_representative_role.sql
-- CRMLAB-189 (D-329): perfil novo `representative` (Representante) — visitacao
-- medica pela propria carteira; fora da Visitacao, as mesmas permissoes da
-- atendente.
--
-- So amplia o CHECK de `users.role`. NAO mexe em dado: medicos sem responsavel
-- ou com atendente como responsavel continuam como estao e aparecem no filtro
-- "Sem responsavel / responsavel inelegivel" (`GET /doctors?unassigned=true`)
-- para o gestor atribuir.
--
-- O CHECK nasceu inline na 001, com o nome gerado `users_role_check`.
-- Idempotente.
-- =============================================================================

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('attendant', 'representative', 'manager', 'admin', 'platform_operator'));
