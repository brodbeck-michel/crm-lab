-- =============================================================================
-- 047_doctors.sql
-- CRMLAB-86 (D-255): cadastro de medicos solicitantes do laboratorio — base do
-- epico CRMLAB-85 (Visitacao Medica). SCHEMA.md §35.
--
-- Arquivo UNICO (tabela + policy), como 026/027: a tabela nasce vazia, nao ha
-- backfill. Sem a policy ela VAZARIA entre laboratorios — o GRANT do
-- `ALTER DEFAULT PRIVILEGES` da 002 ja da acesso a `crm_app` no CREATE TABLE.
--
-- NAO mexe em `proposals.requesting_doctor` (017): o medico da proposta
-- continua texto livre (D-255 item 6).
--
-- O 046 esta reservado para outro card; a lacuna na numeracao e intencional
-- (o runner aplica por nome, em ordem, e nao exige sequencia continua).
-- =============================================================================

CREATE TABLE doctors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  crm VARCHAR(10),                       -- so digitos (normalizado no service); opcional
  crm_uf CHAR(2),                        -- UF do conselho, maiuscula; obrigatoria se ha CRM
  specialty VARCHAR(120),
  clinic VARCHAR(255),                   -- clinica/consultorio
  address VARCHAR(500),
  phone VARCHAR(30),                     -- telefone/WhatsApp, texto como digitado
  email VARCHAR(255),
  contact_name VARCHAR(255),             -- secretaria/contato
  visit_preference VARCHAR(255),         -- melhor dia e horario para visita (texto livre)
  notes TEXT,
  responsible_user_id UUID,              -- responsavel pela carteira (usuario do MESMO tenant)
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  -- SET NULL: apagar um usuario (raro; o normal e inativar) nao some com o medico.
  FOREIGN KEY (responsible_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CHECK (crm IS NULL OR crm ~ '^[0-9]{1,10}$'),
  CHECK (crm_uf IS NULL OR crm_uf ~ '^[A-Z]{2}$'),
  CHECK (crm IS NULL OR crm_uf IS NOT NULL)
);

-- CRM e opcional, mas quando preenchido e unico por (tenant, CRM, UF) —
-- inclusive contra medico INATIVO: reativar e o caminho, nao recadastrar.
CREATE UNIQUE INDEX uq_doctors_tenant_crm
  ON doctors(tenant_id, crm, crm_uf)
  WHERE crm IS NOT NULL;

CREATE INDEX idx_doctors_tenant_id ON doctors(tenant_id);
-- Indices de FK (D-146): filtro "por responsavel" e o ON DELETE SET NULL.
CREATE INDEX idx_doctors_responsible_user_id ON doctors(responsible_user_id);
CREATE INDEX idx_doctors_created_by ON doctors(created_by);

CREATE TRIGGER trg_doctors_updated_at
  BEFORE UPDATE ON doctors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE doctors ENABLE ROW LEVEL SECURITY;
CREATE POLICY doctors_tenant_isolation ON doctors
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
