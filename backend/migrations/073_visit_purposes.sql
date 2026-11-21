-- =============================================================================
-- 073_visit_purposes.sql
-- CRMLAB-190 (D-330): finalidade da visita. SCHEMA.md §36a.
--
-- `visit_purposes`: cadastro por laboratorio (nome, CHAVE de cor da paleta
-- fixa, ativo, ordem). Toda visita passa a ter `purpose_id` obrigatorio.
--
-- Semente: as 5 finalidades padrao em TODO tenant — os que ja existem (aqui)
-- e os novos (trigger AFTER INSERT em `tenants`: onboarding do console, seeds
-- e factories de teste, sem cada caminho lembrar de chamar). Backfill: as
-- visitas existentes recebem a "Visita" do proprio tenant.
--
-- Arquivo UNICO (tabela + policy + backfill): o backfill roda como dono da
-- migracao, sem `app.tenant_id`, entao nao depende da policy.
-- Idempotente: rodar de novo nao duplica semente nem mexe em visita ja ligada.
-- Numero 073: 070/071 = CRMLAB-188 e 072 = CRMLAB-189 (mesmo epico, em paralelo).
-- =============================================================================

CREATE TABLE IF NOT EXISTS visit_purposes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(60) NOT NULL,
  -- CHAVE da paleta (--color-purpose-<chave>-*), nunca hex.
  color       VARCHAR(20) NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT visit_purposes_name_not_blank CHECK (length(trim(name)) > 0),
  CONSTRAINT visit_purposes_color_check
    CHECK (color IN ('azul', 'verde', 'agua', 'violeta', 'ambar', 'rosa', 'terracota', 'cinza')),
  CONSTRAINT visit_purposes_sort_order_check CHECK (sort_order >= 0)
);

-- Nome unico no laboratorio, sem diferenciar maiuscula.
CREATE UNIQUE INDEX IF NOT EXISTS uq_visit_purposes_tenant_name
  ON visit_purposes(tenant_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_visit_purposes_tenant_order
  ON visit_purposes(tenant_id, sort_order);
-- Indice de FK (D-146): o ON DELETE SET NULL.
CREATE INDEX IF NOT EXISTS idx_visit_purposes_created_by ON visit_purposes(created_by);

DROP TRIGGER IF EXISTS trg_visit_purposes_updated_at ON visit_purposes;
CREATE TRIGGER trg_visit_purposes_updated_at
  BEFORE UPDATE ON visit_purposes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON visit_purposes TO crm_app;

ALTER TABLE visit_purposes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS visit_purposes_tenant_isolation ON visit_purposes;
CREATE POLICY visit_purposes_tenant_isolation ON visit_purposes
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- As 5 finalidades padrao de um laboratorio (DEFAULT_VISIT_PURPOSES em
-- shared/types/visit-purpose.types.ts). Nome ja existente (qualquer caixa) fica.
CREATE OR REPLACE FUNCTION seed_visit_purposes(p_tenant_id UUID) RETURNS void AS $$
BEGIN
  INSERT INTO visit_purposes (tenant_id, name, color, sort_order)
  VALUES
    (p_tenant_id, 'Visita', 'azul', 0),
    (p_tenant_id, 'Solicitação de patrocínio', 'verde', 1),
    (p_tenant_id, 'Solicitação de material', 'agua', 2),
    (p_tenant_id, 'Acesso a exames', 'violeta', 3),
    (p_tenant_id, 'Compromisso interno', 'cinza', 4)
  ON CONFLICT (tenant_id, lower(name)) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_seed_visit_purposes() RETURNS trigger AS $$
BEGIN
  PERFORM seed_visit_purposes(NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tenants_seed_visit_purposes ON tenants;
CREATE TRIGGER trg_tenants_seed_visit_purposes
  AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION trg_seed_visit_purposes();

-- Tenants que ja existem.
SELECT seed_visit_purposes(id) FROM tenants;

-- A visita passa a ter finalidade obrigatoria. Sem ON DELETE: finalidade
-- nao se apaga, inativa (como o medico, D-255).
ALTER TABLE doctor_visits
  ADD COLUMN IF NOT EXISTS purpose_id UUID REFERENCES visit_purposes(id);

UPDATE doctor_visits v
   SET purpose_id = p.id
  FROM visit_purposes p
 WHERE v.purpose_id IS NULL
   AND p.tenant_id = v.tenant_id
   AND lower(p.name) = 'visita';

ALTER TABLE doctor_visits ALTER COLUMN purpose_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_doctor_visits_purpose_id ON doctor_visits(purpose_id);
