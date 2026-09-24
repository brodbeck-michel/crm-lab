-- =============================================================================
-- 024_password_reset_tokens.sql
-- CRMLAB-39 (D-172): recuperacao de senha por e-mail (Resend).
--
-- Mesmo padrao de `refresh_tokens` (002/022): token de alta entropia gerado
-- pelo servidor, guardado SO como hash SHA-256 (nunca em claro), lookup por
-- hash indexado. TIMESTAMPTZ desde a criacao — ao contrario do
-- `refresh_tokens.expires_at` original (TIMESTAMP naive, D-154 corrigiu depois
-- às pressas), aqui ja nasce com fuso, sem round-trip nenhum: `expires_at` e
-- gravado uma vez no INSERT e nunca mais lido para ser regravado.
--
-- `used_at` (em vez de excluir a linha) preserva a evidencia de reset ja
-- consumido, o mesmo motivo de `revoked_at` em `refresh_tokens` nao apagar a
-- linha — auditoria e deteccao de reuso.
-- =============================================================================
CREATE TABLE password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  token_hash VARCHAR(255) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
CREATE INDEX idx_password_reset_tokens_expires_at ON password_reset_tokens(expires_at);

-- Isolamento multitenant (D-002) — mesmo padrao de `002_row_level_security.sql`.
ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY password_reset_tokens_tenant_isolation ON password_reset_tokens
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
