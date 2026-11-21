-- =============================================================================
-- 070_doctor_profile_expanded.sql
-- CRMLAB-188 (D-328): cadastro de medico ampliado + curva ABC. SCHEMA.md §51.
--
-- So DDL (a 071 faz os dados). Tudo aditivo: nenhuma coluna antiga muda ou sai
-- (regra das 3 migracoes, AGENTS.md). `doctors.specialty` e
-- `doctors.contact_name` continuam e passam a ser escritas em dobro pelo
-- service ate a migracao que as remover.
--
--  - `doctor_specialties`: lista de especialidades POR laboratorio (+ policy).
--  - `doctors`: especialidade por FK, aniversario, clinica, horario estruturado
--    (JSONB), parceria, endereco estruturado, secretaria e curva ABC.
--  - trigger de `updated_at` de `doctors` ignora as colunas da curva ABC.
--  - `proposals.doctor_id`: medico do cadastro (base da curva ABC).
-- =============================================================================

CREATE TABLE doctor_specialties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  normalized_name VARCHAR(120) NOT NULL,   -- sem acento/caixa/espaco repetido (normalizeLookupName)
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX uq_doctor_specialties_tenant_name
  ON doctor_specialties(tenant_id, normalized_name);

CREATE TRIGGER trg_doctor_specialties_updated_at
  BEFORE UPDATE ON doctor_specialties
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE doctor_specialties ENABLE ROW LEVEL SECURITY;
CREATE POLICY doctor_specialties_tenant_isolation ON doctor_specialties
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE doctors
  ADD COLUMN specialty_id UUID REFERENCES doctor_specialties(id) ON DELETE SET NULL,
  ADD COLUMN birth_day SMALLINT,
  ADD COLUMN birth_month SMALLINT,
  ADD COLUMN birth_year SMALLINT,
  ADD COLUMN accepts_private BOOLEAN,                    -- NULL = nao informado
  ADD COLUMN monthly_consultations INTEGER,
  ADD COLUMN monthly_private_consultations INTEGER,
  ADD COLUMN consultation_fee NUMERIC(10,2),
  ADD COLUMN visit_hours JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN is_partner BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN partner_since DATE,
  ADD COLUMN partnership_notes TEXT,
  ADD COLUMN address_zip CHAR(8),
  ADD COLUMN address_street VARCHAR(255),
  ADD COLUMN address_number VARCHAR(20),
  ADD COLUMN address_complement VARCHAR(120),
  ADD COLUMN address_district VARCHAR(120),
  ADD COLUMN address_city VARCHAR(120),
  ADD COLUMN address_state CHAR(2),
  ADD COLUMN secretary_name VARCHAR(255),
  ADD COLUMN secretary_birth_day SMALLINT,
  ADD COLUMN secretary_birth_month SMALLINT,
  ADD COLUMN secretary_birth_year SMALLINT,
  ADD COLUMN secretary_phone VARCHAR(30),
  ADD COLUMN secretary_notes TEXT,
  ADD COLUMN abc_class CHAR(1),
  ADD COLUMN abc_base_value NUMERIC(14,2),
  ADD COLUMN abc_calculated_at TIMESTAMPTZ,
  ADD CONSTRAINT ck_doctors_birthday CHECK (
    (birth_day IS NULL) = (birth_month IS NULL)
    AND (birth_year IS NULL OR birth_day IS NOT NULL)
    AND (birth_day IS NULL OR birth_day BETWEEN 1 AND 31)
    AND (birth_month IS NULL OR birth_month BETWEEN 1 AND 12)
  ),
  ADD CONSTRAINT ck_doctors_secretary_birthday CHECK (
    (secretary_birth_day IS NULL) = (secretary_birth_month IS NULL)
    AND (secretary_birth_year IS NULL OR secretary_birth_day IS NOT NULL)
    AND (secretary_birth_day IS NULL OR secretary_birth_day BETWEEN 1 AND 31)
    AND (secretary_birth_month IS NULL OR secretary_birth_month BETWEEN 1 AND 12)
  ),
  ADD CONSTRAINT ck_doctors_consultations CHECK (
    (monthly_consultations IS NULL OR monthly_consultations >= 0)
    AND (monthly_private_consultations IS NULL OR monthly_private_consultations >= 0)
    AND (monthly_consultations IS NULL OR monthly_private_consultations IS NULL
         OR monthly_private_consultations <= monthly_consultations)
  ),
  ADD CONSTRAINT ck_doctors_consultation_fee CHECK (consultation_fee IS NULL OR consultation_fee >= 0),
  ADD CONSTRAINT ck_doctors_visit_hours CHECK (jsonb_typeof(visit_hours) = 'array'),
  ADD CONSTRAINT ck_doctors_address_zip CHECK (address_zip IS NULL OR address_zip ~ '^[0-9]{8}$'),
  ADD CONSTRAINT ck_doctors_address_state CHECK (address_state IS NULL OR address_state ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT ck_doctors_abc_class CHECK (abc_class IS NULL OR abc_class IN ('A', 'B', 'C'));

-- Indices de FK (D-146) e dos filtros novos da lista.
CREATE INDEX idx_doctors_specialty_id ON doctors(specialty_id);
CREATE INDEX idx_doctors_tenant_abc_class ON doctors(tenant_id, abc_class);

-- O recalculo diario da curva ABC nao pode fazer todo medico parecer "editado
-- hoje": `updated_at` so anda quando muda alguma coluna FORA da curva ABC.
CREATE OR REPLACE FUNCTION doctors_set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF (to_jsonb(NEW) - 'abc_class' - 'abc_base_value' - 'abc_calculated_at' - 'updated_at')
       IS DISTINCT FROM
       (to_jsonb(OLD) - 'abc_class' - 'abc_base_value' - 'abc_calculated_at' - 'updated_at') THEN
      NEW.updated_at = now();
    END IF;
    -- Sem mudanca fora da curva: `updated_at` fica como veio no UPDATE (o
    -- valor antigo, a menos que o proprio comando o tenha escrito).
    RETURN NEW;
  END;
  $$;

DROP TRIGGER trg_doctors_updated_at ON doctors;
CREATE TRIGGER trg_doctors_updated_at
  BEFORE UPDATE ON doctors
  FOR EACH ROW EXECUTE FUNCTION doctors_set_updated_at();

-- Medico do cadastro na proposta. SET NULL: medico nao se apaga (inativa), mas
-- se um dia sumir a proposta fica, sem vinculo. Mesmo tenant: conferido no
-- service (e o RLS de `doctors` esconde o medico de outro laboratorio).
ALTER TABLE proposals
  ADD COLUMN doctor_id UUID REFERENCES doctors(id) ON DELETE SET NULL;

CREATE INDEX idx_proposals_doctor_id ON proposals(doctor_id);
-- Base da curva ABC: vendas por medico na janela.
CREATE INDEX idx_proposals_tenant_doctor_won
  ON proposals(tenant_id, doctor_id, closed_at)
  WHERE status = 'ganho' AND doctor_id IS NOT NULL;
