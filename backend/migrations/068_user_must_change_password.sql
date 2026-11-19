-- =============================================================================
-- 068_user_must_change_password.sql
-- CRMLAB-186 (D-326): senha provisoria precisa ser trocada no primeiro login.
-- Ligada pelo reset de senha (admin do laboratorio ou console da plataforma);
-- desligada quando a propria pessoa escolhe a senha (troca em Minha Conta ou
-- link por e-mail). Default FALSE, sem backfill: ninguem existente e obrigado.
-- Idempotente.
-- =============================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
